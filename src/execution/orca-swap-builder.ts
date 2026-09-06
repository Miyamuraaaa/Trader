import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { address } from '@solana/kit';
import { createNoopSigner } from '@solana/signers';
import {
  _TICK_ARRAY_SIZE,
  getSqrtPriceSlippageBounds,
  getTickArrayStartTickIndex,
  swapQuoteByInputToken,
} from '@orca-so/whirlpools-core';
import {
  DEFAULT_WHIRLPOOL_DEPLOYMENT,
  getSwapV2Instruction,
} from '@orca-so/whirlpools-client';
import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { CONFIG, MINTS } from '../config.js';
import {
  discoverOrcaPools,
  getFreshOrcaPoolSnapshots,
  quoteOrcaPoolFromSnapshot,
  type OrcaPoolSnapshot,
} from '../orca.js';
import type { PoolMetadata } from '../pool-registry.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  inspectAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from './account-preflight.js';
import { assertKitWeb3InstructionRoundTrip, kitInstructionToWeb3 } from './instruction-adapter.js';
import {
  analyzeTokenMint,
  assertIntermediateTokenExecutionPolicy,
  type TokenProgramAnalysis,
} from './token-analysis.js';
import type { TokenAccountPreflight } from './account-preflight.js';
import { getExecutionKitRpc } from './execution-connection.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const WHIRLPOOL_PROGRAM_ID = String(DEFAULT_WHIRLPOOL_DEPLOYMENT.programId);

const mintAnalysisCache = new Map<string, ReturnType<typeof analyzeTokenMint>>();

function analyzeMintCached(connection: Connection, mint: string): ReturnType<typeof analyzeTokenMint> {
  const cached = mintAnalysisCache.get(mint);
  if (cached) return cached;
  const pending = analyzeTokenMint(connection, mint).catch((error) => {
    mintAnalysisCache.delete(mint);
    throw error;
  });
  mintAnalysisCache.set(mint, pending);
  return pending;
}

function elapsed(start: number): number {
  return Number((performance.now() - start).toFixed(1));
}

function directionalTickArrays(snapshot: OrcaPoolSnapshot, aToB: boolean): [string, string, string] {
  const start = getTickArrayStartTickIndex(snapshot.whirlpool.tickCurrentIndex, snapshot.whirlpool.tickSpacing);
  const offset = snapshot.whirlpool.tickSpacing * _TICK_ARRAY_SIZE();
  const starts = aToB ? [start, start - offset, start - offset * 2] : [start, start + offset, start + offset * 2];
  const addresses = starts.map((value) => snapshot.tickArrayAddressesByStart.get(value));
  if (addresses.some((value) => !value)) throw new Error('Required Orca tick array address was not loaded');
  return addresses as [string, string, string];
}

function vaults(snapshot: OrcaPoolSnapshot, aToB: boolean): [string, string] {
  return aToB
    ? [String(snapshot.whirlpool.tokenVaultA), String(snapshot.whirlpool.tokenVaultB)]
    : [String(snapshot.whirlpool.tokenVaultB), String(snapshot.whirlpool.tokenVaultA)];
}

/**
 * Builds a single-pool Orca swap_v2 instruction for use as one leg of a
 * mixed-provider atomic cycle. Unlike the two_hop_swap_v2 used by the
 * Orca-only executor, this creates a standard single-swap that can be
 * composed with Jupiter or Raptor instructions in the same transaction.
 */
export interface OrcaSwapLeg {
  instruction: TransactionInstruction;
  pool: PoolMetadata;
  snapshot: OrcaPoolSnapshot;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  expectedOutput: bigint;
  minimumOutput: bigint;
  programId: string;
  instructionHash: string;
  inputAta: string;
  outputAta: string;
  quoteReceivedAt: number;
}

export interface OrcaSwapLegInput {
  connection: Connection;
  wallet: PublicKey;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  slippageBps: number;
  /** Cached analyses to avoid redundant RPC calls. */
  inputToken?: TokenProgramAnalysis;
  outputToken?: TokenProgramAnalysis;
  inputAta?: TokenAccountPreflight;
  outputAta?: TokenAccountPreflight;
  profiler?: ExecutionNetworkProfiler;
  /** Untrusted discovery hints; every address is matched to official metadata and fetched on-chain. */
  candidatePoolAddresses?: readonly string[];
  /** Fresh pool state may start loading before the preceding provider quote completes. */
  preparedState?: PreparedOrcaSwapState;
}

export interface PrepareOrcaSwapStateInput {
  inputMint: string;
  outputMint: string;
  profiler?: ExecutionNetworkProfiler;
  candidatePoolAddresses?: readonly string[];
}

export interface PreparedOrcaSwapState {
  inputMint: string;
  outputMint: string;
  pools: PoolMetadata[];
  snapshots: OrcaPoolSnapshot[];
}

/**
 * Starts only the independently verifiable Orca metadata/account reads. Quote
 * math still runs later with the exact preceding-leg output.
 */
export async function prepareOrcaSwapState(
  input: PrepareOrcaSwapStateInput,
): Promise<PreparedOrcaSwapState> {
  const hinted = new Set(input.candidatePoolAddresses ?? []);
  // Pool addresses in the handoff are untrusted identity hints, never state.
  // Fetching those exact accounts and verifying their on-chain mints below is
  // stronger and faster than waiting for Orca's HTTP index after detection.
  const pools: PoolMetadata[] = hinted.size > 0
    ? [...hinted].map((poolAddress) => ({
      venue: 'orca',
      address: poolAddress,
      tokenMintA: input.inputMint,
      tokenMintB: input.outputMint,
      poolType: 'whirlpool',
    }))
    : input.profiler
      ? await input.profiler.measure('http.orca.poolDiscovery', 'http', () =>
        discoverOrcaPools(input.inputMint, input.outputMint))
      : await discoverOrcaPools(input.inputMint, input.outputMint);
  if (pools.length === 0) throw new Error('No Orca Whirlpool found for the swap leg pair');
  const snapshots = await getFreshOrcaPoolSnapshots(
    pools, getExecutionKitRpc(), input.profiler, input.inputMint,
  );
  for (const snapshot of snapshots) {
    const mints = new Set([
      String(snapshot.whirlpool.tokenMintA),
      String(snapshot.whirlpool.tokenMintB),
    ]);
    if (!mints.has(input.inputMint) || !mints.has(input.outputMint)) {
      throw new Error('Scanner Orca pool hint does not match independently decoded on-chain mints');
    }
  }
  return { inputMint: input.inputMint, outputMint: input.outputMint, pools, snapshots };
}

/**
 * Constructs a single-pool Orca swap_v2 instruction. The caller composes it
 * with the other leg's instructions to form a complete atomic cycle.
 *
 * The function independently discovers pools, fetches fresh on-chain state,
 * generates a quote, and builds the reviewed instruction. It never reuses
 * scanner-produced quotes or instructions.
 */
export async function buildOrcaSwapLeg(input: OrcaSwapLegInput): Promise<OrcaSwapLeg> {
  if (input.inputAmount <= 0n) throw new Error('Orca swap leg input must be positive');
  if (input.inputMint === input.outputMint) throw new Error('Orca swap leg mints must differ');

  const [inputToken, outputToken] = await Promise.all([
    input.inputToken ?? analyzeMintCached(input.connection, input.inputMint),
    input.outputToken ?? analyzeMintCached(input.connection, input.outputMint),
  ]);
  if (inputToken.status !== 'SUPPORTED' || !inputToken.programId
    || inputToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error(`Orca swap input mint ${input.inputMint} is not a supported classic SPL token`);
  }
  if (outputToken.status !== 'SUPPORTED' || !outputToken.programId
    || outputToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error(`Orca swap output mint ${input.outputMint} is not a supported classic SPL token`);
  }

  const [inputAta, outputAta] = await Promise.all([
    input.inputAta ?? inspectAssociatedTokenAccount(
      input.connection, input.wallet, new PublicKey(input.inputMint), TOKEN_PROGRAM_ID,
    ),
    input.outputAta ?? inspectAssociatedTokenAccount(
      input.connection, input.wallet, new PublicKey(input.outputMint), TOKEN_PROGRAM_ID,
    ),
  ]);

  const prepared = input.preparedState ?? await prepareOrcaSwapState(input);
  if (prepared.inputMint !== input.inputMint || prepared.outputMint !== input.outputMint) {
    throw new Error('Prepared Orca state does not match the exact swap leg mints');
  }
  const { pools, snapshots } = prepared;

  // Fetch fresh state and quote each pool. Select the best output.
  const candidates: Array<{
    pool: PoolMetadata;
    snapshot: OrcaPoolSnapshot;
    quote: ReturnType<typeof quoteOrcaPoolFromSnapshot>;
  }> = [];

  for (let index = 0; index < pools.length; index++) {
    const pool = pools[index]!;
    try {
      const snapshot = snapshots[index]!;
      const quote = quoteOrcaPoolFromSnapshot(pool, {
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        amountAtomic: input.inputAmount.toString(),
        slippageBps: input.slippageBps,
      }, snapshot);
      candidates.push({ pool, snapshot, quote });
    } catch {
      // Skip pools that fail to quote (e.g. insufficient liquidity).
    }
  }
  if (candidates.length === 0) throw new Error('No Orca pool could produce a quote for the swap leg');
  candidates.sort((a, b) => BigInt(b.quote.outAmount) > BigInt(a.quote.outAmount) ? 1 : -1);
  const best = candidates[0]!;

  // Build the swap_v2 instruction.
  const { snapshot, pool, quote } = best;
  const whirlpool = snapshot.whirlpool;
  const aToB = String(whirlpool.tokenMintA) === input.inputMint;
  const tickArrays = directionalTickArrays(snapshot, aToB);
  const [inputVault, outputVault] = vaults(snapshot, aToB);
  const bounds = getSqrtPriceSlippageBounds(whirlpool.sqrtPrice, input.slippageBps);
  const walletAddress = address(input.wallet.toBase58());

  const swap = getSwapV2Instruction({
    whirlpool: address(pool.address),
    tokenMintA: address(String(whirlpool.tokenMintA)),
    tokenMintB: address(String(whirlpool.tokenMintB)),
    tokenProgramA: address(TOKEN_PROGRAM_ID.toBase58()),
    tokenProgramB: address(TOKEN_PROGRAM_ID.toBase58()),
    tokenOwnerAccountA: aToB ? address(inputAta.ata) : address(outputAta.ata),
    tokenVaultA: address(String(whirlpool.tokenVaultA)),
    tokenOwnerAccountB: aToB ? address(outputAta.ata) : address(inputAta.ata),
    tokenVaultB: address(String(whirlpool.tokenVaultB)),
    tokenAuthority: createNoopSigner(walletAddress),
    tickArray0: address(tickArrays[0]),
    tickArray1: address(tickArrays[1]),
    tickArray2: address(tickArrays[2]),
    oracle: address(snapshot.oracleAddress),
    memoProgram: address(MEMO_PROGRAM_ID),
    amount: input.inputAmount,
    otherAmountThreshold: BigInt(quote.otherAmountThreshold),
    amountSpecifiedIsInput: true,
    aToB,
    sqrtPriceLimit: aToB ? bounds.minSqrtPrice : bounds.maxSqrtPrice,
    remainingAccountsInfo: null,
  }, { programAddress: DEFAULT_WHIRLPOOL_DEPLOYMENT.programId });

  assertKitWeb3InstructionRoundTrip(swap);
  const instruction = kitInstructionToWeb3(swap);
  const hash = createHash('sha256');
  hash.update(instruction.programId.toBuffer());
  for (const key of instruction.keys) hash.update(key.pubkey.toBuffer());
  hash.update(instruction.data);

  return {
    instruction,
    pool,
    snapshot,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inputAmount: input.inputAmount,
    expectedOutput: BigInt(quote.outAmount),
    minimumOutput: BigInt(quote.otherAmountThreshold),
    programId: WHIRLPOOL_PROGRAM_ID,
    instructionHash: hash.digest('hex'),
    inputAta: inputAta.ata,
    outputAta: outputAta.ata,
    quoteReceivedAt: snapshot.responseTimestamp,
  };
}

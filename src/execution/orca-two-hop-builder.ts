import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { address } from '@solana/kit';
import { createNoopSigner } from '@solana/signers';
import {
  _TICK_ARRAY_SIZE,
  getSqrtPriceSlippageBounds,
  getTickArrayStartTickIndex,
} from '@orca-so/whirlpools-core';
import {
  DEFAULT_WHIRLPOOL_DEPLOYMENT,
  getTwoHopSwapV2Instruction,
} from '@orca-so/whirlpools-client';
import { ComputeBudgetProgram, Connection, PublicKey } from '@solana/web3.js';
import { CONFIG, MINTS } from '../config.js';
import {
  discoverOrcaPools,
  getFreshOrcaPoolSnapshots,
  quoteOrcaPoolFromSnapshot,
  type OrcaPoolSnapshot,
} from '../orca.js';
import type { PoolMetadata } from '../pool-registry.js';
import { assertKitWeb3InstructionRoundTrip, kitInstructionToWeb3 } from './instruction-adapter.js';
import {
  assertIntermediateTokenExecutionPolicy,
  type TokenProgramAnalysis,
} from './token-analysis.js';
import type { AtomicExecutionPlan } from './types.js';
import { getCachedExecutionAta, getCachedExecutionMintAnalysis } from './execution-preflight-cache.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';
import { getExecutionKitRpc } from './execution-connection.js';
import { currentExecutionPriorityFee } from './priority-fee-oracle.js';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export interface OrcaTwoHopPreparationInput {
  connection: Connection;
  wallet: PublicKey;
  baseMint: string;
  intermediateMint: string;
  inputAmount: bigint;
  purpose: 'developer-validation' | 'validated-opportunity';
  /** Untrusted identities; on-chain Whirlpool state remains authoritative. */
  poolAddresses?: [string, string];
  profiler?: ExecutionNetworkProfiler;
}

/** Static, cache-safe work that must not consume the final quote's age budget. */
export interface OrcaTwoHopPreparation {
  input: OrcaTwoHopPreparationInput;
  pools: PoolMetadata[];
  baseToken: TokenProgramAnalysis;
  intermediateToken: TokenProgramAnalysis;
  baseAta: AtomicExecutionPlan['baseAta'];
  intermediateAta: AtomicExecutionPlan['intermediateAta'];
  routeDiscoveryMs: number;
  poolAccountFetchMs: number;
}

export interface OrcaTwoHopBuildTiming {
  routeDiscoveryMs: number;
  poolAccountFetchMs: number;
  freshPoolStateFetchMs: number;
  quoteGenerationMs: number;
  transactionConstructionMs: number;
  oldestPoolStateAt: number;
  newestPoolStateAt: number;
  quoteGeneratedAt: number;
  transactionConstructionStartedAt: number;
  quoteAgeAtTransactionConstructionMs: number;
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

function requireSupported(analysis: TokenProgramAnalysis): string {
  if (analysis.status !== 'SUPPORTED' || !analysis.programId) {
    throw new Error(`Mint ${analysis.mint} is not execution-supported: ${analysis.reasons.join('; ')}`);
  }
  return analysis.programId;
}

function selectPools(prepared: OrcaTwoHopPreparation, poolAddresses?: [string, string]): PoolMetadata[] {
  if (prepared.input.purpose === 'validated-opportunity' && !poolAddresses) {
    throw new Error('Validated-opportunity construction requires explicit pool addresses');
  }
  const pools = poolAddresses
    ? poolAddresses.map((poolAddress) => {
      const pool = prepared.pools.find((candidate) => candidate.address === poolAddress);
      if (!pool) throw new Error(`Validated pool is unavailable: ${poolAddress}`);
      return pool;
    })
    : prepared.pools;
  if (pools.length < 2 || new Set(pools.map((pool) => pool.address)).size !== pools.length) {
    throw new Error('Atomic Orca cycle requires two distinct Whirlpool pools');
  }
  return pools;
}

/**
 * Runs discovery and public account checks before the final state/quote phase.
 * Discovery metadata is cached by the registry; account data is only reused
 * within this one dry-run validation.
 */
export async function prepareOrcaTwoHopCycle(input: OrcaTwoHopPreparationInput): Promise<OrcaTwoHopPreparation> {
  if (input.baseMint === input.intermediateMint) throw new Error('Intermediate mint must differ from base mint');
  if (input.inputAmount <= 0n) throw new Error('Input amount must be positive');

  const discoveryStart = performance.now();
  const poolsPromise = (input.poolAddresses
    ? Promise.resolve(input.poolAddresses.map((poolAddress) => ({
      venue: 'orca' as const,
      address: poolAddress,
      tokenMintA: input.baseMint,
      tokenMintB: input.intermediateMint,
      poolType: 'whirlpool',
    })))
    : discoverOrcaPools(input.baseMint, input.intermediateMint))
    .then((pools) => ({ pools, routeDiscoveryMs: elapsed(discoveryStart) }));
  const accountStart = performance.now();
  const accountsPromise = (async () => {
    const [baseToken, intermediateToken] = await Promise.all([
      getCachedExecutionMintAnalysis(input.connection, input.baseMint, input.profiler),
      getCachedExecutionMintAnalysis(input.connection, input.intermediateMint, input.profiler),
    ]);
    const baseProgram = requireSupported(baseToken);
    const intermediateProgram = requireSupported(intermediateToken);
    assertIntermediateTokenExecutionPolicy(intermediateToken);
    const [baseAta, intermediateAta, solBalance] = await Promise.all([
      getCachedExecutionAta(input.connection, input.wallet, input.baseMint, input.profiler),
      getCachedExecutionAta(input.connection, input.wallet, input.intermediateMint, input.profiler),
      input.profiler
        ? input.profiler.measure('rpc.wallet.getBalance', 'rpc', () => input.connection.getBalance(input.wallet, 'confirmed'))
        : input.connection.getBalance(input.wallet, 'confirmed'),
    ]);
    if (!baseAta.exists) throw new Error(`Missing base-token ATA; estimated rent ${baseAta.creationRentLamports} lamports`);
    if (baseAta.balance < input.inputAmount) throw new Error('Insufficient base-token balance');
    if (solBalance < Math.ceil(CONFIG.minSolFeeReserve * 1_000_000_000)) throw new Error('INSUFFICIENT SOL RESERVE');
    return { baseToken, intermediateToken, baseAta, intermediateAta, poolAccountFetchMs: elapsed(accountStart) };
  })();
  const [{ pools, routeDiscoveryMs }, accounts] = await Promise.all([poolsPromise, accountsPromise]);
  if (pools.length < 2) throw new Error('Atomic Orca cycle requires two distinct Whirlpool pools');
  return { input, pools, routeDiscoveryMs, ...accounts };
}

export async function buildOrcaTwoHopCycle(input: OrcaTwoHopPreparationInput & {
  slippageBps: number;
  poolAddresses?: [string, string];
  computeUnitLimit?: number;
  prepared?: OrcaTwoHopPreparation;
  /** Bypasses dynamic pool-state cache; mandatory for a final execution quote. */
  freshPoolState?: boolean;
}): Promise<AtomicExecutionPlan> {
  const priorityFeeMicroLamports = currentExecutionPriorityFee().microLamportsPerCu;
  const prepared = input.prepared ?? await prepareOrcaTwoHopCycle(input);
  const pools = selectPools(prepared, input.poolAddresses);

  // The selected snapshots provide the exact Whirlpool, tick-array, and oracle
  // state used for both exact-in quotes and the final two_hop_swap_v2.
  const stateStart = performance.now();
  // Execution discovery also uses bounded multi-account reads. Fetching each
  // pool independently creates several concurrent RPC calls per Whirlpool and
  // routinely trips public-mainnet limits before the critical quote window.
  const snapshots = await getFreshOrcaPoolSnapshots(
    pools, getExecutionKitRpc(), input.profiler,
  );
  const snapshotSlots = snapshots
    .map((snapshot) => snapshot.slot)
    .filter((slot): slot is number => slot !== undefined);
  // Subscribed state carries its observed slot. The RPC-only validator uses a
  // single slot label instead of two redundant getSlot calls around the same
  // batched fetch; the transaction simulation remains the final state proof.
  const fallbackSlot = snapshotSlots.length === 0 && input.freshPoolState
    ? input.profiler
      ? await input.profiler.measure('rpc.getSlot.orcaEvidence', 'rpc', () => input.connection.getSlot('confirmed'))
      : await input.connection.getSlot('confirmed')
    : undefined;
  const oldestPoolStateSlot = snapshotSlots.length > 0
    ? Math.min(...snapshotSlots)
    : fallbackSlot;
  const newestPoolStateSlot = snapshotSlots.length > 0
    ? Math.max(...snapshotSlots)
    : fallbackSlot;
  if (oldestPoolStateSlot !== undefined && newestPoolStateSlot !== undefined
    && newestPoolStateSlot - oldestPoolStateSlot > CONFIG.maxSlotDifference) {
    throw new Error(`Selected Orca pool state spans too many slots (${oldestPoolStateSlot} -> ${newestPoolStateSlot})`);
  }
  const freshPoolStateFetchMs = elapsed(stateStart);
  const snapshotByPool = new Map(pools.map((pool, index) => [pool.address, snapshots[index]!])) as Map<string, OrcaPoolSnapshot>;

  const quoteStart = performance.now();
  const candidates: Array<{
    first: PoolMetadata;
    second: PoolMetadata;
    firstQuote: ReturnType<typeof quoteOrcaPoolFromSnapshot>;
    secondQuote: ReturnType<typeof quoteOrcaPoolFromSnapshot>;
  }> = [];
  for (const first of pools) {
    const firstQuote = quoteOrcaPoolFromSnapshot(first, {
      inputMint: input.baseMint,
      outputMint: input.intermediateMint,
      amountAtomic: input.inputAmount.toString(),
      slippageBps: input.slippageBps,
    }, snapshotByPool.get(first.address)!);
    for (const second of pools) {
      if (second.address === first.address) continue;
      const secondQuote = quoteOrcaPoolFromSnapshot(second, {
        inputMint: input.intermediateMint,
        outputMint: input.baseMint,
        amountAtomic: firstQuote.outAmount,
        slippageBps: input.slippageBps,
      }, snapshotByPool.get(second.address)!);
      candidates.push({ first, second, firstQuote, secondQuote });
    }
  }
  candidates.sort((a, b) => BigInt(a.secondQuote.outAmount) > BigInt(b.secondQuote.outAmount) ? -1 : 1);
  const best = candidates[0];
  if (!best) throw new Error('No two-pool Orca cycle could be quoted');
  const quoteGeneratedAt = Date.now();
  const quoteGenerationMs = elapsed(quoteStart);

  const one = snapshotByPool.get(best.first.address)!;
  const two = snapshotByPool.get(best.second.address)!;
  for (const [name, snapshot] of [['first', one], ['second', two]] as const) {
    const mints = [String(snapshot.whirlpool.tokenMintA), String(snapshot.whirlpool.tokenMintB)];
    if (!mints.includes(input.baseMint) || !mints.includes(input.intermediateMint)) {
      throw new Error(`Selected ${name} Whirlpool does not contain the exact two-hop mint pair`);
    }
  }

  // The oldest of the two exact state reads is the conservative quote age.
  const quoteReceivedAt = Math.min(one.responseTimestamp, two.responseTimestamp);
  const transactionConstructionStartedAt = Date.now();
  const constructionStart = performance.now();
  const aToBOne = String(one.whirlpool.tokenMintA) === input.baseMint;
  const aToBTwo = String(two.whirlpool.tokenMintA) === input.intermediateMint;
  const tickOne = directionalTickArrays(one, aToBOne);
  const tickTwo = directionalTickArrays(two, aToBTwo);
  const vaultOne = vaults(one, aToBOne);
  const vaultTwo = vaults(two, aToBTwo);
  const boundsOne = getSqrtPriceSlippageBounds(one.whirlpool.sqrtPrice, input.slippageBps);
  const boundsTwo = getSqrtPriceSlippageBounds(two.whirlpool.sqrtPrice, input.slippageBps);
  const walletAddress = address(input.wallet.toBase58());
  const baseProgram = requireSupported(prepared.baseToken);
  const intermediateProgram = requireSupported(prepared.intermediateToken);
  const swap = getTwoHopSwapV2Instruction({
    whirlpoolOne: address(best.first.address), whirlpoolTwo: address(best.second.address),
    tokenMintInput: address(input.baseMint), tokenMintIntermediate: address(input.intermediateMint), tokenMintOutput: address(input.baseMint),
    tokenProgramInput: address(baseProgram), tokenProgramIntermediate: address(intermediateProgram), tokenProgramOutput: address(baseProgram),
    tokenOwnerAccountInput: address(prepared.baseAta.ata),
    tokenVaultOneInput: address(vaultOne[0]), tokenVaultOneIntermediate: address(vaultOne[1]),
    tokenVaultTwoIntermediate: address(vaultTwo[0]), tokenVaultTwoOutput: address(vaultTwo[1]),
    tokenOwnerAccountOutput: address(prepared.baseAta.ata), tokenAuthority: createNoopSigner(walletAddress),
    tickArrayOne0: address(tickOne[0]), tickArrayOne1: address(tickOne[1]), tickArrayOne2: address(tickOne[2]),
    tickArrayTwo0: address(tickTwo[0]), tickArrayTwo1: address(tickTwo[1]), tickArrayTwo2: address(tickTwo[2]),
    oracleOne: address(one.oracleAddress), oracleTwo: address(two.oracleAddress), memoProgram: address(MEMO_PROGRAM_ID),
    amount: input.inputAmount, otherAmountThreshold: BigInt(best.secondQuote.otherAmountThreshold), amountSpecifiedIsInput: true,
    aToBOne, aToBTwo,
    sqrtPriceLimitOne: aToBOne ? boundsOne.minSqrtPrice : boundsOne.maxSqrtPrice,
    sqrtPriceLimitTwo: aToBTwo ? boundsTwo.minSqrtPrice : boundsTwo.maxSqrtPrice,
    remainingAccountsInfo: null,
  }, { programAddress: DEFAULT_WHIRLPOOL_DEPLOYMENT.programId });
  assertKitWeb3InstructionRoundTrip(swap);
  const transactionConstructionMs = elapsed(constructionStart);
  const identity = [
    'ORCA_TWO_HOP_CYCLE', input.baseMint, input.intermediateMint,
    best.first.address, best.second.address, input.inputAmount.toString(),
    best.firstQuote.id, best.secondQuote.id,
  ].join(':');
  return {
    id: crypto.createHash('sha256').update(identity).digest('hex'),
    type: 'ORCA_TWO_HOP_CYCLE', atomic: true, wallet: input.wallet.toBase58(),
    inputMint: input.baseMint, intermediateMint: input.intermediateMint, outputMint: input.baseMint,
    inputAmount: input.inputAmount,
    expectedIntermediateAmount: BigInt(best.firstQuote.outAmount), expectedOutputAmount: BigInt(best.secondQuote.outAmount),
    minimumOutputAmount: BigInt(best.secondQuote.otherAmountThreshold), pools: [best.first.address, best.second.address], quoteReceivedAt,
    baseToken: prepared.baseToken, intermediateToken: prepared.intermediateToken,
    baseAta: prepared.baseAta, intermediateAta: prepared.intermediateAta,
    computeUnitLimit: input.computeUnitLimit,
    computeUnitPriceMicroLamports: priorityFeeMicroLamports,
    executionTiming: {
      routeDiscoveryMs: prepared.routeDiscoveryMs,
      poolAccountFetchMs: prepared.poolAccountFetchMs,
      freshPoolStateFetchMs,
      quoteGenerationMs,
      transactionConstructionMs,
      oldestPoolStateAt: quoteReceivedAt,
      newestPoolStateAt: Math.max(one.responseTimestamp, two.responseTimestamp),
      oldestPoolStateSlot,
      newestPoolStateSlot,
      quoteGeneratedAt,
      transactionConstructionStartedAt,
      quoteAgeAtTransactionConstructionMs: transactionConstructionStartedAt - quoteReceivedAt,
      networkRequests: input.profiler?.timings,
    },
    instructions: [
      ...(input.computeUnitLimit === undefined ? [] : [
        ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
      ]),
      kitInstructionToWeb3(swap),
    ],
  };
}

/**
 * Provider-neutral cycle builder. Builds an atomic USDC → intermediate → USDC
 * cycle for any two-provider combination using the individual swap leg builders.
 *
 * For providers with existing dedicated builders (Jupiter, Raptor, Orca), the
 * mixed-cycle-builder functions remain authoritative for those combinations.
 * QUARANTINED PROTOTYPE — NOT REACHABLE FROM THE LIVE EXECUTOR. The Raydium
 * and Meteora legs below do not yet meet the live instruction-decoder policy.
 */
import { createHash } from 'node:crypto';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { CONFIG, MINTS } from '../config.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  inspectAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from './account-preflight.js';
import { analyzeTokenMint, assertIntermediateTokenExecutionPolicy } from './token-analysis.js';
import { buildOrcaSwapLeg } from './orca-swap-builder.js';
import { buildRaydiumSwapLeg } from './raydium-swap-builder.js';
import { buildMeteoraSwapLeg } from './meteora-swap-builder.js';
import type { AtomicExecutionPlan, ExecutionRouteType, AggregatorExecutionProvider } from './types.js';
import type { MixedCycleInput } from './mixed-cycle-builder.js';

const LOOKUP_TABLE_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111');
const lookupTableCache = new Map<string, AddressLookupTableAccount>();
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

function instructionHash(instruction: TransactionInstruction): string {
  const hash = createHash('sha256');
  hash.update(instruction.programId.toBuffer());
  for (const key of instruction.keys) hash.update(key.pubkey.toBuffer());
  hash.update(instruction.data);
  return hash.digest('hex');
}

async function loadLookupTables(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  const unique = [...new Set(addresses)];
  const missing = unique.filter((addr) => !lookupTableCache.has(addr));
  if (missing.length > 0) {
    const infos = await connection.getMultipleAccountsInfo(
      missing.map((addr) => new PublicKey(addr)), 'confirmed',
    );
    missing.forEach((addr, index) => {
      const info = infos[index];
      if (!info || !info.owner.equals(LOOKUP_TABLE_PROGRAM_ID)) {
        throw new Error(`Address lookup table ${addr} is unavailable or has an unexpected owner`);
      }
      lookupTableCache.set(addr, new AddressLookupTableAccount({
        key: new PublicKey(addr), state: AddressLookupTableAccount.deserialize(info.data),
      }));
    });
  }
  return unique.map((addr) => {
    const table = lookupTableCache.get(addr);
    if (!table) throw new Error(`Address lookup table ${addr} was not loaded`);
    return table;
  });
}

interface SwapLegResult {
  instructions: TransactionInstruction[];
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  expectedOutput: bigint;
  minimumOutput: bigint;
  quoteReceivedAt: number;
  pool: string;
  addressLookupTableAddresses: string[];
}

/**
 * Build a single swap leg for a given provider.
 * Returns instructions + quote data in a provider-neutral format.
 */
async function buildSwapLeg(
  provider: AggregatorExecutionProvider,
  connection: Connection,
  wallet: PublicKey,
  inputMint: string,
  outputMint: string,
  inputAmount: bigint,
  slippageBps: number,
): Promise<SwapLegResult> {
  switch (provider) {
    case 'orca': {
      const leg = await buildOrcaSwapLeg({
        connection, wallet, inputMint, outputMint, inputAmount, slippageBps,
      });
      return {
        instructions: [leg.instruction],
        inputMint, outputMint, inputAmount,
        expectedOutput: leg.expectedOutput,
        minimumOutput: leg.minimumOutput,
        quoteReceivedAt: leg.quoteReceivedAt,
        pool: leg.pool.address,
        addressLookupTableAddresses: [],
      };
    }
    case 'raydium': {
      const leg = await buildRaydiumSwapLeg({
        connection, wallet, inputMint, outputMint, inputAmount, slippageBps,
      });
      return {
        instructions: leg.instructions,
        inputMint, outputMint, inputAmount,
        expectedOutput: leg.expectedOutput,
        minimumOutput: leg.minimumOutput,
        quoteReceivedAt: leg.quoteReceivedAt,
        pool: leg.pool,
        addressLookupTableAddresses: leg.addressLookupTableAddresses,
      };
    }
    case 'meteora': {
      const leg = await buildMeteoraSwapLeg({
        connection, wallet, inputMint, outputMint, inputAmount, slippageBps,
      });
      return {
        instructions: leg.instructions,
        inputMint, outputMint, inputAmount,
        expectedOutput: leg.expectedOutput,
        minimumOutput: leg.minimumOutput,
        quoteReceivedAt: leg.quoteReceivedAt,
        pool: leg.pool,
        addressLookupTableAddresses: [],
      };
    }
    default:
      throw new Error(`Provider "${provider}" is not supported as a direct swap-leg builder; use the dedicated mixed-cycle-builder`);
  }
}

function routeType(buy: AggregatorExecutionProvider, sell: AggregatorExecutionProvider): ExecutionRouteType {
  return `${buy.toUpperCase()}_${sell.toUpperCase()}_CYCLE` as ExecutionRouteType;
}

/**
 * Builds an atomic two-provider cycle for any combination where at least one
 * leg is Raydium, Meteora, or Orca. Both legs use direct swap-leg builders
 * (no aggregator API instruction fetch for Jupiter/Raptor in this path).
 */
export async function buildGenericMixedCycle(
  buyProvider: AggregatorExecutionProvider,
  sellProvider: AggregatorExecutionProvider,
  input: MixedCycleInput,
): Promise<AtomicExecutionPlan> {
  if (input.inputAmount <= 0n) throw new Error('Generic cycle input must be positive');
  const intermediateMint = input.intermediateMint ?? MINTS.SOL;
  if (intermediateMint === MINTS.USDC) throw new Error('Generic cycle intermediate must differ from USDC');

  // Parallel: token analysis + ATA inspection + buy leg build
  const [baseToken, intermediateToken, baseAta, intermediateAta] = input.preflight
    ? [input.preflight.baseToken, input.preflight.intermediateToken,
       input.preflight.baseAta, input.preflight.intermediateAta]
    : await Promise.all([
        analyzeMintCached(input.connection, MINTS.USDC),
        analyzeMintCached(input.connection, intermediateMint),
        inspectAssociatedTokenAccount(input.connection, input.wallet, new PublicKey(MINTS.USDC), TOKEN_PROGRAM_ID),
        inspectAssociatedTokenAccount(input.connection, input.wallet, new PublicKey(intermediateMint), TOKEN_PROGRAM_ID),
      ]);

  assertIntermediateTokenExecutionPolicy(intermediateToken);
  if (baseAta.balance < input.inputAmount) {
    throw new Error(`Insufficient USDC balance: have ${baseAta.balance}, need ${input.inputAmount}`);
  }

  // Build buy leg: USDC → intermediate
  const buyLeg = await buildSwapLeg(
    buyProvider, input.connection, input.wallet,
    MINTS.USDC, intermediateMint, input.inputAmount, input.slippageBps,
  );

  // Build sell leg: intermediate → USDC
  // Use the buy leg's minimum output as the sell input (conservative chaining)
  const sellLeg = await buildSwapLeg(
    sellProvider, input.connection, input.wallet,
    intermediateMint, MINTS.USDC, buyLeg.minimumOutput, input.slippageBps,
  );

  // Ensure intermediate ATA exists (idempotent create)
  const ataSetup: TransactionInstruction[] = [];
  if (!intermediateAta.exists) {
    ataSetup.push(new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: input.wallet, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(intermediateAta.ata), isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(intermediateMint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // CreateIdempotent
    }));
  }

  // Compose atomic transaction
  const allSwapInstructions = [...ataSetup, ...buyLeg.instructions, ...sellLeg.instructions];
  const deduped = uniqueInstructions(allSwapInstructions);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit ?? 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.fallbackPriorityFeeMicroLamports }),
    ...deduped,
  ];

  // Load ALTs
  const altAddresses = [
    ...buyLeg.addressLookupTableAddresses,
    ...sellLeg.addressLookupTableAddresses,
  ];
  const lookupTableAccounts = altAddresses.length > 0
    ? await loadLookupTables(input.connection, altAddresses)
    : [];

  const now = Date.now();
  const currentSlot = await input.connection.getSlot('confirmed');
  const sourceInstructionHashes = deduped.map(instructionHash);

  return {
    id: `${buyProvider}-${sellProvider}-${now}-${input.inputAmount}`,
    type: routeType(buyProvider, sellProvider),
    atomic: true,
    wallet: input.wallet.toBase58(),
    inputMint: MINTS.USDC,
    intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: input.inputAmount,
    expectedIntermediateAmount: buyLeg.expectedOutput,
    expectedOutputAmount: sellLeg.expectedOutput,
    minimumOutputAmount: sellLeg.minimumOutput,
    pools: [buyLeg.pool, sellLeg.pool],
    quoteReceivedAt: Math.min(buyLeg.quoteReceivedAt, sellLeg.quoteReceivedAt),
    executionTiming: {
      routeDiscoveryMs: 0, poolAccountFetchMs: 0, freshPoolStateFetchMs: 0,
      quoteGenerationMs: 0, transactionConstructionMs: 0,
      oldestPoolStateAt: Math.min(buyLeg.quoteReceivedAt, sellLeg.quoteReceivedAt),
      newestPoolStateAt: now,
      oldestPoolStateSlot: currentSlot, newestPoolStateSlot: currentSlot,
      quoteGeneratedAt: now, transactionConstructionStartedAt: now,
      quoteAgeAtTransactionConstructionMs: 0,
    },
    baseToken, intermediateToken, baseAta, intermediateAta,
    computeUnitLimit: input.computeUnitLimit ?? 500_000,
    instructions,
    lookupTableAccounts,
    aggregatorEvidence: {
      providers: [buyProvider, sellProvider],
      routeProgramIds: [],
      sourceInstructionHashes,
      closesIntermediateAta: false,
      legs: [{
        provider: buyProvider, programId: buyLeg.instructions.find((ix) =>
          !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))?.programId.toBase58() ?? '',
        inputMint: MINTS.USDC, outputMint: intermediateMint, inputAmount: input.inputAmount,
        expectedOutputAmount: buyLeg.expectedOutput, minimumOutputAmount: buyLeg.minimumOutput,
        pool: buyLeg.pool,
      }, {
        provider: sellProvider, programId: sellLeg.instructions.find((ix) =>
          !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))?.programId.toBase58() ?? '',
        inputMint: intermediateMint, outputMint: MINTS.USDC, inputAmount: buyLeg.minimumOutput,
        expectedOutputAmount: sellLeg.expectedOutput, minimumOutputAmount: sellLeg.minimumOutput,
        pool: sellLeg.pool,
      }],
    },
  };
}

function uniqueInstructions(instructions: TransactionInstruction[]): TransactionInstruction[] {
  const seen = new Set<string>();
  return instructions.filter((instruction) => {
    const fp = instructionHash(instruction);
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
}

/**
 * Factory: creates a MixedCycleInput → AtomicExecutionPlan builder for a
 * specific provider pair. Used to register in the aggregator-handoff-validator.
 */
export function createGenericCycleBuilder(
  buyProvider: AggregatorExecutionProvider,
  sellProvider: AggregatorExecutionProvider,
): (input: MixedCycleInput) => Promise<AtomicExecutionPlan> {
  return (input: MixedCycleInput) => buildGenericMixedCycle(buyProvider, sellProvider, input);
}

import { createHash } from 'node:crypto';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { z } from 'zod';
import { CONFIG, MINTS } from '../config.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './account-preflight.js';
import { assertIntermediateTokenExecutionPolicy } from './token-analysis.js';
import {
  buildOrcaSwapLeg, prepareOrcaSwapState, type OrcaSwapLeg,
} from './orca-swap-builder.js';
import type { AtomicExecutionPlan, ExecutionRouteType } from './types.js';
import { getCachedExecutionAta, getCachedExecutionMintAnalysis } from './execution-preflight-cache.js';
import { ExecutionNetworkProfiler } from './network-profiler.js';
import { currentExecutionPriorityFee } from './priority-fee-oracle.js';
import {
  EXECUTION_AGGREGATOR_MAX_HOPS,
  EXECUTION_JUPITER_DEXES,
  EXECUTION_RAPTOR_DEXES,
} from './executable-route-policy.js';

// Re-export for shared use by validators.
export { RAPTOR_PROGRAM_ID, JUPITER_V6_PROGRAM_ID } from './aggregator-cycle-builder.js';
import { RAPTOR_PROGRAM_ID, JUPITER_V6_PROGRAM_ID } from './aggregator-cycle-builder.js';

const LOOKUP_TABLE_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111');
const lookupTableCache = new Map<string, AddressLookupTableAccount>();
const executableAccountCache = new Map<string, boolean>();

export function seedMixedExecutableAccountCache(entries: ReadonlyMap<string, boolean>): void {
  for (const [address, executable] of entries) executableAccountCache.set(address, executable);
}

const ApiAccountSchema = z.object({
  pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean(),
}).strict();
const ApiInstructionSchema = z.object({
  programId: z.string(), accounts: z.array(ApiAccountSchema), data: z.string(),
}).strict();
const NullableInstruction = ApiInstructionSchema.nullish();

const RaptorQuoteSchema = z.object({
  inputMint: z.string(), outputMint: z.string(), amountIn: z.string(), amountOut: z.string(),
  minAmountOut: z.string(), feeAmount: z.string().optional(), priceImpact: z.number(),
  slippageBps: z.number(), contextSlot: z.number().optional(),
  routePlan: z.array(z.object({
    programId: z.string().optional(), pool: z.string().optional(), inputMint: z.string().optional(),
    outputMint: z.string().optional(), amountIn: z.string().optional(), amountOut: z.string().optional(),
  }).passthrough()).default([]),
}).passthrough();

const InstructionBundleSchema = z.object({
  tokenLedgerInstruction: NullableInstruction,
  computeBudgetInstructions: z.array(ApiInstructionSchema).default([]),
  setupInstructions: z.array(ApiInstructionSchema).default([]),
  swapInstruction: ApiInstructionSchema,
  cleanupInstruction: NullableInstruction,
  addressLookupTableAddresses: z.array(z.string()).default([]),
}).passthrough();

const JupiterBuildSchema = z.object({
  inputMint: z.string(), outputMint: z.string(), inAmount: z.string(), outAmount: z.string(),
  otherAmountThreshold: z.string(), swapMode: z.literal('ExactIn'), slippageBps: z.number(),
  routePlan: z.array(z.object({
    swapInfo: z.object({ ammKey: z.string().optional(), inputMint: z.string(), outputMint: z.string() }).passthrough(),
  }).passthrough()).default([]),
  computeBudgetInstructions: z.array(ApiInstructionSchema).default([]),
  setupInstructions: z.array(ApiInstructionSchema).default([]),
  swapInstruction: ApiInstructionSchema,
  cleanupInstruction: NullableInstruction,
  otherInstructions: z.array(ApiInstructionSchema).default([]),
  tipInstruction: NullableInstruction,
  addressesByLookupTableAddress: z.record(z.array(z.string())).default({}),
}).passthrough();

type ApiInstruction = z.infer<typeof ApiInstructionSchema>;

function assertAtomic(value: string, label: string): void {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${label} is not an unsigned atomic amount`);
}

async function responseJson(
  url: string | URL, init: RequestInit, label: string, profiler?: ExecutionNetworkProfiler,
): Promise<unknown> {
  const request = async () => {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        ...init, signal: AbortSignal.timeout(CONFIG.executionProviderTimeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text) as unknown; } catch { throw new Error(`${label} returned invalid JSON`); }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} failed after ${Date.now() - startedAt}ms: ${reason}`);
    }
  };
  return profiler ? profiler.measure(`http.${label}`, 'http', request) : request();
}

function toInstruction(value: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(value.programId),
    keys: value.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey), isSigner: account.isSigner, isWritable: account.isWritable,
    })),
    data: Buffer.from(value.data, 'base64'),
  });
}

function instructionHash(instruction: TransactionInstruction): string {
  const hash = createHash('sha256');
  hash.update(instruction.programId.toBuffer());
  for (const key of instruction.keys) hash.update(key.pubkey.toBuffer());
  hash.update(instruction.data);
  return hash.digest('hex');
}

function uniqueInstructions(instructions: TransactionInstruction[]): TransactionInstruction[] {
  const seen = new Set<string>();
  return instructions.filter((instruction) => {
    const fingerprint = instructionHash(instruction);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

async function loadLookupTables(
  connection: Connection,
  addresses: string[],
  jupiterAddressEvidence: Record<string, string[]>,
  profiler?: ExecutionNetworkProfiler,
): Promise<AddressLookupTableAccount[]> {
  const unique = [...new Set(addresses)];
  const missing = unique.filter((addr) => {
    const cached = lookupTableCache.get(addr);
    const evidence = jupiterAddressEvidence[addr];
    return !cached || Boolean(evidence && cached.state.addresses.length !== evidence.length);
  });
  if (missing.length > 0) {
    const load = () => connection.getMultipleAccountsInfo(
      missing.map((addr) => new PublicKey(addr)), 'confirmed');
    const infos = profiler
      ? await profiler.measure('rpc.alt.getMultipleAccountsInfo', 'rpc', load)
      : await load();
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
    const evidence = jupiterAddressEvidence[addr];
    if (evidence) {
      const actual = table.state.addresses.map((item) => item.toBase58());
      if (actual.length !== evidence.length || actual.some((item, index) => item !== evidence[index])) {
        throw new Error(`Jupiter ALT evidence does not match on-chain table ${addr}`);
      }
    }
    return table;
  });
}

async function executableRoutePrograms(
  connection: Connection,
  instructions: TransactionInstruction[],
  profiler?: ExecutionNetworkProfiler,
): Promise<string[]> {
  const topLevel = new Set(instructions.map((i) => i.programId.toBase58()));
  const accountAddresses = [...new Set(instructions.flatMap((i) =>
    i.keys.map((key) => key.pubkey.toBase58())))];
  const missing = accountAddresses.filter((addr) => !executableAccountCache.has(addr));
  if (missing.length > 0) {
    const load = () => connection.getMultipleAccountsInfo(
      missing.map((addr) => new PublicKey(addr)), 'confirmed');
    const infos = profiler
      ? await profiler.measure('rpc.programAccounts.getMultipleAccountsInfo', 'rpc', load)
      : await load();
    missing.forEach((addr, index) => executableAccountCache.set(addr, infos[index]?.executable === true));
  }
  return accountAddresses.filter((addr) => executableAccountCache.get(addr) && !topLevel.has(addr)
    && addr !== TOKEN_PROGRAM_ID.toBase58()
    && addr !== 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
    && addr !== '11111111111111111111111111111111');
}

export interface MixedCycleInput {
  connection: Connection;
  wallet: PublicKey;
  inputAmount: bigint;
  slippageBps: number;
  intermediateMint?: string;
  computeUnitLimit?: number;
  preflight?: Pick<AtomicExecutionPlan, 'baseToken' | 'intermediateToken' | 'baseAta' | 'intermediateAta'>;
  profiler?: ExecutionNetworkProfiler;
  orcaPoolHints?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Jupiter -> Orca cycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constructs an atomic Jupiter -> Orca cycle: USDC -> intermediate via Jupiter,
 * then intermediate -> USDC via a single Orca Whirlpool swap_v2.
 *
 * Jupiter's enforceable `otherAmountThreshold` is used as the Orca leg input.
 * Any first-leg surplus remains intermediate dust.
 */
export async function buildJupiterOrcaCycle(input: MixedCycleInput): Promise<AtomicExecutionPlan> {
  const priorityFeeMicroLamports = currentExecutionPriorityFee().microLamportsPerCu;
  if (input.inputAmount <= 0n) throw new Error('Mixed cycle input must be positive');
  const intermediateMint = input.intermediateMint ?? MINTS.SOL;
  const profiler = input.profiler ?? new ExecutionNetworkProfiler();
  if (intermediateMint === MINTS.USDC) throw new Error('Mixed cycle intermediate must differ from USDC');

  const preflightPromise = input.preflight
    ? Promise.resolve([
      input.preflight.baseToken, input.preflight.intermediateToken,
      input.preflight.baseAta, input.preflight.intermediateAta,
    ] as const)
    : Promise.all([
      getCachedExecutionMintAnalysis(input.connection, MINTS.USDC, profiler),
      getCachedExecutionMintAnalysis(input.connection, intermediateMint, profiler),
      getCachedExecutionAta(input.connection, input.wallet, MINTS.USDC, profiler),
      getCachedExecutionAta(input.connection, input.wallet, intermediateMint, profiler),
    ]);
  void preflightPromise.catch(() => undefined);
  const orcaStatePromise = prepareOrcaSwapState({
    inputMint: intermediateMint, outputMint: MINTS.USDC,
    profiler, candidatePoolAddresses: input.orcaPoolHints,
  }).then((value) => ({ value } as const), (error: unknown) => ({ error } as const));

  const amount = input.inputAmount.toString();

  // First leg: Jupiter USDC -> intermediate
  const jupiterUrl = new URL('https://api.jup.ag/swap/v2/build');
  for (const [key, value] of Object.entries({
    inputMint: MINTS.USDC,
    outputMint: intermediateMint,
    amount,
    taker: input.wallet.toBase58(),
    slippageBps: String(input.slippageBps),
    mode: 'fast',
    maxAccounts: '24',
    wrapAndUnwrapSol: 'false',
    dexes: EXECUTION_JUPITER_DEXES.join(','),
  })) jupiterUrl.searchParams.set(key, value);
  const jupiterHeaders: Record<string, string> = { accept: 'application/json' };
  if (CONFIG.jupiterApiKey) jupiterHeaders['x-api-key'] = CONFIG.jupiterApiKey;
  const jupiterBuild = JupiterBuildSchema.parse(await responseJson(jupiterUrl, {
    method: 'GET', headers: jupiterHeaders,
  }, 'Jupiter V2 instruction build', profiler));
  const firstLegMarketStateAt = Date.now();
  assertAtomic(jupiterBuild.inAmount, 'Jupiter inAmount');
  assertAtomic(jupiterBuild.outAmount, 'Jupiter outAmount');
  assertAtomic(jupiterBuild.otherAmountThreshold, 'Jupiter minimum output');
  if (jupiterBuild.inputMint !== MINTS.USDC || jupiterBuild.outputMint !== intermediateMint
    || jupiterBuild.inAmount !== amount || BigInt(jupiterBuild.outAmount) <= 0n) {
    throw new Error('Jupiter build does not match the requested first leg');
  }
  if (jupiterBuild.swapInstruction.programId !== JUPITER_V6_PROGRAM_ID.toBase58()) {
    throw new Error('Jupiter build returned an unexpected swap program');
  }
  if (jupiterBuild.tipInstruction) throw new Error('Jupiter build unexpectedly requested a tip instruction');
  if (jupiterBuild.cleanupInstruction) {
    throw new Error('Jupiter first-leg cleanup is not composable with the reviewed second leg');
  }

  // Second leg: Orca intermediate -> USDC using Jupiter's enforceable minimum
  const [baseToken, intermediateToken, baseAta, intermediateAta] = await preflightPromise;
  if (baseToken.status !== 'SUPPORTED' || intermediateToken.status !== 'SUPPORTED'
    || baseToken.programId !== TOKEN_PROGRAM_ID.toBase58()
    || intermediateToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error('Mixed cycle requires classic SPL base and intermediate mints');
  }
  assertIntermediateTokenExecutionPolicy(intermediateToken);
  if (!baseAta.exists || baseAta.balance < input.inputAmount) {
    throw new Error('Wallet has insufficient USDC for mixed cycle validation');
  }

  const orcaStateResult = await orcaStatePromise;
  if ('error' in orcaStateResult) throw orcaStateResult.error;
  const orcaLeg = await buildOrcaSwapLeg({
    connection: input.connection,
    wallet: input.wallet,
    inputMint: intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: BigInt(jupiterBuild.otherAmountThreshold),
    slippageBps: input.slippageBps,
    inputToken: intermediateToken,
    outputToken: baseToken,
    inputAta: intermediateAta,
    outputAta: baseAta,
    profiler,
    candidatePoolAddresses: input.orcaPoolHints,
    preparedState: orcaStateResult.value,
  });

  // Verify route mint safety
  const routeMints = [...new Set([
    ...jupiterBuild.routePlan.flatMap((step) => [step.swapInfo.inputMint, step.swapInfo.outputMint]),
    orcaLeg.inputMint, orcaLeg.outputMint,
  ])];
  const routeMintAnalyses = await Promise.all(routeMints.map((mint) =>
    getCachedExecutionMintAnalysis(input.connection, mint, profiler)));
  if (routeMintAnalyses.some((a) => a.status !== 'SUPPORTED' || a.programId !== TOKEN_PROGRAM_ID.toBase58())) {
    throw new Error('Mixed cycle route contains a non-classic or unsupported SPL mint');
  }

  const closesIntermediateAta = !intermediateAta.exists && intermediateMint === MINTS.SOL;
  const providerInstructions = [
    ...jupiterBuild.setupInstructions.map(toInstruction),
    ...jupiterBuild.otherInstructions.map(toInstruction),
    toInstruction(jupiterBuild.swapInstruction),
    orcaLeg.instruction,
    ...(closesIntermediateAta ? [new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(intermediateAta.ata), isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    })] : []),
  ].filter((instruction) => {
    if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return true;
    const target = instruction.keys[1]?.pubkey.toBase58();
    if (target === baseAta.ata && baseAta.exists) return false;
    if (target === intermediateAta.ata && intermediateAta.exists) return false;
    return true;
  });
  const deduped = uniqueInstructions(providerInstructions);

  if (!intermediateAta.exists && !deduped.some((i) =>
    i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
      && i.keys[1]?.pubkey.toBase58() === intermediateAta.ata)) {
    throw new Error('Missing intermediate ATA is not created by the reviewed instruction bundle');
  }

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit ?? 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...deduped,
  ];
  const [lookupTableAccounts, routeProgramIds] = await Promise.all([
    loadLookupTables(input.connection, [
      ...Object.keys(jupiterBuild.addressesByLookupTableAddress),
    ], jupiterBuild.addressesByLookupTableAddress, profiler),
    executableRoutePrograms(input.connection, deduped, profiler),
  ]);

  const jupiterPool = jupiterBuild.routePlan.find((s) => s.swapInfo.ammKey)?.swapInfo.ammKey;
  if (!jupiterPool) throw new Error('Jupiter route is missing pool identity');
  const now = Date.now();
  const sourceInstructionHashes = deduped.map(instructionHash);

  return {
    id: `jupiter-orca-${now}-${amount}`,
    type: 'JUPITER_ORCA_CYCLE' as ExecutionRouteType,
    atomic: true,
    wallet: input.wallet.toBase58(),
    inputMint: MINTS.USDC,
    intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: input.inputAmount,
    expectedIntermediateAmount: BigInt(jupiterBuild.otherAmountThreshold),
    expectedOutputAmount: orcaLeg.expectedOutput,
    minimumOutputAmount: orcaLeg.minimumOutput,
    pools: [jupiterPool, orcaLeg.pool.address],
    quoteReceivedAt: Math.min(firstLegMarketStateAt, orcaLeg.quoteReceivedAt),
    executionTiming: {
      routeDiscoveryMs: 0, poolAccountFetchMs: 0, freshPoolStateFetchMs: 0,
      quoteGenerationMs: 0, transactionConstructionMs: 0,
      oldestPoolStateAt: Math.min(now, orcaLeg.quoteReceivedAt),
      newestPoolStateAt: now,
      quoteGeneratedAt: now, transactionConstructionStartedAt: now,
      quoteAgeAtTransactionConstructionMs: 0,
      networkRequests: profiler.timings,
    },
    baseToken, intermediateToken, baseAta, intermediateAta,
    computeUnitLimit: input.computeUnitLimit ?? 500_000,
    computeUnitPriceMicroLamports: priorityFeeMicroLamports,
    instructions,
    lookupTableAccounts,
    aggregatorEvidence: {
      providers: ['jupiter', 'orca'],
      routeProgramIds,
      sourceInstructionHashes,
      closesIntermediateAta,
      legs: [{
        provider: 'jupiter', programId: JUPITER_V6_PROGRAM_ID.toBase58(), inputMint: MINTS.USDC,
        outputMint: intermediateMint, inputAmount: input.inputAmount,
        expectedOutputAmount: BigInt(jupiterBuild.outAmount), minimumOutputAmount: BigInt(jupiterBuild.otherAmountThreshold),
        pool: jupiterPool,
      }, {
        provider: 'orca', programId: orcaLeg.programId, inputMint: intermediateMint,
        outputMint: MINTS.USDC, inputAmount: BigInt(jupiterBuild.otherAmountThreshold),
        expectedOutputAmount: orcaLeg.expectedOutput, minimumOutputAmount: orcaLeg.minimumOutput,
        pool: orcaLeg.pool.address,
      }],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orca -> Jupiter cycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constructs an atomic Orca -> Jupiter cycle: USDC -> intermediate via Orca,
 * then intermediate -> USDC via Jupiter. Orca's enforceable `otherAmountThreshold`
 * (minimumOutput) is used as the Jupiter second-leg input.
 */
export async function buildOrcaJupiterCycle(input: MixedCycleInput): Promise<AtomicExecutionPlan> {
  const priorityFeeMicroLamports = currentExecutionPriorityFee().microLamportsPerCu;
  if (input.inputAmount <= 0n) throw new Error('Mixed cycle input must be positive');
  const intermediateMint = input.intermediateMint ?? MINTS.SOL;
  const profiler = input.profiler ?? new ExecutionNetworkProfiler();
  if (intermediateMint === MINTS.USDC) throw new Error('Mixed cycle intermediate must differ from USDC');

  const preflightPromise = input.preflight
    ? Promise.resolve([
      input.preflight.baseToken, input.preflight.intermediateToken,
      input.preflight.baseAta, input.preflight.intermediateAta,
    ] as const)
    : Promise.all([
      getCachedExecutionMintAnalysis(input.connection, MINTS.USDC, profiler),
      getCachedExecutionMintAnalysis(input.connection, intermediateMint, profiler),
      getCachedExecutionAta(input.connection, input.wallet, MINTS.USDC, profiler),
      getCachedExecutionAta(input.connection, input.wallet, intermediateMint, profiler),
    ]);
  void preflightPromise.catch(() => undefined);

  const [baseToken, intermediateToken, baseAta, intermediateAta] = await preflightPromise;
  if (baseToken.status !== 'SUPPORTED' || intermediateToken.status !== 'SUPPORTED'
    || baseToken.programId !== TOKEN_PROGRAM_ID.toBase58()
    || intermediateToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error('Mixed cycle requires classic SPL base and intermediate mints');
  }
  assertIntermediateTokenExecutionPolicy(intermediateToken);
  if (!baseAta.exists || baseAta.balance < input.inputAmount) {
    throw new Error('Wallet has insufficient USDC for mixed cycle validation');
  }

  // First leg: Orca USDC -> intermediate
  const orcaLeg = await buildOrcaSwapLeg({
    connection: input.connection,
    wallet: input.wallet,
    inputMint: MINTS.USDC,
    outputMint: intermediateMint,
    inputAmount: input.inputAmount,
    slippageBps: input.slippageBps,
    inputToken: baseToken,
    outputToken: intermediateToken,
    inputAta: baseAta,
    outputAta: intermediateAta,
    profiler,
    candidatePoolAddresses: input.orcaPoolHints,
  });

  // Second leg: Jupiter intermediate -> USDC using Orca's enforceable minimum
  const jupiterUrl = new URL('https://api.jup.ag/swap/v2/build');
  for (const [key, value] of Object.entries({
    inputMint: intermediateMint,
    outputMint: MINTS.USDC,
    amount: orcaLeg.minimumOutput.toString(),
    taker: input.wallet.toBase58(),
    slippageBps: String(input.slippageBps),
    mode: 'fast',
    maxAccounts: '24',
    wrapAndUnwrapSol: 'false',
    dexes: EXECUTION_JUPITER_DEXES.join(','),
  })) jupiterUrl.searchParams.set(key, value);
  const jupiterHeaders: Record<string, string> = { accept: 'application/json' };
  if (CONFIG.jupiterApiKey) jupiterHeaders['x-api-key'] = CONFIG.jupiterApiKey;
  const jupiterBuild = JupiterBuildSchema.parse(await responseJson(jupiterUrl, {
    method: 'GET', headers: jupiterHeaders,
  }, 'Jupiter V2 instruction build', profiler));
  assertAtomic(jupiterBuild.inAmount, 'Jupiter inAmount');
  assertAtomic(jupiterBuild.outAmount, 'Jupiter outAmount');
  assertAtomic(jupiterBuild.otherAmountThreshold, 'Jupiter minimum output');
  if (jupiterBuild.inputMint !== intermediateMint || jupiterBuild.outputMint !== MINTS.USDC
    || jupiterBuild.inAmount !== orcaLeg.minimumOutput.toString() || BigInt(jupiterBuild.outAmount) <= 0n) {
    throw new Error('Jupiter build does not propagate the exact Orca first-leg minimum output');
  }
  if (jupiterBuild.swapInstruction.programId !== JUPITER_V6_PROGRAM_ID.toBase58()) {
    throw new Error('Jupiter build returned an unexpected swap program');
  }
  if (jupiterBuild.tipInstruction) throw new Error('Jupiter build unexpectedly requested a tip instruction');

  // Verify route mint safety
  const routeMints = [...new Set([
    orcaLeg.inputMint, orcaLeg.outputMint,
    ...jupiterBuild.routePlan.flatMap((step) => [step.swapInfo.inputMint, step.swapInfo.outputMint]),
  ])];
  const routeMintAnalyses = await Promise.all(routeMints.map((mint) =>
    getCachedExecutionMintAnalysis(input.connection, mint, profiler)));
  if (routeMintAnalyses.some((a) => a.status !== 'SUPPORTED' || a.programId !== TOKEN_PROGRAM_ID.toBase58())) {
    throw new Error('Mixed cycle route contains a non-classic or unsupported SPL mint');
  }

  const closesIntermediateAta = !intermediateAta.exists && intermediateMint === MINTS.SOL;
  const createsIntermediateAta = !intermediateAta.exists;
  const providerInstructions = [
    // When Orca is the first leg, the intermediate output ATA must exist before
    // the Whirlpool swap instruction can deposit tokens. Create it idempotently.
    ...(createsIntermediateAta ? [new TransactionInstruction({
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
    })] : []),
    orcaLeg.instruction,
    ...jupiterBuild.setupInstructions.map(toInstruction),
    ...jupiterBuild.otherInstructions.map(toInstruction),
    toInstruction(jupiterBuild.swapInstruction),
    ...(jupiterBuild.cleanupInstruction ? [toInstruction(jupiterBuild.cleanupInstruction)] : []),
    ...(closesIntermediateAta ? [new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(intermediateAta.ata), isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    })] : []),
  ].filter((instruction) => {
    if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return true;
    const target = instruction.keys[1]?.pubkey.toBase58();
    if (target === baseAta.ata && baseAta.exists) return false;
    if (target === intermediateAta.ata && intermediateAta.exists) return false;
    return true;
  });
  const deduped = uniqueInstructions(providerInstructions);

  if (!intermediateAta.exists && !deduped.some((i) =>
    i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
      && i.keys[1]?.pubkey.toBase58() === intermediateAta.ata)) {
    throw new Error('Missing intermediate ATA is not created by the reviewed instruction bundle');
  }

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit ?? 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...deduped,
  ];
  const [lookupTableAccounts, routeProgramIds] = await Promise.all([
    loadLookupTables(input.connection, [
      ...Object.keys(jupiterBuild.addressesByLookupTableAddress),
    ], jupiterBuild.addressesByLookupTableAddress, profiler),
    executableRoutePrograms(input.connection, deduped, profiler),
  ]);

  const jupiterPool = [...jupiterBuild.routePlan].reverse().find((s) => s.swapInfo.ammKey)?.swapInfo.ammKey;
  if (!jupiterPool) throw new Error('Jupiter route is missing pool identity');
  const now = Date.now();
  const sourceInstructionHashes = deduped.map(instructionHash);

  return {
    id: `orca-jupiter-${now}-${input.inputAmount}`,
    type: 'ORCA_JUPITER_CYCLE' as ExecutionRouteType,
    atomic: true,
    wallet: input.wallet.toBase58(),
    inputMint: MINTS.USDC,
    intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: input.inputAmount,
    expectedIntermediateAmount: orcaLeg.minimumOutput,
    expectedOutputAmount: BigInt(jupiterBuild.outAmount),
    minimumOutputAmount: BigInt(jupiterBuild.otherAmountThreshold),
    pools: [orcaLeg.pool.address, jupiterPool],
    quoteReceivedAt: Math.min(orcaLeg.quoteReceivedAt, now),
    executionTiming: {
      routeDiscoveryMs: 0, poolAccountFetchMs: 0, freshPoolStateFetchMs: 0,
      quoteGenerationMs: 0, transactionConstructionMs: 0,
      oldestPoolStateAt: Math.min(orcaLeg.quoteReceivedAt, now),
      newestPoolStateAt: now,
      quoteGeneratedAt: now, transactionConstructionStartedAt: now,
      quoteAgeAtTransactionConstructionMs: 0,
      networkRequests: profiler.timings,
    },
    baseToken, intermediateToken, baseAta, intermediateAta,
    computeUnitLimit: input.computeUnitLimit ?? 500_000,
    computeUnitPriceMicroLamports: priorityFeeMicroLamports,
    instructions,
    lookupTableAccounts,
    aggregatorEvidence: {
      providers: ['orca', 'jupiter'],
      routeProgramIds,
      sourceInstructionHashes,
      closesIntermediateAta,
      legs: [{
        provider: 'orca', programId: orcaLeg.programId, inputMint: MINTS.USDC,
        outputMint: intermediateMint, inputAmount: input.inputAmount,
        expectedOutputAmount: orcaLeg.expectedOutput, minimumOutputAmount: orcaLeg.minimumOutput,
        pool: orcaLeg.pool.address,
      }, {
        provider: 'jupiter', programId: JUPITER_V6_PROGRAM_ID.toBase58(), inputMint: intermediateMint,
        outputMint: MINTS.USDC, inputAmount: orcaLeg.minimumOutput,
        expectedOutputAmount: BigInt(jupiterBuild.outAmount), minimumOutputAmount: BigInt(jupiterBuild.otherAmountThreshold),
        pool: jupiterPool,
      }],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Raptor -> Orca cycle
// ─────────────────────────────────────────────────────────────────────────────

export async function buildRaptorOrcaCycle(input: MixedCycleInput): Promise<AtomicExecutionPlan> {
  const priorityFeeMicroLamports = currentExecutionPriorityFee().microLamportsPerCu;
  if (input.inputAmount <= 0n) throw new Error('Mixed cycle input must be positive');
  const intermediateMint = input.intermediateMint ?? MINTS.SOL;
  const profiler = input.profiler ?? new ExecutionNetworkProfiler();
  if (intermediateMint === MINTS.USDC) throw new Error('Mixed cycle intermediate must differ from USDC');

  const preflightPromise = input.preflight
    ? Promise.resolve([
      input.preflight.baseToken, input.preflight.intermediateToken,
      input.preflight.baseAta, input.preflight.intermediateAta,
    ] as const)
    : Promise.all([
      getCachedExecutionMintAnalysis(input.connection, MINTS.USDC, profiler),
      getCachedExecutionMintAnalysis(input.connection, intermediateMint, profiler),
      getCachedExecutionAta(input.connection, input.wallet, MINTS.USDC, profiler),
      getCachedExecutionAta(input.connection, input.wallet, intermediateMint, profiler),
    ]);
  void preflightPromise.catch(() => undefined);
  const orcaStatePromise = prepareOrcaSwapState({
    inputMint: intermediateMint, outputMint: MINTS.USDC,
    profiler, candidatePoolAddresses: input.orcaPoolHints,
  }).then((value) => ({ value } as const), (error: unknown) => ({ error } as const));

  const amount = input.inputAmount.toString();

  // First leg: Raptor USDC -> intermediate
  const raptorQuoteUrl = new URL(`${CONFIG.raptorBaseUrl.replace(/\/$/, '')}/quote`);
  raptorQuoteUrl.searchParams.set('inputMint', MINTS.USDC);
  raptorQuoteUrl.searchParams.set('outputMint', intermediateMint);
  raptorQuoteUrl.searchParams.set('amount', amount);
  raptorQuoteUrl.searchParams.set('slippageBps', String(input.slippageBps));
  raptorQuoteUrl.searchParams.set('maxHops', String(EXECUTION_AGGREGATOR_MAX_HOPS));
  raptorQuoteUrl.searchParams.set('onlyDirectRoutes', 'true');
  raptorQuoteUrl.searchParams.set('dexes', EXECUTION_RAPTOR_DEXES.join(','));
  const raptorQuote = RaptorQuoteSchema.parse(await responseJson(raptorQuoteUrl, {
    method: 'GET', headers: { accept: 'application/json' },
  }, 'Raptor execution quote', profiler));
  const firstLegMarketStateAt = Date.now();
  profiler.trace('QUOTE_END', {
    provider: 'raptor',
    freshnessEvidenceAt: firstLegMarketStateAt,
    freshnessEvidenceAtIso: new Date(firstLegMarketStateAt).toISOString(),
  });
  assertAtomic(raptorQuote.amountIn, 'Raptor amountIn');
  assertAtomic(raptorQuote.amountOut, 'Raptor amountOut');
  assertAtomic(raptorQuote.minAmountOut, 'Raptor minAmountOut');
  if (raptorQuote.inputMint !== MINTS.USDC || raptorQuote.outputMint !== intermediateMint
    || raptorQuote.amountIn !== amount || BigInt(raptorQuote.amountOut) <= 0n) {
    throw new Error('Raptor execution quote does not match the requested first leg');
  }
  const raptorBundlePromise = responseJson(
    `${CONFIG.raptorBaseUrl.replace(/\/$/, '')}/swap-instructions`,
    {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        userPublicKey: input.wallet.toBase58(), quoteResponse: raptorQuote,
        wrapUnwrapSol: false, txVersion: 'V0',
      }),
    },
    'Raptor instruction build', profiler,
  ).then((value) => InstructionBundleSchema.parse(value));

  // Second leg: Orca intermediate -> USDC using Raptor's enforceable minimum
  const [baseToken, intermediateToken, baseAta, intermediateAta] = await preflightPromise;
  if (baseToken.status !== 'SUPPORTED' || intermediateToken.status !== 'SUPPORTED'
    || baseToken.programId !== TOKEN_PROGRAM_ID.toBase58()
    || intermediateToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error('Mixed cycle requires classic SPL base and intermediate mints');
  }
  assertIntermediateTokenExecutionPolicy(intermediateToken);
  if (!baseAta.exists || baseAta.balance < input.inputAmount) {
    throw new Error('Wallet has insufficient USDC for mixed cycle validation');
  }

  const orcaStateResult = await orcaStatePromise;
  if ('error' in orcaStateResult) throw orcaStateResult.error;
  const orcaLegPromise = buildOrcaSwapLeg({
    connection: input.connection,
    wallet: input.wallet,
    inputMint: intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: BigInt(raptorQuote.minAmountOut),
    slippageBps: input.slippageBps,
    inputToken: intermediateToken,
    outputToken: baseToken,
    inputAta: intermediateAta,
    outputAta: baseAta,
    profiler,
    candidatePoolAddresses: input.orcaPoolHints,
    preparedState: orcaStateResult.value,
  });
  const [raptorBundle, orcaLeg] = await Promise.all([raptorBundlePromise, orcaLegPromise]);
  if (raptorBundle.swapInstruction.programId !== RAPTOR_PROGRAM_ID.toBase58()) {
    throw new Error('Raptor instruction builder returned an unexpected swap program');
  }
  if (raptorBundle.cleanupInstruction) {
    throw new Error('Raptor first-leg cleanup is not composable with the reviewed second leg');
  }

  const closesIntermediateAta = !intermediateAta.exists && intermediateMint === MINTS.SOL;
  const providerInstructions = [
    ...(raptorBundle.tokenLedgerInstruction ? [toInstruction(raptorBundle.tokenLedgerInstruction)] : []),
    ...raptorBundle.setupInstructions.map(toInstruction),
    toInstruction(raptorBundle.swapInstruction),
    orcaLeg.instruction,
    ...(closesIntermediateAta ? [new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(intermediateAta.ata), isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    })] : []),
  ].filter((instruction) => {
    if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return true;
    const target = instruction.keys[1]?.pubkey.toBase58();
    if (target === baseAta.ata && baseAta.exists) return false;
    if (target === intermediateAta.ata && intermediateAta.exists) return false;
    return true;
  });
  const deduped = uniqueInstructions(providerInstructions);

  if (!intermediateAta.exists && !deduped.some((i) =>
    i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
      && i.keys[1]?.pubkey.toBase58() === intermediateAta.ata)) {
    throw new Error('Missing intermediate ATA is not created by the reviewed instruction bundle');
  }

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit ?? 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...deduped,
  ];
  const [lookupTableAccounts, routeProgramIds] = await Promise.all([
    loadLookupTables(input.connection, raptorBundle.addressLookupTableAddresses, {}, profiler),
    executableRoutePrograms(input.connection, deduped, profiler),
  ]);

  const raptorPool = raptorQuote.routePlan.find((step) => step.pool)?.pool;
  if (!raptorPool) throw new Error('Raptor route is missing pool identity');
  const now = Date.now();
  const sourceInstructionHashes = deduped.map(instructionHash);

  return {
    id: `raptor-orca-${now}-${amount}`,
    type: 'RAPTOR_ORCA_CYCLE' as ExecutionRouteType,
    atomic: true,
    wallet: input.wallet.toBase58(),
    inputMint: MINTS.USDC,
    intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: input.inputAmount,
    expectedIntermediateAmount: BigInt(raptorQuote.minAmountOut),
    expectedOutputAmount: orcaLeg.expectedOutput,
    minimumOutputAmount: orcaLeg.minimumOutput,
    pools: [raptorPool, orcaLeg.pool.address],
    quoteReceivedAt: Math.min(firstLegMarketStateAt, orcaLeg.quoteReceivedAt),
    executionTiming: {
      routeDiscoveryMs: 0, poolAccountFetchMs: 0, freshPoolStateFetchMs: 0,
      quoteGenerationMs: 0, transactionConstructionMs: 0,
      oldestPoolStateAt: Math.min(now, orcaLeg.quoteReceivedAt),
      newestPoolStateAt: now,
      oldestPoolStateSlot: raptorQuote.contextSlot,
      newestPoolStateSlot: raptorQuote.contextSlot,
      quoteGeneratedAt: now, transactionConstructionStartedAt: now,
      quoteAgeAtTransactionConstructionMs: 0,
      networkRequests: profiler.timings,
    },
    baseToken, intermediateToken, baseAta, intermediateAta,
    computeUnitLimit: input.computeUnitLimit ?? 500_000,
    computeUnitPriceMicroLamports: priorityFeeMicroLamports,
    instructions,
    lookupTableAccounts,
    aggregatorEvidence: {
      providers: ['raptor', 'orca'],
      routeProgramIds,
      sourceInstructionHashes,
      closesIntermediateAta,
      legs: [{
        provider: 'raptor', programId: RAPTOR_PROGRAM_ID.toBase58(), inputMint: MINTS.USDC,
        outputMint: intermediateMint, inputAmount: input.inputAmount,
        expectedOutputAmount: BigInt(raptorQuote.amountOut), minimumOutputAmount: BigInt(raptorQuote.minAmountOut),
        pool: raptorPool,
      }, {
        provider: 'orca', programId: orcaLeg.programId, inputMint: intermediateMint,
        outputMint: MINTS.USDC, inputAmount: BigInt(raptorQuote.minAmountOut),
        expectedOutputAmount: orcaLeg.expectedOutput, minimumOutputAmount: orcaLeg.minimumOutput,
        pool: orcaLeg.pool.address,
      }],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orca -> Raptor cycle
// ─────────────────────────────────────────────────────────────────────────────

export async function buildOrcaRaptorCycle(input: MixedCycleInput): Promise<AtomicExecutionPlan> {
  const priorityFeeMicroLamports = currentExecutionPriorityFee().microLamportsPerCu;
  if (input.inputAmount <= 0n) throw new Error('Mixed cycle input must be positive');
  const intermediateMint = input.intermediateMint ?? MINTS.SOL;
  const profiler = input.profiler ?? new ExecutionNetworkProfiler();
  if (intermediateMint === MINTS.USDC) throw new Error('Mixed cycle intermediate must differ from USDC');

  const preflightPromise = input.preflight
    ? Promise.resolve([
      input.preflight.baseToken, input.preflight.intermediateToken,
      input.preflight.baseAta, input.preflight.intermediateAta,
    ] as const)
    : Promise.all([
      getCachedExecutionMintAnalysis(input.connection, MINTS.USDC, profiler),
      getCachedExecutionMintAnalysis(input.connection, intermediateMint, profiler),
      getCachedExecutionAta(input.connection, input.wallet, MINTS.USDC, profiler),
      getCachedExecutionAta(input.connection, input.wallet, intermediateMint, profiler),
    ]);
  void preflightPromise.catch(() => undefined);

  const [baseToken, intermediateToken, baseAta, intermediateAta] = await preflightPromise;
  if (baseToken.status !== 'SUPPORTED' || intermediateToken.status !== 'SUPPORTED'
    || baseToken.programId !== TOKEN_PROGRAM_ID.toBase58()
    || intermediateToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error('Mixed cycle requires classic SPL base and intermediate mints');
  }
  assertIntermediateTokenExecutionPolicy(intermediateToken);
  if (!baseAta.exists || baseAta.balance < input.inputAmount) {
    throw new Error('Wallet has insufficient USDC for mixed cycle validation');
  }

  // First leg: Orca USDC -> intermediate
  const orcaLeg = await buildOrcaSwapLeg({
    connection: input.connection,
    wallet: input.wallet,
    inputMint: MINTS.USDC,
    outputMint: intermediateMint,
    inputAmount: input.inputAmount,
    slippageBps: input.slippageBps,
    inputToken: baseToken,
    outputToken: intermediateToken,
    inputAta: baseAta,
    outputAta: intermediateAta,
    profiler,
    candidatePoolAddresses: input.orcaPoolHints,
  });

  // Second leg: Raptor intermediate -> USDC using Orca's enforceable minimum
  const raptorQuoteUrl = new URL(`${CONFIG.raptorBaseUrl.replace(/\/$/, '')}/quote`);
  raptorQuoteUrl.searchParams.set('inputMint', intermediateMint);
  raptorQuoteUrl.searchParams.set('outputMint', MINTS.USDC);
  raptorQuoteUrl.searchParams.set('amount', orcaLeg.minimumOutput.toString());
  raptorQuoteUrl.searchParams.set('slippageBps', String(input.slippageBps));
  raptorQuoteUrl.searchParams.set('maxHops', String(EXECUTION_AGGREGATOR_MAX_HOPS));
  raptorQuoteUrl.searchParams.set('onlyDirectRoutes', 'true');
  raptorQuoteUrl.searchParams.set('dexes', EXECUTION_RAPTOR_DEXES.join(','));
  const raptorQuote = RaptorQuoteSchema.parse(await responseJson(raptorQuoteUrl, {
    method: 'GET', headers: { accept: 'application/json' },
  }, 'Raptor execution quote', profiler));
  assertAtomic(raptorQuote.amountIn, 'Raptor amountIn');
  assertAtomic(raptorQuote.amountOut, 'Raptor amountOut');
  assertAtomic(raptorQuote.minAmountOut, 'Raptor minAmountOut');
  if (raptorQuote.inputMint !== intermediateMint || raptorQuote.outputMint !== MINTS.USDC
    || raptorQuote.amountIn !== orcaLeg.minimumOutput.toString() || BigInt(raptorQuote.amountOut) <= 0n) {
    throw new Error('Raptor quote does not propagate the exact Orca first-leg minimum output');
  }
  const raptorBundle = InstructionBundleSchema.parse(await responseJson(
    `${CONFIG.raptorBaseUrl.replace(/\/$/, '')}/swap-instructions`,
    {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        userPublicKey: input.wallet.toBase58(), quoteResponse: raptorQuote,
        wrapUnwrapSol: false, txVersion: 'V0',
      }),
    },
    'Raptor instruction build', profiler,
  ));
  if (raptorBundle.swapInstruction.programId !== RAPTOR_PROGRAM_ID.toBase58()) {
    throw new Error('Raptor instruction builder returned an unexpected swap program');
  }
  if (raptorBundle.cleanupInstruction) {
    throw new Error('Raptor cleanup is not part of the reviewed composed cycle');
  }

  const closesIntermediateAta = !intermediateAta.exists && intermediateMint === MINTS.SOL;
  const createsIntermediateAta = !intermediateAta.exists;
  const providerInstructions = [
    // When Orca is the first leg, the intermediate output ATA must exist before
    // the Whirlpool swap instruction can deposit tokens. Create it idempotently.
    ...(createsIntermediateAta ? [new TransactionInstruction({
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
    })] : []),
    orcaLeg.instruction,
    ...(raptorBundle.tokenLedgerInstruction ? [toInstruction(raptorBundle.tokenLedgerInstruction)] : []),
    ...raptorBundle.setupInstructions.map(toInstruction),
    toInstruction(raptorBundle.swapInstruction),
    ...(closesIntermediateAta ? [new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(intermediateAta.ata), isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    })] : []),
  ].filter((instruction) => {
    if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return true;
    const target = instruction.keys[1]?.pubkey.toBase58();
    if (target === baseAta.ata && baseAta.exists) return false;
    if (target === intermediateAta.ata && intermediateAta.exists) return false;
    return true;
  });
  const deduped = uniqueInstructions(providerInstructions);

  if (!intermediateAta.exists && !deduped.some((i) =>
    i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
      && i.keys[1]?.pubkey.toBase58() === intermediateAta.ata)) {
    throw new Error('Missing intermediate ATA is not created by the reviewed instruction bundle');
  }

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit ?? 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...deduped,
  ];
  const [lookupTableAccounts, routeProgramIds] = await Promise.all([
    loadLookupTables(input.connection, raptorBundle.addressLookupTableAddresses, {}, profiler),
    executableRoutePrograms(input.connection, deduped, profiler),
  ]);

  const raptorPool = [...raptorQuote.routePlan].reverse().find((step) => step.pool)?.pool;
  if (!raptorPool) throw new Error('Raptor route is missing pool identity');
  const now = Date.now();

  return {
    id: `orca-raptor-${now}-${input.inputAmount}`,
    type: 'ORCA_RAPTOR_CYCLE' as ExecutionRouteType,
    atomic: true,
    wallet: input.wallet.toBase58(),
    inputMint: MINTS.USDC,
    intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: input.inputAmount,
    expectedIntermediateAmount: orcaLeg.minimumOutput,
    expectedOutputAmount: BigInt(raptorQuote.amountOut),
    minimumOutputAmount: BigInt(raptorQuote.minAmountOut),
    pools: [orcaLeg.pool.address, raptorPool],
    quoteReceivedAt: Math.min(orcaLeg.quoteReceivedAt, now),
    executionTiming: {
      routeDiscoveryMs: 0, poolAccountFetchMs: 0, freshPoolStateFetchMs: 0,
      quoteGenerationMs: 0, transactionConstructionMs: 0,
      oldestPoolStateAt: Math.min(orcaLeg.quoteReceivedAt, now),
      newestPoolStateAt: now,
      oldestPoolStateSlot: raptorQuote.contextSlot, newestPoolStateSlot: raptorQuote.contextSlot,
      quoteGeneratedAt: now, transactionConstructionStartedAt: now,
      quoteAgeAtTransactionConstructionMs: 0,
      networkRequests: profiler.timings,
    },
    baseToken, intermediateToken, baseAta, intermediateAta,
    computeUnitLimit: input.computeUnitLimit ?? 500_000,
    computeUnitPriceMicroLamports: priorityFeeMicroLamports,
    instructions,
    lookupTableAccounts,
    aggregatorEvidence: {
      providers: ['orca', 'raptor'],
      routeProgramIds,
      sourceInstructionHashes: deduped.map(instructionHash),
      closesIntermediateAta,
      legs: [{
        provider: 'orca', programId: orcaLeg.programId, inputMint: MINTS.USDC,
        outputMint: intermediateMint, inputAmount: input.inputAmount,
        expectedOutputAmount: orcaLeg.expectedOutput, minimumOutputAmount: orcaLeg.minimumOutput,
        pool: orcaLeg.pool.address,
      }, {
        provider: 'raptor', programId: RAPTOR_PROGRAM_ID.toBase58(), inputMint: intermediateMint,
        outputMint: MINTS.USDC, inputAmount: orcaLeg.minimumOutput,
        expectedOutputAmount: BigInt(raptorQuote.amountOut), minimumOutputAmount: BigInt(raptorQuote.minAmountOut),
        pool: raptorPool,
      }],
    },
  };
}

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
import type { AtomicExecutionPlan } from './types.js';
import { getCachedExecutionAta, getCachedExecutionMintAnalysis } from './execution-preflight-cache.js';
import { ExecutionNetworkProfiler } from './network-profiler.js';
import { currentExecutionPriorityFee } from './priority-fee-oracle.js';
import {
  EXECUTION_AGGREGATOR_MAX_HOPS,
  EXECUTION_JUPITER_DEXES,
  EXECUTION_JUPITER_MAX_ACCOUNTS,
  EXECUTION_RAPTOR_DEXES,
} from './executable-route-policy.js';

export const RAPTOR_PROGRAM_ID = new PublicKey('RaptorD5ojtsqDDtJeRsunPLg6GvLYNnwKJWxYE4m87');
export const JUPITER_V6_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const LOOKUP_TABLE_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111');
const lookupTableCache = new Map<string, AddressLookupTableAccount>();
const executableAccountCache = new Map<string, boolean>();

export function seedAggregatorExecutableAccountCache(entries: ReadonlyMap<string, boolean>): void {
  for (const [address, executable] of entries) executableAccountCache.set(address, executable);
}

const ApiAccountSchema = z.object({
  pubkey: z.string(),
  isSigner: z.boolean(),
  isWritable: z.boolean(),
}).strict();
const ApiInstructionSchema = z.object({
  programId: z.string(),
  accounts: z.array(ApiAccountSchema),
  data: z.string(),
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
  otherAmountThreshold: z.string(), swapMode: z.literal('ExactIn'), slippageBps: z.coerce.number().optional(),
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
  for (const key of instruction.keys) {
    hash.update(key.pubkey.toBuffer());
  }
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
  const missing = unique.filter((address) => {
    const cached = lookupTableCache.get(address);
    const evidence = jupiterAddressEvidence[address];
    return !cached || Boolean(evidence && cached.state.addresses.length !== evidence.length);
  });
  if (missing.length > 0) {
    const load = () => connection.getMultipleAccountsInfo(
      missing.map((address) => new PublicKey(address)), 'confirmed');
    const infos = profiler
      ? await profiler.measure('rpc.alt.getMultipleAccountsInfo', 'rpc', load)
      : await load();
    missing.forEach((address, index) => {
      const info = infos[index];
      if (!info || !info.owner.equals(LOOKUP_TABLE_PROGRAM_ID)) {
        throw new Error(`Address lookup table ${address} is unavailable or has an unexpected owner`);
      }
      lookupTableCache.set(address, new AddressLookupTableAccount({
        key: new PublicKey(address), state: AddressLookupTableAccount.deserialize(info.data),
      }));
    });
  }
  return unique.map((address) => {
    const table = lookupTableCache.get(address);
    if (!table) throw new Error(`Address lookup table ${address} was not loaded`);
    const evidence = jupiterAddressEvidence[address];
    if (evidence) {
      const actual = table.state.addresses.map((item) => item.toBase58());
      if (actual.length !== evidence.length || actual.some((item, index) => item !== evidence[index])) {
        throw new Error(`Jupiter ALT evidence does not match on-chain table ${address}`);
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
  const topLevel = new Set(instructions.map((instruction) => instruction.programId.toBase58()));
  const accountAddresses = [...new Set(instructions.flatMap((instruction) =>
    instruction.keys.map((key) => key.pubkey.toBase58())))];
  const missing = accountAddresses.filter((address) => !executableAccountCache.has(address));
  if (missing.length > 0) {
    const load = () => connection.getMultipleAccountsInfo(
      missing.map((address) => new PublicKey(address)), 'confirmed');
    const infos = profiler
      ? await profiler.measure('rpc.programAccounts.getMultipleAccountsInfo', 'rpc', load)
      : await load();
    missing.forEach((address, index) => executableAccountCache.set(address, infos[index]?.executable === true));
  }
  return accountAddresses.filter((address) => executableAccountCache.get(address) && !topLevel.has(address)
    && address !== TOKEN_PROGRAM_ID.toBase58()
    && address !== 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
    && address !== '11111111111111111111111111111111');
}

export interface BuildRaptorJupiterCycleInput {
  /** Intent only; the CLMM builder independently fetches and validates this pool. */
  raydiumPoolHints?: readonly string[];
  connection: Connection;
  wallet: PublicKey;
  inputAmount: bigint;
  slippageBps: number;
  /** Canonical mint identity. Defaults to WSOL for the developer validator. */
  intermediateMint?: string;
  computeUnitLimit?: number;
  preflight?: Pick<AtomicExecutionPlan, 'baseToken' | 'intermediateToken' | 'baseAta' | 'intermediateAta'>;
  profiler?: ExecutionNetworkProfiler;
  /** Accepted by the provider-neutral validator; unused for non-Orca routes. */
  orcaPoolHints?: readonly string[];
}

/**
 * Constructs, but never signs or submits, one atomic Raptor -> Jupiter cycle.
 * Both API responses are fetched inside this executor module; scanner quotes
 * and scanner economics are never reused as execution authority.
 */
export async function buildRaptorJupiterCycle(input: BuildRaptorJupiterCycleInput): Promise<AtomicExecutionPlan> {
  const priorityFeeMicroLamports = currentExecutionPriorityFee().microLamportsPerCu;
  if (input.inputAmount <= 0n) throw new Error('Aggregator cycle input must be positive');
  const intermediateMint = input.intermediateMint ?? MINTS.SOL;
  const profiler = input.profiler ?? new ExecutionNetworkProfiler();
  if (intermediateMint === MINTS.USDC) throw new Error('Aggregator cycle intermediate mint must differ from USDC');
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
  const amount = input.inputAmount.toString();
  const raptorQuoteUrl = new URL(`${CONFIG.raptorBaseUrl.replace(/\/$/, '')}/quote`);
  raptorQuoteUrl.searchParams.set('inputMint', MINTS.USDC);
  raptorQuoteUrl.searchParams.set('outputMint', intermediateMint);
  raptorQuoteUrl.searchParams.set('amount', amount);
  raptorQuoteUrl.searchParams.set('slippageBps', String(input.slippageBps));
  raptorQuoteUrl.searchParams.set('maxHops', String(EXECUTION_AGGREGATOR_MAX_HOPS));
  raptorQuoteUrl.searchParams.set('onlyDirectRoutes', 'true');
  // The first executable implementation intentionally constrains CPI surface
  // to independently reviewed direct venues. Broader scanner routes remain
  // discovery-only until their programs receive the same review.
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

  const jupiterUrl = new URL('https://api.jup.ag/swap/v2/build');
  for (const [key, value] of Object.entries({
    inputMint: intermediateMint,
    outputMint: MINTS.USDC,
    // The second leg consumes the first leg's enforceable minimum. Using the
    // optimistic amountOut can make an otherwise valid atomic cycle fail if
    // pool state moves by even one lamport between quote and execution. Any
    // surplus remains observable WSOL dust and is never counted as USDC P&L.
    amount: raptorQuote.minAmountOut,
    taker: input.wallet.toBase58(),
    slippageBps: 'rtse',
    mode: 'fast',
    // Composition must leave room for the first leg and audited WSOL cleanup.
    // Jupiter documents maxAccounts specifically for custom transactions.
    maxAccounts: String(EXECUTION_JUPITER_MAX_ACCOUNTS),
    wrapAndUnwrapSol: 'false',
    dexes: EXECUTION_JUPITER_DEXES.join(','),
  })) jupiterUrl.searchParams.set(key, value);
  const jupiterHeaders: Record<string, string> = { accept: 'application/json' };
  if (CONFIG.jupiterApiKey) jupiterHeaders['x-api-key'] = CONFIG.jupiterApiKey;
  const jupiterBuildPromise = responseJson(jupiterUrl, {
    method: 'GET', headers: jupiterHeaders,
  }, 'Jupiter V2 instruction build', profiler).then((value) => JupiterBuildSchema.parse(value));
  const [raptorBundle, jupiterBuild] = await Promise.all([raptorBundlePromise, jupiterBuildPromise]);
  if (raptorBundle.swapInstruction.programId !== RAPTOR_PROGRAM_ID.toBase58()) {
    throw new Error('Raptor instruction builder returned an unexpected swap program');
  }
  if (raptorBundle.cleanupInstruction) {
    throw new Error('Raptor first-leg cleanup is not composable with the reviewed second leg');
  }
  assertAtomic(jupiterBuild.inAmount, 'Jupiter inAmount');
  assertAtomic(jupiterBuild.outAmount, 'Jupiter outAmount');
  assertAtomic(jupiterBuild.otherAmountThreshold, 'Jupiter minimum output');
  if (jupiterBuild.inputMint !== intermediateMint || jupiterBuild.outputMint !== MINTS.USDC
    || jupiterBuild.inAmount !== raptorQuote.minAmountOut || BigInt(jupiterBuild.outAmount) <= 0n) {
    throw new Error('Jupiter build does not propagate the exact Raptor first-leg output');
  }
  if (jupiterBuild.swapInstruction.programId !== JUPITER_V6_PROGRAM_ID.toBase58()) {
    throw new Error('Jupiter build returned an unexpected swap program');
  }
  if (jupiterBuild.tipInstruction) throw new Error('Jupiter build unexpectedly requested a tip instruction');

  const routeMints = [...new Set([
    ...raptorQuote.routePlan.flatMap((step) =>
      [step.inputMint, step.outputMint].filter((mint): mint is string => Boolean(mint))),
    ...jupiterBuild.routePlan.flatMap((step) => [
      step.swapInfo.inputMint, step.swapInfo.outputMint,
    ]),
  ])];
  const routeMintAnalyses = await Promise.all(routeMints.map((mint) =>
    getCachedExecutionMintAnalysis(input.connection, mint, profiler)));
  if (routeMintAnalyses.some((analysis) => analysis.status !== 'SUPPORTED'
    || analysis.programId !== TOKEN_PROGRAM_ID.toBase58())) {
    throw new Error('Jupiter execution route contains a non-classic or unsupported SPL mint');
  }

  const [baseToken, intermediateToken, baseAta, intermediateAta] = await preflightPromise;
  if (baseToken.status !== 'SUPPORTED' || intermediateToken.status !== 'SUPPORTED'
    || baseToken.programId !== TOKEN_PROGRAM_ID.toBase58()
    || intermediateToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error('Aggregator cycle requires classic SPL base and intermediate mints');
  }
  assertIntermediateTokenExecutionPolicy(intermediateToken);
  if (!baseAta.exists || baseAta.balance < input.inputAmount) throw new Error('Wallet has insufficient USDC for aggregator validation');

  const providerInstructions = [
    ...(raptorBundle.tokenLedgerInstruction ? [toInstruction(raptorBundle.tokenLedgerInstruction)] : []),
    ...raptorBundle.setupInstructions.map(toInstruction),
    toInstruction(raptorBundle.swapInstruction),
    ...(raptorBundle.cleanupInstruction ? [toInstruction(raptorBundle.cleanupInstruction)] : []),
    ...jupiterBuild.setupInstructions.map(toInstruction),
    ...jupiterBuild.otherInstructions.map(toInstruction),
    toInstruction(jupiterBuild.swapInstruction),
    ...(jupiterBuild.cleanupInstruction ? [toInstruction(jupiterBuild.cleanupInstruction)] : []),
    ...(!intermediateAta.exists && intermediateMint === MINTS.SOL ? [new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(intermediateAta.ata), isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: false, isWritable: true },
        { pubkey: input.wallet, isSigner: true, isWritable: false },
      ],
      // SPL Token CloseAccount. For native WSOL this unwraps any surplus and
      // returns the ATA rent to the same dedicated wallet.
      data: Buffer.from([9]),
    })] : []),
  ].filter((instruction) => {
    if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return true;
    const target = instruction.keys[1]?.pubkey.toBase58();
    // Idempotent creation for an account already proven to exist only adds
    // bytes/compute and is removed before message approval.
    if (target === baseAta.ata && baseAta.exists) return false;
    if (target === intermediateAta.ata && intermediateAta.exists) return false;
    return true;
  });
  const deduped = uniqueInstructions(providerInstructions);
  if (!intermediateAta.exists && !deduped.some((instruction) =>
    instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
      && instruction.keys[1]?.pubkey.toBase58() === intermediateAta.ata)) {
    throw new Error('Missing intermediate ATA is not created by the reviewed instruction bundle');
  }
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit ?? 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...deduped,
  ];
  profiler.trace('JUPITER_BUILD_TELEMETRY', {
    requestedSlippage: 'rtse',
    returnedSlippageBps: jupiterBuild.slippageBps,
    inAmount: jupiterBuild.inAmount,
    outAmount: jupiterBuild.outAmount,
    otherAmountThreshold: jupiterBuild.otherAmountThreshold,
    swapProgramId: jupiterBuild.swapInstruction.programId,
    instructionMapping: instructions.reduce<Record<number, string>>((acc, ix, idx) => {
      acc[idx] = ix.programId.toBase58();
      return acc;
    }, {}),
  });
  const lookupTableAddresses = [
    ...raptorBundle.addressLookupTableAddresses,
    ...Object.keys(jupiterBuild.addressesByLookupTableAddress),
  ];
  const [lookupTableAccounts, routeProgramIds] = await Promise.all([
    loadLookupTables(input.connection, lookupTableAddresses, jupiterBuild.addressesByLookupTableAddress, profiler),
    executableRoutePrograms(input.connection, deduped, profiler),
  ]);
  const pools = [
    raptorQuote.routePlan.find((step) => step.pool)?.pool,
    [...jupiterBuild.routePlan].reverse().find((step) => step.swapInfo.ammKey)?.swapInfo.ammKey,
  ];
  if (!pools[0] || !pools[1]) throw new Error('Aggregator cycle route is missing pool identity');
  const now = Date.now();
  const sourceInstructionHashes = deduped.map(instructionHash);
  return {
    id: `raptor-jupiter-${now}-${amount}`,
    type: 'RAPTOR_JUPITER_CYCLE',
    atomic: true,
    wallet: input.wallet.toBase58(),
    inputMint: MINTS.USDC,
    intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: input.inputAmount,
    expectedIntermediateAmount: BigInt(raptorQuote.minAmountOut),
    expectedOutputAmount: BigInt(jupiterBuild.outAmount),
    minimumOutputAmount: BigInt(jupiterBuild.otherAmountThreshold),
    pools: [pools[0], pools[1]],
    quoteReceivedAt: firstLegMarketStateAt,
    executionTiming: {
      routeDiscoveryMs: 0, poolAccountFetchMs: 0, freshPoolStateFetchMs: 0,
      quoteGenerationMs: 0, transactionConstructionMs: 0,
      oldestPoolStateAt: now, newestPoolStateAt: now,
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
      providers: ['raptor', 'jupiter'],
      routeProgramIds,
      sourceInstructionHashes,
      closesIntermediateAta: !intermediateAta.exists && intermediateMint === MINTS.SOL,
      legs: [{
        provider: 'raptor', programId: RAPTOR_PROGRAM_ID.toBase58(), downstreamProgramId: raptorQuote.routePlan[0]?.programId,
        inputMint: MINTS.USDC, outputMint: intermediateMint, inputAmount: input.inputAmount,
        expectedOutputAmount: BigInt(raptorQuote.amountOut), minimumOutputAmount: BigInt(raptorQuote.minAmountOut),
        pool: pools[0],
      }, {
        provider: 'jupiter', programId: JUPITER_V6_PROGRAM_ID.toBase58(),
        inputMint: intermediateMint, outputMint: MINTS.USDC, inputAmount: BigInt(raptorQuote.minAmountOut),
        expectedOutputAmount: BigInt(jupiterBuild.outAmount), minimumOutputAmount: BigInt(jupiterBuild.otherAmountThreshold),
        pool: pools[1],
      }],
    },
  };
}

/**
 * Constructs the reviewed reverse cycle: Jupiter first, then Raptor. The
 * second leg consumes Jupiter's enforceable minimum, not its optimistic quote.
 * This makes the amount boundary deterministic; any first-leg surplus remains
 * intermediate dust and is excluded from realized USDC profit.
 */
export async function buildJupiterRaptorCycle(input: BuildRaptorJupiterCycleInput): Promise<AtomicExecutionPlan> {
  const priorityFeeMicroLamports = currentExecutionPriorityFee().microLamportsPerCu;
  if (input.inputAmount <= 0n) throw new Error('Aggregator cycle input must be positive');
  const intermediateMint = input.intermediateMint ?? MINTS.SOL;
  const profiler = input.profiler ?? new ExecutionNetworkProfiler();
  if (intermediateMint === MINTS.USDC) throw new Error('Aggregator cycle intermediate mint must differ from USDC');
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
  const amount = input.inputAmount.toString();
  const jupiterUrl = new URL('https://api.jup.ag/swap/v2/build');
  for (const [key, value] of Object.entries({
    inputMint: MINTS.USDC,
    outputMint: intermediateMint,
    amount,
    taker: input.wallet.toBase58(),
    slippageBps: 'rtse',
    mode: 'fast',
    maxAccounts: String(EXECUTION_JUPITER_MAX_ACCOUNTS),
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
    throw new Error('Jupiter execution build does not match the requested first leg');
  }
  if (jupiterBuild.swapInstruction.programId !== JUPITER_V6_PROGRAM_ID.toBase58()) {
    throw new Error('Jupiter build returned an unexpected swap program');
  }
  if (jupiterBuild.tipInstruction) throw new Error('Jupiter build unexpectedly requested a tip instruction');
  if (jupiterBuild.cleanupInstruction) {
    throw new Error('Jupiter first-leg cleanup is not composable with the reviewed second leg');
  }

  const raptorQuoteUrl = new URL(`${CONFIG.raptorBaseUrl.replace(/\/$/, '')}/quote`);
  raptorQuoteUrl.searchParams.set('inputMint', intermediateMint);
  raptorQuoteUrl.searchParams.set('outputMint', MINTS.USDC);
  raptorQuoteUrl.searchParams.set('amount', jupiterBuild.otherAmountThreshold);
  raptorQuoteUrl.searchParams.set('slippageBps', String(input.slippageBps));
  raptorQuoteUrl.searchParams.set('maxHops', String(EXECUTION_AGGREGATOR_MAX_HOPS));
  raptorQuoteUrl.searchParams.set('onlyDirectRoutes', 'true');
  raptorQuoteUrl.searchParams.set('dexes', EXECUTION_RAPTOR_DEXES.join(','));
  const raptorQuote = RaptorQuoteSchema.parse(await responseJson(raptorQuoteUrl, {
    method: 'GET', headers: { accept: 'application/json' },
  }, 'Raptor execution quote', profiler));
  profiler.trace('RAPTOR_SECOND_LEG_QUOTE_END', {
    provider: 'raptor',
    freshnessEvidenceAt: Date.now(),
  });
  assertAtomic(raptorQuote.amountIn, 'Raptor amountIn');
  assertAtomic(raptorQuote.amountOut, 'Raptor amountOut');
  assertAtomic(raptorQuote.minAmountOut, 'Raptor minAmountOut');
  if (raptorQuote.inputMint !== intermediateMint || raptorQuote.outputMint !== MINTS.USDC
    || raptorQuote.amountIn !== jupiterBuild.otherAmountThreshold || BigInt(raptorQuote.amountOut) <= 0n) {
    throw new Error('Raptor quote does not propagate the exact Jupiter first-leg minimum output');
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

  const routeMints = [...new Set([
    ...jupiterBuild.routePlan.flatMap((step) => [step.swapInfo.inputMint, step.swapInfo.outputMint]),
    ...raptorQuote.routePlan.flatMap((step) => [step.inputMint, step.outputMint].filter((mint): mint is string => Boolean(mint))),
  ])];
  const routeMintAnalyses = await Promise.all(routeMints.map((mint) =>
    getCachedExecutionMintAnalysis(input.connection, mint, profiler)));
  if (routeMintAnalyses.some((analysis) => analysis.status !== 'SUPPORTED'
    || analysis.programId !== TOKEN_PROGRAM_ID.toBase58())) {
    throw new Error('Aggregator execution route contains a non-classic or unsupported SPL mint');
  }
  const [baseToken, intermediateToken, baseAta, intermediateAta] = await preflightPromise;
  if (baseToken.status !== 'SUPPORTED' || intermediateToken.status !== 'SUPPORTED'
    || baseToken.programId !== TOKEN_PROGRAM_ID.toBase58()
    || intermediateToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error('Aggregator cycle requires classic SPL base and intermediate mints');
  }
  assertIntermediateTokenExecutionPolicy(intermediateToken);
  if (!baseAta.exists || baseAta.balance < input.inputAmount) {
    throw new Error('Wallet has insufficient USDC for aggregator validation');
  }

  const closesIntermediateAta = !intermediateAta.exists && intermediateMint === MINTS.SOL;
  const providerInstructions = [
    ...jupiterBuild.setupInstructions.map(toInstruction),
    ...jupiterBuild.otherInstructions.map(toInstruction),
    toInstruction(jupiterBuild.swapInstruction),
    ...(raptorBundle.tokenLedgerInstruction ? [toInstruction(raptorBundle.tokenLedgerInstruction)] : []),
    ...raptorBundle.setupInstructions.map(toInstruction),
    toInstruction(raptorBundle.swapInstruction),
    ...(raptorBundle.cleanupInstruction ? [toInstruction(raptorBundle.cleanupInstruction)] : []),
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
  if (!intermediateAta.exists && !deduped.some((instruction) =>
    instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
      && instruction.keys[1]?.pubkey.toBase58() === intermediateAta.ata)) {
    throw new Error('Missing intermediate ATA is not created by the reviewed instruction bundle');
  }
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit ?? 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...deduped,
  ];
  profiler.trace('JUPITER_BUILD_TELEMETRY', {
    requestedSlippage: 'rtse',
    returnedSlippageBps: jupiterBuild.slippageBps,
    inAmount: jupiterBuild.inAmount,
    outAmount: jupiterBuild.outAmount,
    otherAmountThreshold: jupiterBuild.otherAmountThreshold,
    swapProgramId: jupiterBuild.swapInstruction.programId,
    instructionMapping: instructions.reduce<Record<number, string>>((acc, ix, idx) => {
      acc[idx] = ix.programId.toBase58();
      return acc;
    }, {}),
  });
  const [lookupTableAccounts, routeProgramIds] = await Promise.all([
    loadLookupTables(input.connection, [
      ...Object.keys(jupiterBuild.addressesByLookupTableAddress),
      ...raptorBundle.addressLookupTableAddresses,
    ], jupiterBuild.addressesByLookupTableAddress, profiler),
    executableRoutePrograms(input.connection, deduped, profiler),
  ]);
  const pools = [
    jupiterBuild.routePlan.find((step) => step.swapInfo.ammKey)?.swapInfo.ammKey,
    [...raptorQuote.routePlan].reverse().find((step) => step.pool)?.pool,
  ];
  if (!pools[0] || !pools[1]) throw new Error('Aggregator cycle route is missing pool identity');
  const now = Date.now();
  return {
    id: `jupiter-raptor-${now}-${amount}`,
    type: 'JUPITER_RAPTOR_CYCLE',
    atomic: true,
    wallet: input.wallet.toBase58(),
    inputMint: MINTS.USDC,
    intermediateMint,
    outputMint: MINTS.USDC,
    inputAmount: input.inputAmount,
    expectedIntermediateAmount: BigInt(jupiterBuild.otherAmountThreshold),
    expectedOutputAmount: BigInt(raptorQuote.amountOut),
    minimumOutputAmount: BigInt(raptorQuote.minAmountOut),
    pools: [pools[0], pools[1]],
    quoteReceivedAt: firstLegMarketStateAt,
    executionTiming: {
      routeDiscoveryMs: 0, poolAccountFetchMs: 0, freshPoolStateFetchMs: 0,
      quoteGenerationMs: 0, transactionConstructionMs: 0,
      oldestPoolStateAt: now, newestPoolStateAt: now,
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
      providers: ['jupiter', 'raptor'],
      routeProgramIds,
      sourceInstructionHashes: deduped.map(instructionHash),
      closesIntermediateAta,
      legs: [{
        provider: 'jupiter', programId: JUPITER_V6_PROGRAM_ID.toBase58(),
        inputMint: MINTS.USDC, outputMint: intermediateMint, inputAmount: input.inputAmount,
        expectedOutputAmount: BigInt(jupiterBuild.outAmount), minimumOutputAmount: BigInt(jupiterBuild.otherAmountThreshold),
        pool: pools[0],
      }, {
        provider: 'raptor', programId: RAPTOR_PROGRAM_ID.toBase58(), downstreamProgramId: raptorQuote.routePlan[0]?.programId,
        inputMint: intermediateMint, outputMint: MINTS.USDC, inputAmount: BigInt(jupiterBuild.otherAmountThreshold),
        expectedOutputAmount: BigInt(raptorQuote.amountOut), minimumOutputAmount: BigInt(raptorQuote.minAmountOut),
        pool: pools[1],
      }],
    },
  };
}

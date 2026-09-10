import { Connection, PublicKey } from '@solana/web3.js';
import { performance } from 'node:perf_hooks';
import { providerFailureReason } from '../provider-failure.js';
import { jupiterAdmission } from '../jupiter.js';
import { raptorAdmission } from '../raptor.js';
import { workflowParentDeadline, projectWorkflow, recordWorkflowProjection } from './prefilter-workflow.js';
import { getProviderQuote } from '../aggregators/index.js';
import { isFullFillQuote, type Quote, type QuoteProviderName, type QuoteParams } from '../aggregators/types.js';
import { CONFIG, DECIMALS, LAMPORTS_PER_SOL, MINTS } from '../config.js';
import { fromAtomic, toAtomic } from '../math.js';
import { calculateEstimatedRoundTripProfit, type EstimatedCostInput } from '../profit.js';
import { runScannerRpc,scannerRpcContext } from '../scanner-rpc-limiter.js';
import { scannerConnection } from '../scanner-rpc-transport.js';
import {
  categorizeProfit,
  classifyRoute,
  classifyValidationTier,
  type RoundTripResult,
} from '../routes.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './account-preflight.js';
import {
  getCachedExecutionAta,
  getCachedExecutionMintAnalysis,
  preloadExecutionPreflight,
  peekExecutionPreflight,
  isExecutionPreflightBackpressure,
} from './execution-preflight-cache.js';
import {
  executableQuoteConstraints,
  isExecutableProviderPair,
  quoteMatchesExecutableProviderPolicy,
} from './executable-route-policy.js';
import { assertIntermediateTokenExecutionPolicy } from './token-analysis.js';
import type { PrefilterTrace } from './prefilter-trace.js';
const SHADOW_CAP_DIAGNOSTIC = Symbol('NON_AUTHORIZING_SHADOW_CAP_DIAGNOSTIC');

export type ExecutablePrefilterStatus =
  | 'EXECUTABLE_CANDIDATE'
  | 'RAW_NOT_POSITIVE'
  | 'UNSUPPORTED_PROVIDER_PAIR'
  | 'DISCOVERY_ONLY_TOKEN_2022'
  | 'TOKEN_POLICY_REJECTED'
  | 'ROUTE_POLICY_REJECTED'
  | 'ECONOMICS_DIVERGED'
  | 'QUOTE_FAILED' | 'ABOVE_LIVE_CAP' | 'RAW_SIGNAL_ENDED' | 'RAW_STALE_BEFORE_PREFILTER'
  | 'PREFILTER_STALE' | 'PREFILTER_RATE_LIMITED' | 'PREFILTER_QUEUE_DEADLINE_EXCEEDED' | 'COALESCED' | 'OBSERVATION_ONLY';

export interface ScannerExecutableCostSnapshot {
  referenceSolPriceUsdc: number;
  estimatedNetworkCostsUsdc: {
    baseNetworkFeeUsdc: number;
    priorityFeeUsdc: number;
  };
}

export interface ExecutablePrefilterResult {
  costs?: EstimatedCostInput;
  trace?: PrefilterTrace;
  estimatedAtaRentUsdc?: number;
  status: ExecutablePrefilterStatus;
  route?: RoundTripResult;
  reason?: string;
}

// Scanner-side policy reads use the scanner RPC. The isolated executor keeps
// its own dedicated connection and repeats every execution-authorizing check.
const scannerPolicyConnection = scannerConnection(CONFIG.rpcUrl, {
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
});

function poolOverlap(a: Quote, b: Quote): boolean | null {
  const aPools = new Set(a.poolIds);
  const bPools = new Set(b.poolIds);
  if (aPools.size === 0 || bPools.size === 0) return null;
  return [...aPools].some((pool) => bPools.has(pool));
}

function scannerExecutionCosts(
  snapshot: ScannerExecutableCostSnapshot,
  missingIntermediateAtaRentLamports: number,
  intermediateMint: string,
): EstimatedCostInput {
  // Live builders currently request a 500k-CU ceiling. Charge its bounded
  // priority cost in the prefilter rather than the scanner's generic 200k-CU
  // assumption. The provider/DEX fees and price impact are already reflected
  // in the two constrained quote outputs.
  const priorityScale = Math.max(1, 500_000 / Math.max(1, CONFIG.assumedComputeUnits));
  const refundableWsolRent = intermediateMint === MINTS.SOL;
  const ataRentUsdc = refundableWsolRent ? 0
    : missingIntermediateAtaRentLamports / LAMPORTS_PER_SOL * snapshot.referenceSolPriceUsdc;
  return {
    baseNetworkFeeUsdc: snapshot.estimatedNetworkCostsUsdc.baseNetworkFeeUsdc,
    priorityFeeUsdc: snapshot.estimatedNetworkCostsUsdc.priorityFeeUsdc * priorityScale,
    ataRentUsdc,
  };
}

export async function prewarmScannerExecutionMints(mints: readonly string[]): Promise<void> {
  const walletAddress = CONFIG.botWalletAddress;
  if (!walletAddress || mints.length === 0) return;
  const wallet = new PublicKey(walletAddress);
  try {
  const cached = [MINTS.USDC,...mints].map((mint)=>peekExecutionPreflight(scannerPolicyConnection,wallet,mint));
  // Observe every existing probe even when another mint misses the cache.
  await Promise.all(cached);
  if(cached.every((entry)=>entry!==undefined))return;
  await runScannerRpc(
    'scanner.prefilter.prewarmExecutionMints',
    () => preloadExecutionPreflight(
      scannerPolicyConnection,
      new PublicKey(walletAddress),
      [MINTS.USDC, ...mints],
    ),
    'RPC_P1_EXECUTABLE_DISCOVERY_SUPPORT',
  );
  } catch (error) {
    // Background-only warmup: leave missing/failed entries unavailable. A later
    // normal refresh may try again; do not retry here or extend cache freshness.
    if (isExecutionPreflightBackpressure(error)) return;
    throw error;
  }
}

export async function classifyIntermediate(mint: string, priority: import('../scanner-rpc-limiter.js').ScannerRpcPriority = 'RPC_P1_EXECUTABLE_DISCOVERY_SUPPORT'): Promise<{
  status: 'SUPPORTED' | 'TOKEN_2022' | 'REJECTED';
  rentLamports: number;
  reason?: string;
}> {
  if (!CONFIG.botWalletAddress) return {
    status: 'REJECTED', rentLamports: 0, reason: 'BOT_WALLET_ADDRESS is required for executable prefiltering',
  };
  const wallet = new PublicKey(CONFIG.botWalletAddress);
  const [analysis, ata] = await (peekExecutionPreflight(scannerPolicyConnection, wallet, mint) ?? runScannerRpc(
    `scanner.prefilter.tokenPolicy.${mint}`,
    () => Promise.all([
      getCachedExecutionMintAnalysis(scannerPolicyConnection, mint),
      getCachedExecutionAta(scannerPolicyConnection, wallet, mint),
    ]),
    priority,
  ));
  if (analysis.programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
    return { status: 'TOKEN_2022', rentLamports: ata.creationRentLamports };
  }
  try {
    if (analysis.programId !== TOKEN_PROGRAM_ID.toBase58()) {
      throw new Error('Intermediate mint is not classic SPL Token');
    }
    assertIntermediateTokenExecutionPolicy(analysis);
    return { status: 'SUPPORTED', rentLamports: ata.exists ? 0 : ata.creationRentLamports };
  } catch (error) {
    return {
      status: 'REJECTED', rentLamports: ata.creationRentLamports,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function constrainedQuote(
  provider: QuoteProviderName,
  inputMint: string,
  outputMint: string,
  amountAtomic: string,
  scheduling?: QuoteParams['scheduling'],
  shadow = false,
): Promise<Quote> {
  const quote = await getProviderQuote(provider, {
    inputMint,
    outputMint,
    amountAtomic,
    slippageBps: CONFIG.slippageBps,
    priority: shadow ? 'DISCOVERY_LOW' : 'EXEC_PREFILTER_HIGH',
    scheduling,
    ...executableQuoteConstraints(provider),
  });
  if (!isFullFillQuote(quote)) throw new Error(`${provider} returned a partial executable-prefilter fill`);
  if (!quoteMatchesExecutableProviderPolicy(quote)) {
    throw new Error(`${provider} quote escaped the audited executor route policy`);
  }
  return quote;
}

function exactPoolEvidence(quote: Quote): string[] {
  return [...new Set(quote.poolIds)];
}

/**
 * Requotes a broad positive observation using the exact provider surface and
 * deterministic min-output propagation used by the live executor.
 */
export async function buildExecutableCandidateFromRaw(
  raw: RoundTripResult,
  costs: ScannerExecutableCostSnapshot,
  options: { diagnosticCapability?: symbol; traceId?: string; trace?: PrefilterTrace; now?: () => number; monotonicNow?: () => number; policy?: typeof classifyIntermediate; quote?: typeof constrainedQuote } = {},
): Promise<ExecutablePrefilterResult> {
  const now = options.now ?? Date.now;
  const mono = options.monotonicNow ?? options.now ?? (() => performance.now());
  const startedMono = mono();
  const trace = options.trace ?? { rawPositiveDetectedAt: now(), rawQuoteEvidenceAt: Math.min(raw.buyQuote.responseTimestamp, raw.sellQuote.responseTimestamp), rawQuoteAgeAtDetectionMs: Math.max(0, now() - Math.min(raw.buyQuote.responseTimestamp, raw.sellQuote.responseTimestamp)), executablePrefilterQueuedAt: now() };
  trace.executablePrefilterStartedAt = now(); trace.rawAgeAtPrefilterStartMs = Math.max(0, now() - trace.rawQuoteEvidenceAt);
  trace.prefilterQueueMs = now() - trace.executablePrefilterQueuedAt;
  const timed = async <T>(stage: 'tokenPolicy' | 'constrainedLeg1' | 'constrainedLeg2', work: () => Promise<T>): Promise<T> => {
    trace[`${stage}StartedAt`] = now();
    const stageMono = mono();
    try { return await work(); } finally { trace[`${stage}FinishedAt`] = now(); trace[`${stage}Ms`] = Math.max(0, mono() - stageMono); }
  };
  const finish = (result: ExecutablePrefilterResult): ExecutablePrefilterResult => {
    trace.prefilterFinishedAt = now(); trace.totalPrefilterMs = Math.max(0, mono() - startedMono);
    return { ...result, trace };
  };
  let releaseDownstream: (() => void) | undefined;
  let downstreamClaim: import('../provider-entitlement.js').EntitlementClaim | undefined;
  const result = await (async (): Promise<ExecutablePrefilterResult> => {
  // Defense in depth for quote-only callers outside scanner admission; no network work above cap.
  if (options.diagnosticCapability !== SHADOW_CAP_DIAGNOSTIC && BigInt(raw.buyQuote.inAmount) > BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC))) return { status: 'ABOVE_LIVE_CAP' };
  if (now() - trace.rawPositiveDetectedAt > CONFIG.opportunityExpiryMs) return { status: 'RAW_SIGNAL_ENDED' };
  if (trace.rawAgeAtPrefilterStartMs! > CONFIG.maxQuoteAgeMs) return { status: 'RAW_STALE_BEFORE_PREFILTER' };
  if (!raw.profit.estimatedNetProfitUsdc.gt(0) || !raw.profit.worstCaseNetProfitUsdc.gt(0)) {
    return { status: 'RAW_NOT_POSITIVE' };
  }
  const buyProvider = raw.buyQuote.provider;
  const sellProvider = raw.sellQuote.provider;
  if (!isExecutableProviderPair(buyProvider, sellProvider)) {
    return { status: 'UNSUPPORTED_PROVIDER_PAIR' };
  }
  const quote = options.quote ?? ((provider, input, output, amount, scheduling) => constrainedQuote(provider, input, output, amount, scheduling, options.diagnosticCapability === SHADOW_CAP_DIAGNOSTIC));
  const windowMs = [buyProvider, sellProvider].includes('raptor') ? CONFIG.raptorExecutionQuoteAgeMs : CONFIG.maxExecutionQuoteAgeMs;
  let parentDeadline: number;
  try { parentDeadline = workflowParentDeadline(performance.now(), now(), trace.rawQuoteEvidenceAt, windowMs); }
  catch { return { status: 'PREFILTER_STALE', reason: 'INVALID_OR_FUTURE_MARKET_EVIDENCE' }; }
  const scheduling: NonNullable<QuoteParams['scheduling']> = { deadlineMono: parentDeadline, traceId: options.traceId };
  const admission = (provider: QuoteProviderName) => provider === 'jupiter' ? jupiterAdmission : provider === 'raptor' ? raptorAdmission : undefined;
  const firstGovernor = admission(buyProvider), secondGovernor = admission(sellProvider);
  // Reserve 20ms for local policy/economics and 25ms for P0 delivery, never extra freshness.
  const localReserveMs = 45;
  if (!options.quote && firstGovernor && secondGovernor) {
    const first = firstGovernor.forecast(windowMs);
    const second = secondGovernor.forecast(windowMs, first.predictedCompletionMono);
    const projected = projectWorkflow(parentDeadline, first, second, localReserveMs);
    recordWorkflowProjection(options.traceId, 'BEFORE_LEG1', projected);
    if (!projected.feasible) return { status: 'PREFILTER_QUEUE_DEADLINE_EXCEEDED', reason: projected.cause };
    scheduling.deadlineMono = projected.leg1Deadline;
    if (options.diagnosticCapability !== SHADOW_CAP_DIAGNOSTIC) {
      try {
        downstreamClaim = secondGovernor.reserveOwnedWorkflow(projected.leg2Deadline,first.predictedCompletionMono,second.serviceMs,options.traceId??raw.buyQuote.id,
          {inputMint:raw.buyQuote.outputMint,outputMint:MINTS.USDC,amountAtomic:'UNBOUND',slippageBps:CONFIG.slippageBps,priority:'EXEC_PREFILTER_HIGH',...executableQuoteConstraints(sellProvider)});
        releaseDownstream=()=>secondGovernor.releaseOwnedWorkflow(downstreamClaim!);
      }
      catch { return { status: 'PREFILTER_QUEUE_DEADLINE_EXCEEDED', reason: 'DOWNSTREAM_RESERVATION_UNAVAILABLE' }; }
    }
  }
  const tokenPolicyPromise = timed('tokenPolicy', () => scannerRpcContext.run({label:'prefilter.tokenPolicy',priority:'RPC_P0_EXECUTION_CRITICAL',traceId:options.traceId,deadlineMono:scheduling.deadlineMono,liveDependency:true},()=>(options.policy ?? classifyIntermediate)(raw.buyQuote.outputMint,'RPC_P0_EXECUTION_CRITICAL')));
  const buyPromise = timed('constrainedLeg1', () => quote(buyProvider, MINTS.USDC, raw.buyQuote.outputMint, raw.buyQuote.inAmount, scheduling));

  let buy: Quote;
  try {
    buy = await buyPromise;
    if (now() - buy.responseTimestamp > CONFIG.maxQuoteAgeMs) return { status: 'PREFILTER_STALE' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const policy = /escaped the audited|partial executable|same pool|propagation|exactly one auditable pool/i.test(reason);
    return { status: /QUEUE_DEADLINE|QUEUE_CANCELLED/.test(reason) ? 'PREFILTER_QUEUE_DEADLINE_EXCEEDED' : /QUOTE_RESULT_STALE/.test(reason) ? 'PREFILTER_STALE' : /429|backpressure|cooldown|capacity|rate.?limit|OVERFLOW/i.test(reason) ? 'PREFILTER_RATE_LIMITED' : policy ? 'ROUTE_POLICY_REJECTED' : 'QUOTE_FAILED', reason: providerFailureReason(error) };
  }
    scheduling.deadlineMono = parentDeadline - (options.quote ? 0 : localReserveMs);
    if (!options.quote && secondGovernor) {
      const second = secondGovernor.forecast(windowMs);
      const completedAt = performance.now();
      recordWorkflowProjection(options.traceId, 'BEFORE_LEG2', projectWorkflow(parentDeadline,
        { provider: buyProvider, serviceMs: 0, predictedStartMono: completedAt, predictedCompletionMono: completedAt, cooldownUntilMono: 0 },
        second, localReserveMs)); // Leg 1 is complete: its remaining service is zero.
      if (second.predictedCompletionMono > scheduling.deadlineMono) return { status: 'PREFILTER_QUEUE_DEADLINE_EXCEEDED',
        reason: second.cooldownUntilMono > scheduling.deadlineMono ? 'PROVIDER_RATE_LIMIT_OR_MANDATORY_COOLDOWN' : 'PROVIDER_SERVICE_TOO_SLOW_FOR_REMAINING_BUDGET' };
    }
    scheduling.entitlement=downstreamClaim;
    const sellPromise = timed('constrainedLeg2', () => quote(
      sellProvider, raw.buyQuote.outputMint, MINTS.USDC, buy.otherAmountThreshold, scheduling,
    ));

    const [policyResult, sellResult] = await Promise.allSettled([tokenPolicyPromise, sellPromise]);

    let tokenPolicy: Awaited<ReturnType<typeof classifyIntermediate>>;
    try { if (policyResult.status === 'rejected') throw policyResult.reason; tokenPolicy = policyResult.value; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: /429|backpressure|cooldown|capacity|rate.?limit/i.test(reason) ? 'PREFILTER_RATE_LIMITED' : 'QUOTE_FAILED', reason: 'TOKEN_POLICY:' + providerFailureReason(error) };
    }
    if (tokenPolicy.status === 'TOKEN_2022') return { status: 'DISCOVERY_ONLY_TOKEN_2022' };
    if (tokenPolicy.status !== 'SUPPORTED') return { status: 'TOKEN_POLICY_REJECTED', reason: tokenPolicy.reason };

    try {
      if (sellResult.status === 'rejected') throw sellResult.reason;
      const sell = sellResult.value;
    if (!options.quote && performance.now() > parentDeadline) return { status: 'PREFILTER_STALE', reason: 'PARENT_WORKFLOW_DEADLINE_EXCEEDED' };
    if (!isFullFillQuote(buy) || !isFullFillQuote(sell) || !quoteMatchesExecutableProviderPolicy(buy) || !quoteMatchesExecutableProviderPolicy(sell)) return { status: 'ROUTE_POLICY_REJECTED', reason: 'Constrained quotes escaped audited route policy' };
    if (buy.inputMint !== MINTS.USDC || buy.outputMint !== raw.buyQuote.outputMint || buy.inAmount !== raw.buyQuote.inAmount
      || sell.inputMint !== buy.outputMint || sell.outputMint !== MINTS.USDC) return { status: 'ROUTE_POLICY_REJECTED', reason: 'Constrained mint/input path mismatch' };
    if (sell.inAmount !== buy.otherAmountThreshold) {
      return { status: 'ROUTE_POLICY_REJECTED', reason: 'Executable prefilter lost exact minimum-output propagation' };
    }
    const buyPools = exactPoolEvidence(buy);
    const sellPools = exactPoolEvidence(sell);
    if (buyPools.length !== 1 || sellPools.length !== 1) {
      return {
        status: 'ROUTE_POLICY_REJECTED',
        reason: `Executable prefilter requires exactly one auditable pool per leg; observed ${buyPools.length}/${sellPools.length}`,
      };
    }
    const quoteSkewMs = Math.abs(sell.responseTimestamp - buy.responseTimestamp);
    const stale = quoteSkewMs > CONFIG.maxQuoteAgeMs || now() - Math.min(buy.responseTimestamp, sell.responseTimestamp) > CONFIG.maxQuoteAgeMs;
    if (stale) return { status: 'PREFILTER_STALE', reason: 'Constrained quote evidence exceeded scanner freshness' };
    const liquidityOverlap = poolOverlap(buy, sell);
    if (liquidityOverlap === true) {
      return { status: 'ROUTE_POLICY_REJECTED', reason: 'Executable legs resolve to the same pool' };
    }
    const profit = calculateEstimatedRoundTripProfit(
      fromAtomic(buy.inAmount, DECIMALS.USDC).toString(),
      sell,
      scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint),
      'conservative',
    );
    const category = categorizeProfit(profit);
    const validationTier = classifyValidationTier(category, stale, liquidityOverlap, profit);
    const route: RoundTripResult = {
      buyQuote: buy,
      sellQuote: sell,
      classification: classifyRoute(buy, sell),
      liquidityOverlap,
      quoteSkewMs,
      stale,
      profit,
      category,
      validationTier,
      opportunityScope: 'EXECUTABLE_CANDIDATE',
    };
    if (validationTier !== 'CONSERVATIVE_CANDIDATE'
      || !profit.estimatedNetProfitUsdc.gt(0)
      || !profit.worstCaseNetProfitUsdc.gt(0)) {
      return { status: 'ECONOMICS_DIVERGED', route, costs: scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint), estimatedAtaRentUsdc: Number(scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint).ataRentUsdc), reason: 'Executor-constrained route is not conservatively profitable' };
    }
    return { status: 'EXECUTABLE_CANDIDATE', route, costs: scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint), estimatedAtaRentUsdc: Number(scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint).ataRentUsdc) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const policy = /escaped the audited|partial executable|same pool|propagation|exactly one auditable pool/i.test(reason);
    return { status: /QUEUE_DEADLINE|QUEUE_CANCELLED/.test(reason) ? 'PREFILTER_QUEUE_DEADLINE_EXCEEDED' : /QUOTE_RESULT_STALE/.test(reason) ? 'PREFILTER_STALE' : /429|backpressure|cooldown|capacity|rate.?limit|OVERFLOW/i.test(reason) ? 'PREFILTER_RATE_LIMITED' : policy ? 'ROUTE_POLICY_REJECTED' : 'QUOTE_FAILED', reason: providerFailureReason(error) };
  }
  })().finally(() => releaseDownstream?.());
  return finish(result);
}

/** Diagnostic output cannot be handed off: it has no route, instructions, DTO or authority. */
export async function evaluateAboveCapShadow(raw: RoundTripResult, costs: ScannerExecutableCostSnapshot) {
  const result = await buildExecutableCandidateFromRaw(raw, costs, { diagnosticCapability: SHADOW_CAP_DIAGNOSTIC });
  return { status: result.status === 'EXECUTABLE_CANDIDATE' ? 'SHADOW_CONSTRAINED_POSITIVE' : result.status,
    expectedNet: result.route?.profit.estimatedNetProfitUsdc.toFixed(6), conservativeNet: result.route?.profit.worstCaseNetProfitUsdc.toFixed(6), costs: result.costs,
    authoritative: false as const, p0Allowed: false as const };
}
export async function buildExecutableFastLane(
  buy: Quote,
  sellProvider: QuoteProviderName,
  costs: ScannerExecutableCostSnapshot,
  options: { traceId?: string; now?: () => number; monotonicNow?: () => number; policy?: typeof classifyIntermediate; quote?: typeof constrainedQuote } = {},
): Promise<ExecutablePrefilterResult> {
  const now = options.now ?? Date.now;
  const mono = options.monotonicNow ?? options.now ?? (() => performance.now());
  const startedMono = mono();
  const trace: PrefilterTrace = { rawPositiveDetectedAt: buy.responseTimestamp, rawQuoteEvidenceAt: buy.responseTimestamp, rawQuoteAgeAtDetectionMs: 0, executablePrefilterQueuedAt: now(), executablePrefilterStartedAt: now(), rawAgeAtPrefilterStartMs: Math.max(0, now() - buy.responseTimestamp), prefilterQueueMs: 0 };
  
  const timed = async <T>(stage: 'tokenPolicy' | 'constrainedLeg1' | 'constrainedLeg2', work: () => Promise<T>): Promise<T> => {
    trace[`${stage}StartedAt`] = now();
    const stageMono = mono();
    try { return await work(); } finally { trace[`${stage}FinishedAt`] = now(); trace[`${stage}Ms`] = Math.max(0, mono() - stageMono); }
  };
  const finish = (result: ExecutablePrefilterResult): ExecutablePrefilterResult => {
    trace.prefilterFinishedAt = now(); trace.totalPrefilterMs = Math.max(0, mono() - startedMono);
    return { ...result, trace };
  };

  if (BigInt(buy.inAmount) > BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC))) return finish({ status: 'ABOVE_LIVE_CAP' });
  const buyProvider = buy.provider as QuoteProviderName;
  const quote = options.quote ?? ((provider, input, output, amount, scheduling) => constrainedQuote(provider, input, output, amount, scheduling, false));
  const windowMs = [buyProvider, sellProvider].includes('raptor') ? CONFIG.raptorExecutionQuoteAgeMs : CONFIG.maxExecutionQuoteAgeMs;
  let parentDeadline: number;
  try { parentDeadline = workflowParentDeadline(performance.now(), now(), buy.responseTimestamp, windowMs); }
  catch { return finish({ status: 'PREFILTER_STALE', reason: 'INVALID_OR_FUTURE_MARKET_EVIDENCE' }); }
  
  const scheduling: NonNullable<QuoteParams['scheduling']> = { deadlineMono: parentDeadline, traceId: options.traceId };
  const admission = (provider: QuoteProviderName) => provider === 'jupiter' ? jupiterAdmission : provider === 'raptor' ? raptorAdmission : undefined;
  const secondGovernor = admission(sellProvider);
  const localReserveMs = 45;
  let releaseDownstream: (() => void) | undefined;
  let downstreamClaim: import('../provider-entitlement.js').EntitlementClaim | undefined;

  if (!options.quote && secondGovernor) {
      const second = secondGovernor.forecast(windowMs);
      const completedAt = performance.now();
      recordWorkflowProjection(options.traceId, 'BEFORE_LEG2', projectWorkflow(parentDeadline,
        { provider: buyProvider, serviceMs: 0, predictedStartMono: completedAt, predictedCompletionMono: completedAt, cooldownUntilMono: 0 },
        second, localReserveMs)); // Leg 1 is complete
      if (second.predictedCompletionMono > scheduling.deadlineMono) return finish({ status: 'PREFILTER_QUEUE_DEADLINE_EXCEEDED',
        reason: second.cooldownUntilMono > scheduling.deadlineMono ? 'PROVIDER_RATE_LIMIT_OR_MANDATORY_COOLDOWN' : 'PROVIDER_SERVICE_TOO_SLOW_FOR_REMAINING_BUDGET' });
        
      try {
        downstreamClaim = secondGovernor.reserveOwnedWorkflow(scheduling.deadlineMono,completedAt,second.serviceMs,options.traceId??buy.id,
          {inputMint:buy.outputMint,outputMint:MINTS.USDC,amountAtomic:'UNBOUND',slippageBps:CONFIG.slippageBps,priority:'EXEC_PREFILTER_HIGH',...executableQuoteConstraints(sellProvider)});
        releaseDownstream=()=>secondGovernor.releaseOwnedWorkflow(downstreamClaim!);
      }
      catch { return finish({ status: 'PREFILTER_QUEUE_DEADLINE_EXCEEDED', reason: 'DOWNSTREAM_RESERVATION_UNAVAILABLE' }); }
  }

  const [policyResult, sellResult] = await Promise.allSettled([
    timed('tokenPolicy', () => scannerRpcContext.run({label:'prefilter.tokenPolicy',priority:'RPC_P0_EXECUTION_CRITICAL',traceId:options.traceId,deadlineMono:scheduling.deadlineMono,liveDependency:true},()=>(options.policy ?? classifyIntermediate)(buy.outputMint,'RPC_P0_EXECUTION_CRITICAL'))),
    (async () => {
       scheduling.deadlineMono = parentDeadline - (options.quote ? 0 : localReserveMs);
       scheduling.entitlement = downstreamClaim;
       return timed('constrainedLeg2', () => quote(sellProvider, buy.outputMint, MINTS.USDC, buy.otherAmountThreshold, scheduling));
    })()
  ]).finally(() => releaseDownstream?.());

  let tokenPolicy: Awaited<ReturnType<typeof classifyIntermediate>>;
  try { if (policyResult.status === 'rejected') throw policyResult.reason; tokenPolicy = policyResult.value; }
  catch (error) { return finish({ status: 'QUOTE_FAILED', reason: 'TOKEN_POLICY:' + providerFailureReason(error) }); }
  
  if (tokenPolicy.status === 'TOKEN_2022') return finish({ status: 'DISCOVERY_ONLY_TOKEN_2022' });
  if (tokenPolicy.status !== 'SUPPORTED') return finish({ status: 'TOKEN_POLICY_REJECTED', reason: tokenPolicy.reason });

  try {
    if (sellResult.status === 'rejected') throw sellResult.reason;
    const sell = sellResult.value;
    if (!options.quote && performance.now() > parentDeadline) return finish({ status: 'PREFILTER_STALE', reason: 'PARENT_WORKFLOW_DEADLINE_EXCEEDED' });
    if (!isFullFillQuote(sell) || !quoteMatchesExecutableProviderPolicy(sell)) return finish({ status: 'ROUTE_POLICY_REJECTED', reason: 'Constrained quotes escaped audited route policy' });
    if (sell.inputMint !== buy.outputMint || sell.outputMint !== MINTS.USDC || sell.inAmount !== buy.otherAmountThreshold) return finish({ status: 'ROUTE_POLICY_REJECTED', reason: 'Executable prefilter lost exact minimum-output propagation' });
    const buyPools = exactPoolEvidence(buy); const sellPools = exactPoolEvidence(sell);
    if (buyPools.length !== 1 || sellPools.length !== 1) return finish({ status: 'ROUTE_POLICY_REJECTED', reason: `Executable prefilter requires exactly one auditable pool per leg` });
    
    const quoteSkewMs = Math.abs(sell.responseTimestamp - buy.responseTimestamp);
    const stale = quoteSkewMs > CONFIG.maxQuoteAgeMs || now() - Math.min(buy.responseTimestamp, sell.responseTimestamp) > CONFIG.maxQuoteAgeMs;
    if (stale) return finish({ status: 'PREFILTER_STALE', reason: 'Constrained quote evidence exceeded scanner freshness' });
    
    const liquidityOverlap = poolOverlap(buy, sell);
    if (liquidityOverlap === true) return finish({ status: 'ROUTE_POLICY_REJECTED', reason: 'Executable legs resolve to the same pool' });
    
    const profit = calculateEstimatedRoundTripProfit(fromAtomic(buy.inAmount, DECIMALS.USDC).toString(), sell, scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint), 'conservative');
    const category = categorizeProfit(profit);
    const validationTier = classifyValidationTier(category, stale, liquidityOverlap, profit);
    const route: RoundTripResult = { buyQuote: buy, sellQuote: sell, classification: classifyRoute(buy, sell), liquidityOverlap, quoteSkewMs, stale, profit, category, validationTier, opportunityScope: 'EXECUTABLE_CANDIDATE' };
    
    if (validationTier !== 'CONSERVATIVE_CANDIDATE' || !profit.estimatedNetProfitUsdc.gt(0) || !profit.worstCaseNetProfitUsdc.gt(0)) {
      return finish({ status: 'ECONOMICS_DIVERGED', route, costs: scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint), estimatedAtaRentUsdc: Number(scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint).ataRentUsdc), reason: 'Executor-constrained route is not conservatively profitable' });
    }
    return finish({ status: 'EXECUTABLE_CANDIDATE', route, costs: scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint), estimatedAtaRentUsdc: Number(scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint).ataRentUsdc) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const policy = /escaped the audited|partial executable|same pool|propagation|exactly one auditable pool/i.test(reason);
    return finish({ status: /QUEUE_DEADLINE|QUEUE_CANCELLED/.test(reason) ? 'PREFILTER_QUEUE_DEADLINE_EXCEEDED' : /QUOTE_RESULT_STALE/.test(reason) ? 'PREFILTER_STALE' : /429|backpressure|cooldown|capacity|rate.?limit|OVERFLOW/i.test(reason) ? 'PREFILTER_RATE_LIMITED' : policy ? 'ROUTE_POLICY_REJECTED' : 'QUOTE_FAILED', reason: providerFailureReason(error) });
  }
}

import crypto from 'crypto';
import { prioritizeDirectMarketPair } from './direct-market-stream.js';
import { ScannerFirstLegBulkheads, ScannerBackgroundLane } from './scanner-bulkheads.js';
import { CONFIG, DECIMALS, MINTS } from './config.js';
import {
  getProviderQuote,
  getEnabledProviders,
  getQuotesFromProviders,
  getQuotesFromEnabledProviders,
  type ProviderQuoteResult,
} from './aggregators/index.js';
import { getRouteLabels, isFullFillQuote, type Quote, type QuoteProvider } from './aggregators/types.js';
import { printQuoteComparison, successfulQuotes } from './comparison.js';
import { calculateEstimatedRoundTripProfit } from './profit.js';
import { checkRpc, estimateNetworkFeeBreakdown, lamportsToSol } from './solana.js';
import { scanOrcaCrossPoolCycles, orcaCrossPoolStats } from './orca-cross-pool.js';
import { OrcaHandoffInbox } from './execution/handoff-inbox.js';
import { AggregatorHandoffInbox } from './execution/aggregator-handoff-inbox.js';
import type { AggregatorAtomicHandoff } from './execution/aggregator-handoff-dto.js';
import {
  isAuditedAggregatorHandoffRoute,
  isAuditedMixedHandoffRoute,
  isFreshPositiveAuditedExecutionSignal,
} from './execution/scanner-handoff-eligibility.js';
import { aggregatorHandoffIdentity, quoteRouteEvidence, routeEvidenceFingerprint } from './execution/aggregator-handoff-dto.js';
import { logExecutionStage } from './execution/execution-diagnostics.js';
import {
  buildExecutableCandidateFromRaw,
  prewarmScannerExecutionMints,
  type ScannerExecutableCostSnapshot,
} from './execution/scanner-executable-prefilter.js';
import {
  expireOpportunitiesByIdentity,
  insertHealth,
  insertOpportunity,
  insertPaperTrade,
  insertQuote,
  insertScan,
  insertTradeEvent,
  updatePaperTrade,
  type OpportunityRow,
  type QuoteRow,
  type ScanRow,
} from './db.js';
import { getDynamicTokens } from './dynamic-token-universe.js';
import { exact, fromAtomic, toAtomic } from './math.js';
import { type Opportunity, RiskEngine } from './risk.js';
import {
  DisabledPaperExecutionEngine,
  type ExecutionEngine,
  PaperExecutionEngine,
} from './engine.js';
import { log } from './logger.js';
import {
  bestEligibleRoute,
  bestObservableRoute,
  buildRoundTripMatrix,
  printRoundTripMatrix,
  type RoundTripResult,
} from './routes.js';
import { printProviderHealth } from './provider-health.js';
import { cycleForPair, getScanCycles, type ScanCycle } from './token-universe.js';
import {
  expireInactive,
  markConfirmed,
  observeOpportunity,
  opportunityMetrics,
} from './opportunity-lifecycle.js';

const executionEngine: ExecutionEngine = CONFIG.executionMode === 'paper'
  ? new PaperExecutionEngine()
  : new DisabledPaperExecutionEngine();

const firstLegBulkheads = new ScannerFirstLegBulkheads(getQuotesFromProviders);
const directBackgroundLane = new ScannerBackgroundLane(4);

export function getExecutionEngine(): ExecutionEngine {
  return executionEngine;
}

let consecutiveFailures = 0;
let circuitBreakerOpen = false;
let circuitBreakerCooldownUntil = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
let tradeSizeCursor = 0;
const cycleLastScheduledAt = new Map<string, number>();
let lastProviderHealthPrintedAt = 0;

function nextScanCycle(preferred?: ScanCycle): ScanCycle | undefined {
  if (preferred) {
    cycleLastScheduledAt.set(preferred.key, Date.now());
    return preferred;
  }
  const cycles = getScanCycles();
  if (cycles.length === 0) return undefined;
  const now = Date.now();
  const weight = (cycle: ScanCycle): number => {
    if (cycle.tier === 'HOT') return CONFIG.hotCycleWeight;
    if (cycle.tier === 'WARM') return CONFIG.warmCycleWeight;
    if (cycle.tier === 'DISCOVERY') return CONFIG.discoveryCycleWeight;
    return CONFIG.coreCycleWeight;
  };
  // A HOT route becomes eligible again much sooner than WARM/CORE routes,
  // while every cycle still eventually wins as its idle age increases.
  const cycle = cycles.reduce((best, candidate) => {
    const bestAge = now - (cycleLastScheduledAt.get(best.key) ?? 0);
    const candidateAge = now - (cycleLastScheduledAt.get(candidate.key) ?? 0);
    return candidateAge * weight(candidate) > bestAge * weight(best) ? candidate : best;
  });
  cycleLastScheduledAt.set(cycle.key, now);
  return cycle;
}

function nextTradeSizes(): number[] {
  const sizes = CONFIG.tradeSizesUsdc;
  if (sizes.length === 0) return [];
  const count = Math.max(1, Math.min(CONFIG.tradeSizesPerScan, sizes.length));
  const selected = Array.from(
    { length: count },
    (_, offset) => sizes[(tradeSizeCursor + offset) % sizes.length]!,
  );
  tradeSizeCursor = (tradeSizeCursor + count) % sizes.length;
  return selected;
}

function quoteToRow(q: Quote, scanId: string, leg: string): QuoteRow {
  return {
    id: q.id,
    scanId,
    leg,
    provider: q.provider,
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    otherAmountThreshold: q.otherAmountThreshold,
    priceImpactPct: q.priceImpactPct ?? '',
    slippageBps: q.slippageBps,
    platformFeeAmount: q.platformFee?.amount ?? null,
    platformFeeBps: q.platformFee?.feeBps ?? null,
    routeLabels: JSON.stringify(getRouteLabels(q)),
    rawResponse: q.rawResponse,
    requestTimestamp: q.requestTimestamp.toString(),
    responseTimestamp: q.responseTimestamp.toString(),
    latencyMs: q.latencyMs,
  };
}

function bestByOutput(quotes: Quote[]): Quote {
  return [...quotes].sort((a, b) => exact(b.outAmount).cmp(a.outAmount))[0]!;
}

/**
 * In-memory P0 handoff path for the isolated executor. The durable inbox is
 * still written immediately afterward as a crash/restart fallback.
 */
const liveExecutionHandoffListeners = new Set<(candidate: AggregatorAtomicHandoff) => void>();
const lastLiveHandoffByRoute = new Map<string, { evidenceAt: number; publishedAt: number }>();
const LIVE_HANDOFF_RETRY_INTERVAL_MS = 500;

export function subscribeLiveExecutionHandoffs(
  listener: (candidate: AggregatorAtomicHandoff) => void,
): () => void {
  liveExecutionHandoffListeners.add(listener);
  return () => liveExecutionHandoffListeners.delete(listener);
}

function notifyLiveExecutionHandoff(candidate: AggregatorAtomicHandoff): void {
  for (const listener of liveExecutionHandoffListeners) {
    try { listener(candidate); } catch (error) {
      log.warn('Live execution handoff listener failed; durable inbox remains available', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function publishSupportedAggregatorHandoff(
  route: RoundTripResult,
  opportunityId: string,
  detectedAt: number,
  confidenceScore?: number,
): Promise<void> {
  const { buyQuote, sellQuote, profit } = route;
  if (!isAuditedAggregatorHandoffRoute(route)
    && !isAuditedMixedHandoffRoute(route)
    && !isFreshPositiveAuditedExecutionSignal(route)) return;
  const firstLiveCapAtomic = BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC));
  if (BigInt(buyQuote.inAmount) > firstLiveCapAtomic) {
    // This is still a real scanner observation, but publishing an unexecutable
    // amount only pollutes the live journal with predictable cap rejections.
    log.debug('Skipping live handoff above FIRST_LIVE_MAX_INPUT_USDC', {
      providerRoute: `${buyQuote.provider}->${sellQuote.provider}`,
      inputAtomic: buyQuote.inAmount,
      capAtomic: firstLiveCapAtomic.toString(),
    });
    return;
  }

  const providers: AggregatorAtomicHandoff['providers'] = [buyQuote.provider, sellQuote.provider];
  const routeEvidence = quoteRouteEvidence(buyQuote, sellQuote);

  const dto: AggregatorAtomicHandoff = {
    schema: 'sol-arb.aggregator-execution-handoff',
    version: 2,
    routeEvidence,
    routeFingerprint: routeEvidenceFingerprint(routeEvidence),
    opportunityId,
    detectedAt,
    opportunityType: `${buyQuote.provider.toUpperCase()}_${sellQuote.provider.toUpperCase()}_ATOMIC`,
    providers,
    inputMint: MINTS.USDC,
    intermediateMint: buyQuote.outputMint,
    outputMint: MINTS.USDC,
    proposedInputAmount: buyQuote.inAmount,
    scannerPools: [buyQuote.poolIds, sellQuote.poolIds],
    scannerObservation: {
      expectedOutputAmount: sellQuote.outAmount,
      minimumOutputAmount: sellQuote.otherAmountThreshold,
      projectedNetAmount: profit.estimatedNetProfitUsdc.mul(10 ** DECIMALS.USDC).toDecimalPlaces(0).toFixed(0),
      roiBps: profit.profitBps.toDecimalPlaces(0).toFixed(0),
      quoteTimestamp: Math.min(buyQuote.responseTimestamp, sellQuote.responseTimestamp),
      confidenceScore,
    },
  };
  const identity = aggregatorHandoffIdentity(dto);
  logExecutionStage(identity, 'FOUND', detectedAt, {
    providers: dto.providers, scannerExpectedNetAtomic: dto.scannerObservation.projectedNetAmount,
  });
  // IPC delivery is intentionally before durable filesystem persistence so an
  // already-running isolated executor can begin its independent fresh quote
  // immediately. The DTO contains no instruction bytes or signer material.
  logExecutionStage(identity, 'P0_HANDOFF', detectedAt, {
    providers: dto.providers,
    scannerEvidenceAt: dto.scannerObservation.quoteTimestamp,
    p0PublishedAt: Date.now(),
  });
  notifyLiveExecutionHandoff(dto);
  // Durable persistence is a crash/restart fallback. It must never hold the
  // scanner call stack after the in-memory P0 delivery has reached the child.
  void new AggregatorHandoffInbox().publish(dto).catch((error: unknown) => {
    log.warn('Durable aggregator handoff persistence failed after P0 delivery', {
      identity,
      reason: error instanceof Error ? error.message : String(error),
    });
  });
  recordHandoff(route);
  log.warn('Published strict aggregator atomic handoff for independent executor validation', {
    opportunityId,
    providers: dto.providers,
    intermediateMint: dto.intermediateMint,
    inputAtomic: buyQuote.inAmount,
  });
}

function shouldPublishFreshLiveHandoff(route: RoundTripResult, now = Date.now()): boolean {
  const key = [
    route.buyQuote.provider, route.sellQuote.provider,
    route.buyQuote.inputMint, route.buyQuote.outputMint, route.sellQuote.outputMint,
    route.buyQuote.inAmount,
  ].join(':');
  const evidenceAt = Math.min(route.buyQuote.responseTimestamp, route.sellQuote.responseTimestamp);
  const previous = lastLiveHandoffByRoute.get(key);
  if (previous && evidenceAt <= previous.evidenceAt) return false;
  if (previous && now - previous.publishedAt < LIVE_HANDOFF_RETRY_INTERVAL_MS) return false;
  lastLiveHandoffByRoute.set(key, { evidenceAt, publishedAt: now });
  return true;
}

function calculateConfidence(
  route: RoundTripResult,
  tradeSize: number,
): number {
  const { buyQuote, sellQuote } = route;
  const expectedProfit = route.profit.estimatedNetProfitUsdc.toNumber();
  let score = 55;
  const totalLatency = buyQuote.latencyMs + sellQuote.latencyMs;
  if (totalLatency < 750) score += 15;
  else if (totalLatency < 2000) score += 8;
  else score -= 10;

  const buyImpact = buyQuote.priceImpactPct === undefined ? undefined : Math.abs(Number(buyQuote.priceImpactPct));
  const sellImpact = sellQuote.priceImpactPct === undefined ? undefined : Math.abs(Number(sellQuote.priceImpactPct));
  if (buyImpact !== undefined && sellImpact !== undefined) {
    if (buyImpact < 0.1 && sellImpact < 0.1) score += 10;
    else if (buyImpact > 1 || sellImpact > 1) score -= 15;
  }

  const roi = tradeSize > 0 ? (expectedProfit / tradeSize) * 100 : 0;
  if (roi > 1) score += 10;
  else if (roi > 0.1) score += 8;
  else if (roi > 0) score += 5;
  else score -= 10;

  if (buyQuote.routePlan.length <= 2 && sellQuote.routePlan.length <= 2) score += 5;
  else if (buyQuote.routePlan.length > 4 || sellQuote.routePlan.length > 4) score -= 5;
  if (route.stale) score -= 25;
  else score += 5;
  if (route.liquidityOverlap === true) score -= 30;
  else if (route.liquidityOverlap === false) score += 5;
  else score -= 5;
  return Math.max(0, Math.min(100, score));
}

let cachedSolPriceUsdc = 150;
let lastSolPriceFetch = 0;

async function getReferenceSolPrice(): Promise<number> {
  if (!CONFIG.referencePriceEnabled) return cachedSolPriceUsdc;
  if (Date.now() - lastSolPriceFetch < 60_000) return cachedSolPriceUsdc;

  try {
    const results = await getQuotesFromEnabledProviders({
      inputMint: MINTS.SOL,
      outputMint: MINTS.USDC,
      amountAtomic: toAtomic(0.01, DECIMALS.SOL),
      slippageBps: CONFIG.slippageBps,
      priority: 'LOW',
    });
    const quotes = successfulQuotes(results);
    if (quotes.length === 0) throw new Error('No provider returned a reference quote');
    const quote = bestByOutput(quotes);
    cachedSolPriceUsdc = fromAtomic(quote.outAmount, DECIMALS.USDC).div(0.01).toNumber();
    lastSolPriceFetch = Date.now();
  } catch {
    log.warn('Could not fetch reference SOL price; using cached estimate', { cachedSolPriceUsdc });
  }
  return cachedSolPriceUsdc;
}

type ScannerCostSnapshot = {
  referenceSolPriceUsdc: number;
  estimatedNetworkCostsUsdc: { baseNetworkFeeUsdc: number; priorityFeeUsdc: number };
};
let scannerCostSnapshot: { value: ScannerCostSnapshot; expiresAt: number } | null = null;
let scannerCostSnapshotPending: Promise<ScannerCostSnapshot> | null = null;

/** Scanner-only estimated costs are cached briefly; execution continues to do
 * its own fresh cost/profitability validation. */
async function getScannerCostSnapshot(): Promise<ScannerCostSnapshot> {
  if (scannerCostSnapshot && scannerCostSnapshot.expiresAt > Date.now()) return scannerCostSnapshot.value;
  if (scannerCostSnapshotPending) return scannerCostSnapshotPending;
  scannerCostSnapshotPending = Promise.all([
    getReferenceSolPrice(),
    estimateNetworkFeeBreakdown(),
  ]).then(([referenceSolPriceUsdc, networkFee]) => {
    const value: ScannerCostSnapshot = {
      referenceSolPriceUsdc,
      estimatedNetworkCostsUsdc: {
        baseNetworkFeeUsdc: lamportsToSol(networkFee.baseFeeLamports) * referenceSolPriceUsdc,
        priorityFeeUsdc: lamportsToSol(networkFee.priorityFeeLamports) * referenceSolPriceUsdc,
      },
    };
    scannerCostSnapshot = { value, expiresAt: Date.now() + 10_000 };
    return value;
  }).finally(() => { scannerCostSnapshotPending = null; });
  return scannerCostSnapshotPending;
}

async function findExecutableCandidates(
  rawRoutes: RoundTripResult[],
  costs: ScannerExecutableCostSnapshot,
): Promise<RoundTripResult[]> {
  const positive = rawRoutes.filter((route) =>
    route.profit.estimatedNetProfitUsdc.gt(0) && route.profit.worstCaseNetProfitUsdc.gt(0));
  const capAtomic = BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC));
  const results = await Promise.all(positive.map(async (raw) => {
    if (raw.opportunityScope === 'DISCOVERY_ONLY_TOKEN_2022') return undefined;
    if (BigInt(raw.buyQuote.inAmount) > capAtomic) return undefined;
    const result = await buildExecutableCandidateFromRaw(raw, costs);
    if (result.status === 'DISCOVERY_ONLY_TOKEN_2022') {
      raw.opportunityScope = 'DISCOVERY_ONLY_TOKEN_2022';
      scannerStats.executionPrefilter.token2022DiscoveryOnly++;
      return undefined;
    }
    if (result.status === 'ECONOMICS_DIVERGED') {
      scannerStats.executionPrefilter.routeEconomicsDiverged++;
      log.info('Raw market spread removed by executor-constrained prefilter', {
        providers: `${raw.buyQuote.provider}->${raw.sellQuote.provider}`,
        intermediateMint: raw.buyQuote.outputMint,
        rawWorstCaseUsdc: raw.profit.worstCaseNetProfitUsdc.toFixed(6),
        constrainedWorstCaseUsdc: result.route?.profit.worstCaseNetProfitUsdc.toFixed(6),
      });
      return undefined;
    }
    if (result.status === 'TOKEN_POLICY_REJECTED') {
      scannerStats.executionPrefilter.tokenPolicyRejected++;
      return undefined;
    }
    if (result.status === 'ROUTE_POLICY_REJECTED') {
      scannerStats.executionPrefilter.routePolicyRejected++;
      return undefined;
    }
    if (result.status === 'QUOTE_FAILED') {
      scannerStats.executionPrefilter.quoteFailures++;
      log.debug('Executable route prefilter unavailable; raw discovery retained', {
        providers: `${raw.buyQuote.provider}->${raw.sellQuote.provider}`,
        intermediateMint: raw.buyQuote.outputMint,
        reason: result.reason,
      });
      return undefined;
    }
    if (result.status !== 'EXECUTABLE_CANDIDATE' || !result.route) return undefined;
    scannerStats.executionPrefilter.executablePositiveCandidates++;
    prioritizeDirectMarketPair([raw.buyQuote.inputMint, raw.buyQuote.outputMint], 'EXECUTABLE');
    return result.route;
  }));
  return results.filter((route): route is RoundTripResult => Boolean(route));
}

function printEstimatedRoundTrip(
  buy: Quote,
  sell: Quote,
  profit: ReturnType<typeof calculateEstimatedRoundTripProfit>,
  scope: RoundTripResult['opportunityScope'] = 'RAW_MARKET_OPPORTUNITY',
): void {
  console.log('\n=== LIVE QUOTED OPPORTUNITY (READ-ONLY) ===');
  const inputSymbol = buy.inputMint === MINTS.USDC ? 'USDC' : buy.inputMint.slice(0, 6);
  const middleSymbol = buy.outputMint === MINTS.SOL
    ? 'SOL'
    : buy.outputMint === MINTS.USDT ? 'USDT' : buy.outputMint.slice(0, 6);
  console.log(`Route: ${inputSymbol} -[${buy.provider}]-> ${middleSymbol} -[${sell.provider}]-> ${inputSymbol}`);
  console.log(`Class: ${buy.provider === 'jupiter' || buy.provider === 'raptor'
    || sell.provider === 'jupiter' || sell.provider === 'raptor'
    ? (buy.provider === 'jupiter' || buy.provider === 'raptor')
      && (sell.provider === 'jupiter' || sell.provider === 'raptor')
      ? 'AGGREGATOR_ARBITRAGE' : 'AGGREGATOR_ROUTE'
    : 'DIRECT_CROSS_DEX'}`);
  console.log(`Starting USDC: ${profit.startingUsdc.toFixed(6)}`);
  console.log(`Quoted final USDC: ${profit.quotedFinalUsdc.toFixed(6)}`);
  console.log(`Estimated final USDC: ${profit.estimatedFinalUsdc.toFixed(6)}`);
  console.log(`Gross profit (ESTIMATED): ${profit.grossProfitUsdc.toFixed(6)} USDC`);
  console.log(`Base network fee (ESTIMATED): ${profit.estimatedBaseNetworkFeeUsdc.toFixed(6)} USDC`);
  console.log(`Priority fee (ESTIMATED): ${profit.estimatedPriorityFeeUsdc.toFixed(6)} USDC`);
  console.log(`Total network costs (ESTIMATED): ${profit.estimatedFeesUsdc.toFixed(6)} USDC`);
  console.log(scope === 'EXECUTABLE_CANDIDATE'
    ? 'ATA/account creation: included when the configured wallet is missing a non-WSOL ATA (ESTIMATED).'
    : 'ATA/account creation: not included in raw market discovery.');
  console.log(`Slippage buffer (${profit.mode}, ESTIMATED): ${profit.estimatedSlippageUsdc.toFixed(6)} USDC`);
  console.log(`Net profit (ESTIMATED): ${profit.estimatedNetProfitUsdc.toFixed(6)} USDC`);
  console.log(`Profit percentage (ESTIMATED): ${profit.profitPct.toFixed(6)}%`);
  console.log(`Worst-case net (ESTIMATED): ${profit.worstCaseNetProfitUsdc.toFixed(6)} USDC`);
  console.log('No transaction was created or submitted.');
  console.log('========================================\n');
}

let circularProbeCompleted = false;

async function probeRaptorCircularRoute(): Promise<void> {
  if (!CONFIG.enableRaptorCircular || !CONFIG.enableRaptor || circularProbeCompleted) return;
  circularProbeCompleted = true;
  const amountAtomic = toAtomic(CONFIG.tradeSizesUsdc[0] ?? 100, DECIMALS.USDC);
  try {
    const quote = await getProviderQuote('raptor', {
      inputMint: MINTS.USDC,
      outputMint: MINTS.USDC,
      amountAtomic,
      slippageBps: CONFIG.slippageBps,
    });
    if (quote.routePlan.length === 0) {
      throw new Error('Hosted API returned an identity quote with no routed hops; circular arbitrage is not confirmed');
    }
    log.info('OPTIONAL Raptor circular quote probe succeeded (READ-ONLY)', {
      inputUsdc: fromAtomic(quote.inAmount, DECIMALS.USDC).toFixed(6),
      outputUsdc: fromAtomic(quote.outAmount, DECIMALS.USDC).toFixed(6),
      estimatedGrossUsdc: fromAtomic(
        exact(quote.outAmount).minus(quote.inAmount).toFixed(0),
        DECIMALS.USDC,
      ).toFixed(6),
      route: getRouteLabels(quote).join(' -> '),
    });
  } catch (error) {
    log.warn('OPTIONAL Raptor circular quote is not available on the hosted API', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function availableOrLog(results: ProviderQuoteResult[], leg: string): Quote[] {
  const quotes = successfulQuotes(results).filter(isFullFillQuote);
  if (quotes.length === 0) {
    log.error(`All enabled quote providers failed for ${leg}; skipping this trade size`);
  }
  return quotes;
}

function spreadPrefilter(
  firstLegResults: ProviderQuoteResult[],
  additional: (buy: Quote, sellProvider: QuoteProvider) => boolean = () => true,
): (buy: Quote, sellProvider: QuoteProvider) => boolean {
  const outputs = new Map(firstLegResults.flatMap((result) =>
    result.quote && isFullFillQuote(result.quote)
      ? [[result.provider, result.quote.outAmount] as const]
      : [],
  ));
  return (buy, sellProvider) => {
    if (!additional(buy, sellProvider)) return false;
    if (CONFIG.prefilterSpreadBps <= 0) return true;
    const comparisonOutput = outputs.get(sellProvider.name);
    if (!comparisonOutput || comparisonOutput === '0') return true;
    const indicativeSpreadBps = exact(buy.outAmount)
      .minus(comparisonOutput)
      .div(comparisonOutput)
      .mul(10_000);
    return indicativeSpreadBps.gte(CONFIG.prefilterSpreadBps);
  };
}

async function persistAndEvaluateRoute(
  route: RoundTripResult,
  scanRowId: string,
  timestamp: string,
  tradeSizeUsdc: number,
  confirm: boolean = true,
): Promise<boolean> {
  const paperLedgerEnabled = CONFIG.executionMode === 'paper';
  const { buyQuote: buyLeg, sellQuote: sellLeg, profit } = route;
  if (route.opportunityScope === 'EXECUTABLE_CANDIDATE') {
    insertQuote(quoteToRow(buyLeg, scanRowId, `EXEC_BUY_${buyLeg.provider.toUpperCase()}`));
    insertQuote(quoteToRow(sellLeg, scanRowId, `EXEC_SELL_${sellLeg.provider.toUpperCase()}`));
  }
  const lifecycle = observeOpportunity(route);
  const shouldPrintEstimate = lifecycle.state === 'LIVE_QUOTED'
    || lifecycle.state === 'RAW_MARKET_OPPORTUNITY'
    || lifecycle.state === 'EXECUTABLE_CANDIDATE'
    || lifecycle.state === 'DISCOVERY_ONLY_TOKEN_2022'
    || (route.category === 'NEGATIVE' && CONFIG.showNegativeRoutes)
    || (route.category === 'BELOW_THRESHOLD' && CONFIG.showBelowThreshold);
  if (shouldPrintEstimate && lifecycle.eventType !== 'SUPPRESSED') {
    printEstimatedRoundTrip(buyLeg, sellLeg, profit, route.opportunityScope);
  }
  const confidence = calculateConfidence(route, tradeSizeUsdc);
  const oppId = crypto.randomUUID();
  const now = Date.now();
  const detectedTimestamp = new Date(lifecycle.observedAt).toISOString();
  const initialDetectedAt = lifecycle.initialDetectedAt === null
    ? null
    : new Date(lifecycle.initialDetectedAt).toISOString();
  const oppRow: OpportunityRow = {
    id: oppId,
    scanId: scanRowId,
    timestamp: detectedTimestamp,
    buyQuoteId: buyLeg.id,
    sellQuoteId: sellLeg.id,
    tradeSizeUsdc: String(tradeSizeUsdc),
    expectedProfitUsdc: profit.estimatedNetProfitUsdc.toString(),
    estimatedSlippageUsdc: profit.estimatedSlippageUsdc.toString(),
    conservativeProfitUsdc: profit.worstCaseNetProfitUsdc.toString(),
    worstCaseProfitUsdc: profit.worstCaseNetProfitUsdc.toString(),
    estimatedFeesUsdc: profit.estimatedFeesUsdc.toString(),
    confidenceScore: confidence,
    classification: route.classification,
    category: route.category,
    validationTier: route.validationTier,
    opportunityState: lifecycle.state,
    identityKey: lifecycle.identityKey,
    path: JSON.stringify([buyLeg.inputMint, buyLeg.outputMint, sellLeg.outputMint]),
    initialDetectedAt,
    confirmedAt: null,
    expiredAt: lifecycle.state === 'EXPIRED' ? new Date(now).toISOString() : null,
    opportunityLifetimeMs: lifecycle.lifetimeMs,
    quoteAgeMs: Math.max(now - buyLeg.responseTimestamp, now - sellLeg.responseTimestamp),
    calculationTimeMs: now - Math.min(buyLeg.requestTimestamp, sellLeg.requestTimestamp),
    liquidityOverlap: route.liquidityOverlap,
    stale: route.stale,
  };
  insertOpportunity(oppRow);
  if (lifecycle.eventType === 'EXPIRED') {
    expireOpportunitiesByIdentity(
      lifecycle.identityKey,
      new Date(lifecycle.observedAt).toISOString(),
      lifecycle.lifetimeMs,
    );
  }

  const opportunity: Opportunity = {
    ...oppRow,
    buyQuote: buyLeg,
    sellQuote: sellLeg,
    classification: route.classification,
    liquidityOverlap: route.liquidityOverlap,
  };
  const liveExecutionSignal = CONFIG.executionMode === 'live'
    && isFreshPositiveAuditedExecutionSignal(route);

  // Publish an eligible live signal before non-authoritative dashboard/database
  // bookkeeping. The executor still performs the only authorization path.
  // This removes a local persistence queue from the candidate-to-executor
  // critical path without weakening any execution check.
  if (liveExecutionSignal && shouldPublishFreshLiveHandoff(route)) {
    await publishSupportedAggregatorHandoff(route, oppId, lifecycle.observedAt, confidence);
  }
  const riskResult = RiskEngine.validate(opportunity);
  if (riskResult.passed || liveExecutionSignal) {
    if (!riskResult.passed) {
      // Paper-facing confidence/threshold gates remain visible in the
      // dashboard, but cannot discard an otherwise safe live signal before
      // the independently validating executor has inspected it.
      const blockedBy = riskResult.gates.filter((gate) => !gate.passed).map((gate) => gate.gate);
      log.info('Promoting positive live signal past non-execution scanner gates', {
        oppId, blockedBy, executorWillIndependentlyRevalidate: true,
      });
    }
    if (lifecycle.eventType !== 'SUPPRESSED') log.opportunity(
      `[${lifecycle.eventType}] LIVE QUOTED OPPORTUNITY — NOT GUARANTEED EXECUTABLE`, {
      oppId,
      identityKey: lifecycle.identityKey,
      size: tradeSizeUsdc,
      buyProvider: buyLeg.provider,
      sellProvider: sellLeg.provider,
      routeClass: route.classification,
      validationTier: route.validationTier,
      liquidityOverlap: route.liquidityOverlap,
      estimatedNet: profit.estimatedNetProfitUsdc.toFixed(6),
      worstCase: profit.worstCaseNetProfitUsdc.toFixed(6),
      confidence,
    });
    if (!liveExecutionSignal && lifecycle.eventType !== 'SUPPRESSED') {
      await publishSupportedAggregatorHandoff(route, oppId, lifecycle.observedAt, confidence);
    }
    // In live mode the scanner remains quote/discovery-only. It publishes the
    // strict Orca DTO separately; it must never create paper confirmations or
    // mutate the paper ledger alongside real wallet execution.
    if (!paperLedgerEnabled || !confirm || lifecycle.eventType === 'SUPPRESSED') return true;
    try {
      const result = await executionEngine.confirmQuote(opportunity);
      if (result === 'CONFIRMED_QUOTE') markConfirmed(lifecycle.identityKey);
    } catch (error: unknown) {
      log.error('Live quote confirmation error', {
        oppId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  } else {
    const failedGates = riskResult.gates
      .filter((gate) => !gate.passed)
      .map((gate) => gate.gate)
      .join(', ');
    log.debug('Opportunity rejected by risk gates', {
      oppId,
      size: tradeSizeUsdc,
      estimatedNet: profit.estimatedNetProfitUsdc.toFixed(6),
      gates: failedGates,
    });
    if (paperLedgerEnabled) {
      const tradeId = `${oppId}-pt`;
      insertPaperTrade(tradeId, oppId, new Date().toISOString(), 'RISK_REJECTED', String(tradeSizeUsdc));
      updatePaperTrade(tradeId, 'RISK_REJECTED', failedGates, null, null, null, null);
      insertTradeEvent(
        tradeId,
        new Date().toISOString(),
        null,
        'RISK_REJECTED',
        `Observed ${route.category} route; failed gates: ${failedGates}`,
      );
    }
    return false;
  }
}

function currentOrcaExecutionIntermediates(): string[] {
  const core = [MINTS.SOL, MINTS.USDT];
  if (!CONFIG.allowDynamicTokenExecution) return core;
  const dynamic = getDynamicTokens()
    .filter((token) => token.executionPrecheck === 'PASS')
    .filter((token) => token.tier === 'HOT' || token.tier === 'WARM')
    .slice(0, CONFIG.orcaDynamicExecutionMaxTokens)
    .map((token) => token.mint);
  return [...new Set([...core, ...dynamic])];
}

let lastOrcaCrossPoolTriggeredAt = 0;
let orcaCrossPoolPending: Promise<void> | null = null;

/**
 * Cross-pool work is RPC-heavy and independent from the five-provider matrix.
 * Trigger it on its own bounded cadence instead of making every concurrent
 * matrix scan wait for it.
 */
function triggerOrcaCrossPoolScan(estimatedNetworkCostsUsdc: {
  baseNetworkFeeUsdc: number;
  priorityFeeUsdc: number;
}): void {
  if (!CONFIG.enableOrcaCrossPool || orcaCrossPoolPending) return;
  const now = Date.now();
  if (now - lastOrcaCrossPoolTriggeredAt < CONFIG.orcaCrossPoolScanIntervalMs) return;
  lastOrcaCrossPoolTriggeredAt = now;
  orcaCrossPoolPending = (async () => {
    try {
      const slot = await checkRpc();
      const executionIntermediates = currentOrcaExecutionIntermediates();
      const diagnostics = await scanOrcaCrossPoolCycles({
        currentSlot: slot,
        intermediates: executionIntermediates,
        executionIntermediates,
        networkCostUsdcAtomic: BigInt(toAtomic(
          estimatedNetworkCostsUsdc.baseNetworkFeeUsdc + estimatedNetworkCostsUsdc.priorityFeeUsdc,
          DECIMALS.USDC,
        )),
      });
      const candidates = diagnostics.flatMap((evaluation) => evaluation.dto ? [evaluation.dto] : []);
      await new OrcaHandoffInbox().publish(candidates);
      scannerStats.orcaCrossPoolEvaluations += diagnostics.length;
      scannerStats.orcaCrossPoolCandidates += candidates.length;
      recordRouteEvaluations(diagnostics.length);
      recordPairEvaluation('orca', 'orca', diagnostics.length, candidates.length, 0, candidates.length);
      log.info('Orca same-DEX cross-pool scan', {
        poolsTracked: orcaCrossPoolStats.poolsTracked,
        eligibleUsdcWsolPools: orcaCrossPoolStats.eligibleUsdcWsolPools,
        eligibleUsdcDynamicPools: orcaCrossPoolStats.eligibleUsdcDynamicPools,
        orderedCombinations: orcaCrossPoolStats.orderedCombinations,
        evaluations: diagnostics.length,
        candidates: candidates.length,
      });
    } catch (error) {
      log.warn('Orca cross-pool strategy unavailable; five-provider matrix continues', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  })().finally(() => { orcaCrossPoolPending = null; });
}

export async function scanOnce(
  preferredCycle?: ScanCycle,
  scheduledTradeSizes: number[] = nextTradeSizes(),
  backgroundDirect = false,
): Promise<void> {
  const cycle = nextScanCycle(preferredCycle);
  if (!cycle) {
    log.warn('No trusted USDC round-trip cycles are available from SCAN_TOKENS');
    return;
  }
  // The optional probe must never delay the aggressive discovery hot path.
  void probeRaptorCircularRoute();
  if (circuitBreakerOpen) {
    if (Date.now() < circuitBreakerCooldownUntil) {
      log.warn('Circuit breaker open, skipping scan');
      return;
    }
    log.info('Circuit breaker cooldown expired, attempting recovery');
    circuitBreakerOpen = false;
    consecutiveFailures = 0;
  }

  const scanId = crypto.randomUUID();
  prioritizeDirectMarketPair([cycle.inputMint, cycle.intermediateMint], cycle.tier === 'HOT' ? 'HOT' : cycle.tier === 'DISCOVERY' ? 'SCAN' : 'WARM');
  const timestamp = new Date().toISOString();
  scannerStats.currentPhase = 'ESTIMATING_NETWORK_COSTS';
  scannerStats.currentTradeSizeUsdc = null;
  scannerStats.currentPair = `${cycle.startingToken}/${cycle.intermediateToken}`;
  scannerStats.lastScanStartedAt = timestamp;
  scannerStats.lastError = null;
  const scanMode = CONFIG.buyDexes.length > 0 || CONFIG.sellDexes.length > 0
    ? `cross-dex:${cycle.key}`
    : `${CONFIG.scanMode}:${cycle.key}`;

  // Prepare policy/ATA metadata while normal market work is running. This is
  // observational and uses the public wallet only; it never loads a signer.
  if (CONFIG.executionMode === 'live') {
    void prewarmScannerExecutionMints([cycle.intermediateMint]).catch((error: unknown) => {
      log.debug('Scanner executable-policy prewarm unavailable', {
        mint: cycle.intermediateMint,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  try {
    const { referenceSolPriceUsdc, estimatedNetworkCostsUsdc } = await getScannerCostSnapshot();
    triggerOrcaCrossPoolScan(estimatedNetworkCostsUsdc);
    let completedSize = false;

    const tradeSizesThisScan = scheduledTradeSizes;
    if (tradeSizesThisScan.length === 0) {
      throw new Error('SCAN_AMOUNTS_USDC must contain at least one positive quote size');
    }
    for (const tradeSizeUsdc of tradeSizesThisScan) {
      scannerStats.currentTradeSizeUsdc = tradeSizeUsdc;
      scannerStats.currentPhase = 'FIRST_LEG_QUOTES';
      if (!Number.isFinite(tradeSizeUsdc) || tradeSizeUsdc <= 0 || tradeSizeUsdc > CONFIG.maxTradeSizeUsdc) {
        log.warn('Skipping invalid or over-limit paper trade size', { tradeSizeUsdc });
        continue;
      }

      const scanRowId = `${scanId}-${cycle.intermediateToken}-${tradeSizeUsdc}`;
      const scanRow: ScanRow = {
        id: scanRowId,
        timestamp,
        tradeSizeUsdc: String(tradeSizeUsdc),
        scanMode,
        referencePrice: String(referenceSolPriceUsdc),
      };
      insertScan(scanRow);

      const buyAmount = toAtomic(tradeSizeUsdc, DECIMALS.USDC);
      const allProviders = getEnabledProviders();
      const releaseDirect = backgroundDirect && !CONFIG.directDexOnly ? directBackgroundLane.reserve() : undefined;
      const scanProviders = CONFIG.directDexOnly
        ? allProviders.filter((provider) => provider.kind === 'direct')
        : backgroundDirect && !releaseDirect ? allProviders.filter((provider) => provider.kind === 'aggregator') : allProviders;
      const firstLegs = firstLegBulkheads.start(scanProviders, {
        inputMint: cycle.inputMint,
        outputMint: cycle.intermediateMint,
        amountAtomic: buyAmount,
        slippageBps: CONFIG.slippageBps,
        dexes: CONFIG.buyDexes.length > 0 ? CONFIG.buyDexes : undefined,
        priority: cycle.tier === 'HOT' ? 'HIGH' : 'LOW',
      }, CONFIG.scannerDirectLaneDeadlineMs, (lane, elapsed) => {
        scannerStats.lanes[`${lane}FirstLegMs`] = elapsed;
      });
      const persistFirstLegs = (results: ProviderQuoteResult[]) => {
        recordProviderQuoteResults(results);
        for (const quote of successfulQuotes(results).filter(isFullFillQuote)) insertQuote(quoteToRow(quote, scanRowId, `BUY_${quote.provider.toUpperCase()}`));
        return results;
      };

      const directProviders = scanProviders.filter((provider) => provider.kind === 'direct');
      const directFirstLegsPromise = firstLegs.direct.then(persistFirstLegs);
      const aggregatorProviders = scanProviders.filter((provider) => provider.kind === 'aggregator');
      const aggregatorFirstLegsPromise = firstLegs.aggregator.then(persistFirstLegs);
      const observableRoutes: RoundTripResult[] = [];
      let persisted = false;
      let executionCandidateChosen = false;
      let completedRoutes = 0;
      const persistedQuotePairs = new Set<string>();
      const persistRoute = async (route: RoundTripResult, confirm = true): Promise<boolean> => {
        const key = `${route.buyQuote.id}:${route.sellQuote.id}`;
        if (persistedQuotePairs.has(key)) return false;
        persistedQuotePairs.add(key);
        return persistAndEvaluateRoute(route, scanRowId, timestamp, tradeSizeUsdc, confirm);
      };

      // Submit all independent second-leg work now. Each provider's own runtime
      // remains responsible for pacing/concurrency, so a slow Jupiter/Raptor
      // request cannot serialize direct-DEX route discovery.
      const fastMatrixPromise = !CONFIG.directDexOnly && aggregatorProviders.length >= 2
        ? aggregatorFirstLegsPromise.then((aggregatorFirstLegs) => buildRoundTripMatrix(
          aggregatorFirstLegs,
          aggregatorProviders,
          {
            intermediateMint: cycle.intermediateMint,
            startingMint: cycle.outputMint,
            slippageBps: CONFIG.slippageBps,
            dexes: CONFIG.sellDexes.length > 0 ? CONFIG.sellDexes : undefined,
            priority: 'HIGH',
          },
          estimatedNetworkCostsUsdc,
          spreadPrefilter(aggregatorFirstLegs),
        ))
        : undefined;
      const directMatrixPromise = directFirstLegsPromise.then((directFirstLegs) => buildRoundTripMatrix(
        directFirstLegs,
        directProviders,
        {
          intermediateMint: cycle.intermediateMint,
          startingMint: cycle.outputMint,
          slippageBps: CONFIG.slippageBps,
          dexes: CONFIG.sellDexes.length > 0 ? CONFIG.sellDexes : undefined,
          priority: 'HIGH',
        },
        estimatedNetworkCostsUsdc,
        spreadPrefilter(directFirstLegs),
        CONFIG.scannerDirectLaneDeadlineMs,
      ));
      const mixedMatrixPromise = !CONFIG.directDexOnly
        ? firstLegs.mixed.then((buyResults) => buildRoundTripMatrix(
          buyResults,
          scanProviders,
          {
            intermediateMint: cycle.intermediateMint,
            startingMint: cycle.outputMint,
            slippageBps: CONFIG.slippageBps,
            dexes: CONFIG.sellDexes.length > 0 ? CONFIG.sellDexes : undefined,
            priority: 'LOW',
          },
          estimatedNetworkCostsUsdc,
          spreadPrefilter(buyResults, (buy, sellProvider) => {
            const buyIsAggregator = buy.provider === 'jupiter' || buy.provider === 'raptor';
            const sellIsAggregator = sellProvider.kind === 'aggregator';
            return buyIsAggregator !== sellIsAggregator;
          }),
          CONFIG.scannerDirectLaneDeadlineMs,
        ))
        : undefined;

      // Preserve the original Jupiter <-> Raptor behavior as a fast lane. This
      // matrix is evaluated and published before any RPC-heavy direct-DEX work.
      try {
      if (!CONFIG.directDexOnly && aggregatorProviders.length >= 2) {
        scannerStats.currentPhase = 'JUPITER_RAPTOR_FAST_LANE';
        const fastMatrix = await fastMatrixPromise!;
        recordMatrixEvaluations(fastMatrix.routes, 'aggregator');
        completedRoutes += fastMatrix.routes.length;
        observableRoutes.push(...fastMatrix.routes);
        if (CONFIG.verboseScanOutput || CONFIG.debug) printRoundTripMatrix('JUPITER <-> RAPTOR FAST LANE', fastMatrix);
        for (const route of fastMatrix.routes) {
          insertQuote(quoteToRow(
            route.sellQuote,
            scanRowId,
            `SELL_FAST_${route.buyQuote.provider.toUpperCase()}_TO_${route.sellQuote.provider.toUpperCase()}`,
          ));
        }
        // Unrestricted quotes remain visible as RAW_MARKET_OPPORTUNITY. Only a
        // separately requoted route constrained to the executor's exact DEX,
        // hop and amount-propagation policy may enter the P0 lane.
        const executableFast = CONFIG.executionMode === 'live'
          ? await findExecutableCandidates(fastMatrix.routes, {
            referenceSolPriceUsdc, estimatedNetworkCostsUsdc,
          })
          : [];
        for (const executable of executableFast) {
          const passed = await persistRoute(executable);
          executionCandidateChosen = executionCandidateChosen || passed;
          persisted = true;
        }
        const fastCandidate = bestEligibleRoute(fastMatrix.routes)
          ?? bestObservableRoute(fastMatrix.routes);
        if (fastCandidate) {
          const passed = await persistRoute(fastCandidate);
          executionCandidateChosen = executionCandidateChosen || passed;
          persisted = true;
        }
      }

      } catch (error) {
        releaseDirect?.();
        // Both promises already have allSettled quote isolation. Observe any outer failure too.
        void directMatrixPromise.catch(() => undefined); void mixedMatrixPromise?.catch(() => undefined);
        throw error;
      }
      completedSize = completedSize || completedRoutes > 0;
      const completeDirectWork = async () => {
      scannerStats.currentPhase = 'DIRECT_MATRIX';
      const directMatrix = await directMatrixPromise;
      recordMatrixEvaluations(directMatrix.routes, 'direct');
      completedRoutes += directMatrix.routes.length;
      if (CONFIG.verboseScanOutput || CONFIG.debug) printRoundTripMatrix('DIRECT CROSS-DEX OPPORTUNITIES', directMatrix);
      for (const route of directMatrix.routes) {
        insertQuote(quoteToRow(
          route.sellQuote,
          scanRowId,
          `SELL_${route.buyQuote.provider.toUpperCase()}_TO_${route.sellQuote.provider.toUpperCase()}`,
        ));
      }

      observableRoutes.push(...directMatrix.routes);
      const directSelected = bestEligibleRoute(directMatrix.routes);
      if (directSelected && !executionCandidateChosen) {
        // Evaluate direct-vs-direct first while both legs remain fresh.
        executionCandidateChosen = await persistRoute(directSelected);
        persisted = true;
      } else if (!persisted) {
        // Publish a direct-market observation immediately instead of leaving the
        // dashboard empty while slower aggregator combinations are still queued.
        const directObservation = bestObservableRoute(directMatrix.routes);
        if (directObservation) {
          await persistRoute(directObservation);
          persisted = true;
        }
      }

      if (!CONFIG.directDexOnly) {
        scannerStats.currentPhase = 'MIXED_PROVIDER_MATRIX';
        const mixedMatrix = await mixedMatrixPromise!;
        recordMatrixEvaluations(mixedMatrix.routes, 'mixed');
        completedRoutes += mixedMatrix.routes.length;
        observableRoutes.push(...mixedMatrix.routes);
        if (CONFIG.verboseScanOutput || CONFIG.debug) printRoundTripMatrix('AGGREGATOR <-> DIRECT DEX ROUTES', mixedMatrix);
        for (const route of mixedMatrix.routes) {
          insertQuote(quoteToRow(
            route.sellQuote,
            scanRowId,
            `SELL_${route.buyQuote.provider.toUpperCase()}_TO_${route.sellQuote.provider.toUpperCase()}`,
          ));
        }
        const executableMixed = CONFIG.executionMode === 'live'
          ? await findExecutableCandidates(mixedMatrix.routes, {
            referenceSolPriceUsdc, estimatedNetworkCostsUsdc,
          })
          : [];
        for (const executable of executableMixed) {
          const passed = await persistRoute(executable);
          executionCandidateChosen = executionCandidateChosen || passed;
          persisted = true;
        }
        if (!executionCandidateChosen) {
          const mixedSelected = bestEligibleRoute(mixedMatrix.routes);
          if (mixedSelected) {
            executionCandidateChosen = await persistRoute(mixedSelected);
            persisted = true;
          }
        }
      }
      completedSize = completedSize || completedRoutes > 0;

      // Persist every positive live route for discovery/history, but confirm
      // only the single highest-priority route to protect free provider quotas.
      for (const route of observableRoutes) {
        if (route.validationTier === 'OBSERVATION') continue;
        await persistRoute(route, false);
      }

      // A quiet market is still useful scanner output. Persist the best observed
      // route and its risk rejection so the UI proves that quotes and paper
      // decisions are progressing. An observation is never promoted unless all
      // existing profitability, freshness, and independence gates pass.
      if (!persisted) {
        const observed = bestObservableRoute(observableRoutes);
        if (observed) await persistRoute(observed);
      }
      scannerStats.tradeSizesCompleted++;
      };
      if (backgroundDirect && !CONFIG.directDexOnly) {
        // P0 publication and the NEXT aggregator cycle never await this RPC lane.
        void completeDirectWork().catch((error: unknown) => {
          log.warn('Direct/mixed scanner lane failed independently', { reason: error instanceof Error ? error.message : String(error) });
        }).finally(() => releaseDirect?.());
      } else await completeDirectWork();
    }

    insertHealth(timestamp, 'scanner', completedSize ? 'OK' : 'DEGRADED', null, 0, 0);
    if (CONFIG.verboseScanOutput || Date.now() - lastProviderHealthPrintedAt >= 30_000) {
      printProviderHealth();
      log.info('Scanner execution-scope totals', scannerStats.executionPrefilter);
      lastProviderHealthPrintedAt = Date.now();
    }
    consecutiveFailures = completedSize ? 0 : consecutiveFailures + 1;
    scannerStats.scansCompleted++;
    laneEvents.push({ at: Date.now(), lane: 'cycle', count: 1, stale: 0, duration: Date.now() - Date.parse(timestamp) });
    scannerStats.lastScanCompletedAt = new Date().toISOString();
    scannerStats.currentPhase = completedSize ? 'IDLE' : 'DEGRADED';
    scannerStats.currentTradeSizeUsdc = null;
    for (const expired of expireInactive()) {
      expireOpportunitiesByIdentity(
        expired.identityKey,
        new Date(expired.observedAt).toISOString(),
        expired.lifetimeMs,
      );
      log.info(`[EXPIRED] live quoted opportunity`, {
        identityKey: expired.identityKey,
        lifetimeMs: expired.lifetimeMs,
      });
    }
  } catch (error) {
    consecutiveFailures++;
    const reason = error instanceof Error ? error.message : String(error);
    scannerStats.lastError = reason;
    scannerStats.currentPhase = 'ERROR';
    scannerStats.currentTradeSizeUsdc = null;
    log.error('Scan iteration failed', { reason, consecutiveFailures });
    insertHealth(timestamp, 'scanner', 'ERROR', null, consecutiveFailures, 0);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      circuitBreakerOpen = true;
      circuitBreakerCooldownUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      log.error(`Circuit breaker OPEN — pausing scanner for ${CIRCUIT_BREAKER_COOLDOWN_MS}ms`, {
        consecutiveFailures,
      });
    }
  }
}

export const scannerStats: {
  lanes: { aggregatorFirstLegMs: number; directFirstLegMs: number; aggregatorFastLaneEvals60s: number; directLaneEvals60s: number; mixedLaneEvals60s: number; completedScans60s: number; scannerCycleP50: number; scannerCycleP90: number; staleByLane60s: Record<string, number> };
  evaluationsThisMinute: number;
  routesEvaluated: number;
  tradeSizesCompleted: number;
  scansCompleted: number;
  currentPhase: string;
  currentTradeSizeUsdc: number | null;
  currentPair: string | null;
  marketEventsReceived: number;
  eventTriggeredScans: number;
  lastScanStartedAt: string | null;
  lastScanCompletedAt: string | null;
  lastError: string | null;
  orcaCrossPoolEvaluations: number;
  orcaCrossPoolCandidates: number;
  executionPrefilter: {
    rawPositiveOpportunities: number;
    executablePositiveCandidates: number;
    token2022DiscoveryOnly: number;
    routeEconomicsDiverged: number;
    tokenPolicyRejected: number;
    routePolicyRejected: number;
    quoteFailures: number;
  };
  providerPairs: Record<string, {
    evaluationsPerMinute: number;
    positiveCandidatesPerMinute: number;
    handoffsPerMinute: number;
    staleCandidatesPerMinute: number;
    totalEvaluations: number;
  }>;
  providerQuotes: Record<string, {
    quotesPerSecond: number;
    successesPerMinute: number;
    failuresPerMinute: number;
    rateLimitsPerMinute: number;
  }>;
} = {
  lanes: { aggregatorFirstLegMs: 0, directFirstLegMs: 0, aggregatorFastLaneEvals60s: 0, directLaneEvals60s: 0, mixedLaneEvals60s: 0, completedScans60s: 0, scannerCycleP50: 0, scannerCycleP90: 0, staleByLane60s: {} },
  evaluationsThisMinute: 0,
  routesEvaluated: 0,
  tradeSizesCompleted: 0,
  scansCompleted: 0,
  currentPhase: 'STARTING',
  currentTradeSizeUsdc: null,
  currentPair: null,
  marketEventsReceived: 0,
  eventTriggeredScans: 0,
  lastScanStartedAt: null,
  lastScanCompletedAt: null,
  lastError: null,
  orcaCrossPoolEvaluations: 0,
  orcaCrossPoolCandidates: 0,
  executionPrefilter: {
    rawPositiveOpportunities: 0,
    executablePositiveCandidates: 0,
    token2022DiscoveryOnly: 0,
    routeEconomicsDiverged: 0,
    tokenPolicyRejected: 0,
    routePolicyRejected: 0,
    quoteFailures: 0,
  },
  providerPairs: {},
  providerQuotes: {},
};

const evaluationBuckets: Array<{ timestamp: number; count: number }> = [];
const laneEvents: Array<{ at: number; lane: string; count: number; stale: number; duration: number }> = [];
type PairBucket = {
  timestamp: number;
  pair: string;
  evaluations: number;
  positive: number;
  handoffs: number;
  stale: number;
};
type ProviderQuoteBucket = {
  timestamp: number;
  provider: string;
  success: number;
  failure: number;
  rateLimit: number;
};
const pairBuckets: PairBucket[] = [];
const providerQuoteBuckets: ProviderQuoteBucket[] = [];
const pairTotals = new Map<string, number>();

function refreshEvaluationsPerMinute(now = Date.now()): void {
  const cutoff = now - 60_000;
  while (evaluationBuckets[0] && evaluationBuckets[0].timestamp < cutoff) {
    evaluationBuckets.shift();
  }
  scannerStats.evaluationsThisMinute = evaluationBuckets.reduce(
    (total, bucket) => total + bucket.count,
    0,
  );
}

function recordRouteEvaluations(count: number): void {
  if (count <= 0) return;
  evaluationBuckets.push({ timestamp: Date.now(), count });
  scannerStats.routesEvaluated += count;
  refreshEvaluationsPerMinute();
}

function providerPairKey(buy: string, sell: string): string {
  return [buy, sell].sort().join('↔');
}

function recordPairEvaluation(
  buy: string,
  sell: string,
  evaluations: number,
  positive = 0,
  stale = 0,
  handoffs = 0,
): void {
  if (evaluations <= 0 && handoffs <= 0) return;
  pairBuckets.push({
    timestamp: Date.now(), pair: providerPairKey(buy, sell), evaluations, positive, stale, handoffs,
  });
  if (evaluations > 0) {
    const key = providerPairKey(buy, sell);
    pairTotals.set(key, (pairTotals.get(key) ?? 0) + evaluations);
  }
  refreshDiscoveryMetrics();
}

function recordMatrixEvaluations(routes: RoundTripResult[], lane: 'aggregator' | 'direct' | 'mixed'): void {
  laneEvents.push({ at: Date.now(), lane, count: routes.length, stale: routes.filter((r) => r.stale).length, duration: 0 });
  recordRouteEvaluations(routes.length);
  const dynamicByMint = new Map(getDynamicTokens().map((token) => [token.mint, token]));
  const token2022Program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  for (const route of routes) {
    if (route.opportunityScope !== 'EXECUTABLE_CANDIDATE'
      && route.profit.estimatedNetProfitUsdc.gt(0)
      && route.profit.worstCaseNetProfitUsdc.gt(0)) {
      scannerStats.executionPrefilter.rawPositiveOpportunities++;
      if (dynamicByMint.get(route.buyQuote.outputMint)?.tokenProgram === token2022Program) {
        route.opportunityScope = 'DISCOVERY_ONLY_TOKEN_2022';
        scannerStats.executionPrefilter.token2022DiscoveryOnly++;
      }
    }
    recordPairEvaluation(
      route.buyQuote.provider,
      route.sellQuote.provider,
      1,
      route.profit.estimatedNetProfitUsdc.gt(0) ? 1 : 0,
      route.stale ? 1 : 0,
    );
    recordProviderQuote(route.sellQuote.provider, true, false);
  }
}

function recordProviderQuote(provider: string, success: boolean, rateLimit: boolean): void {
  providerQuoteBuckets.push({
    timestamp: Date.now(), provider, success: success ? 1 : 0, failure: success ? 0 : 1, rateLimit: rateLimit ? 1 : 0,
  });
  refreshDiscoveryMetrics();
}

function recordProviderQuoteResults(results: ProviderQuoteResult[]): void {
  for (const result of results) {
    const message = result.error?.message.toLowerCase() ?? '';
    recordProviderQuote(result.provider, Boolean(result.quote), message.includes('429') || message.includes('rate limit'));
  }
}

function recordHandoff(route: RoundTripResult): void {
  recordPairEvaluation(route.buyQuote.provider, route.sellQuote.provider, 0, 0, 0, 1);
}

function refreshDiscoveryMetrics(now = Date.now()): void {
  const cutoff = now - 60_000;
  while (laneEvents[0] && laneEvents[0].at < cutoff) laneEvents.shift();
  const sum = (lane: string) => laneEvents.filter((e) => e.lane === lane).reduce((n, e) => n + e.count, 0);
  scannerStats.lanes.aggregatorFastLaneEvals60s = sum('aggregator');
  scannerStats.lanes.directLaneEvals60s = sum('direct');
  scannerStats.lanes.mixedLaneEvals60s = sum('mixed');
  scannerStats.lanes.completedScans60s = sum('cycle');
  const durations = laneEvents.filter((e) => e.lane === 'cycle').map((e) => e.duration).sort((a, b) => a - b);
  scannerStats.lanes.scannerCycleP50 = durations[Math.max(0, Math.ceil(durations.length * .5) - 1)] ?? 0;
  scannerStats.lanes.scannerCycleP90 = durations[Math.max(0, Math.ceil(durations.length * .9) - 1)] ?? 0;
  scannerStats.lanes.staleByLane60s = Object.fromEntries(['aggregator', 'direct', 'mixed'].map((lane) => [lane, laneEvents.filter((e) => e.lane === lane).reduce((n, e) => n + e.stale, 0)]));
  while (pairBuckets[0] && pairBuckets[0].timestamp < cutoff) pairBuckets.shift();
  while (providerQuoteBuckets[0] && providerQuoteBuckets[0].timestamp < cutoff) providerQuoteBuckets.shift();
  const pairs: typeof scannerStats.providerPairs = {};
  for (const bucket of pairBuckets) {
    const metric = pairs[bucket.pair] ??= {
      evaluationsPerMinute: 0, positiveCandidatesPerMinute: 0, handoffsPerMinute: 0,
      staleCandidatesPerMinute: 0, totalEvaluations: 0,
    };
    metric.evaluationsPerMinute += bucket.evaluations;
    metric.positiveCandidatesPerMinute += bucket.positive;
    metric.handoffsPerMinute += bucket.handoffs;
    metric.staleCandidatesPerMinute += bucket.stale;
  }
  for (const [pair, metric] of Object.entries(pairs)) metric.totalEvaluations = pairTotals.get(pair) ?? 0;
  scannerStats.providerPairs = pairs;

  const providerQuotes: typeof scannerStats.providerQuotes = {};
  for (const bucket of providerQuoteBuckets) {
    const metric = providerQuotes[bucket.provider] ??= {
      quotesPerSecond: 0, successesPerMinute: 0, failuresPerMinute: 0, rateLimitsPerMinute: 0,
    };
    metric.successesPerMinute += bucket.success;
    metric.failuresPerMinute += bucket.failure;
    metric.rateLimitsPerMinute += bucket.rateLimit;
  }
  for (const metric of Object.values(providerQuotes)) metric.quotesPerSecond = metric.successesPerMinute / 60;
  scannerStats.providerQuotes = providerQuotes;
}

setInterval(() => {
  refreshEvaluationsPerMinute();
  refreshDiscoveryMetrics();
}, 1_000).unref();

let running = true;
const pendingMarketCycles = new Map<string, ScanCycle>();
const lastMarketEventByCycle = new Map<string, number>();
let marketWake: (() => void) | null = null;

export function notifyMarketChange(inputMint: string, outputMint: string): void {
  const cycle = cycleForPair(inputMint, outputMint);
  if (!cycle) return;
  scannerStats.marketEventsReceived++;
  const now = Date.now();
  const last = lastMarketEventByCycle.get(cycle.key) ?? 0;
  if (now - last < CONFIG.marketEventDebounceMs) return;
  lastMarketEventByCycle.set(cycle.key, now);
  pendingMarketCycles.set(cycle.key, cycle);
  marketWake?.();
  marketWake = null;
}

function takePendingCycle(): ScanCycle | undefined {
  const first = pendingMarketCycles.entries().next();
  if (first.done) return undefined;
  const [key, cycle] = first.value;
  pendingMarketCycles.delete(key);
  scannerStats.eventTriggeredScans++;
  return cycle;
}

function waitForMarketEventOrInterval(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (marketWake === wake) marketWake = null;
      resolve();
    }, CONFIG.scanIntervalMs);
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    marketWake = wake;
  });
}

export function stopScanner(): void {
  running = false;
}

export async function scanLoop(): Promise<void> {
  log.info('Hybrid event-driven scanner loop started', {
    fallbackIntervalMs: CONFIG.scanIntervalMs,
    eventScanMinIntervalMs: CONFIG.eventScanMinIntervalMs,
    concurrentCycles: CONFIG.scannerConcurrentCycles,
  });
  void probeRaptorCircularRoute();
  let lastEventBatchAt = 0;
  while (running) {
    const eventCycle = takePendingCycle();
    if (eventCycle) {
      const waitMs = Math.max(0, CONFIG.eventScanMinIntervalMs - (Date.now() - lastEventBatchAt));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      lastEventBatchAt = Date.now();
    }
    const cycles: ScanCycle[] = [];
    if (eventCycle) cycles.push(eventCycle);
    while (cycles.length < CONFIG.scannerConcurrentCycles) {
      const cycle = takePendingCycle() ?? nextScanCycle();
      if (!cycle) break;
      // A just-enqueued event takes priority, but one route is never allowed
      // to occupy the entire batch and starve the dynamic universe.
      if (!cycles.some((existing) => existing.key === cycle.key)) cycles.push(cycle);
    }
    if (cycles.length === 0) {
      await waitForMarketEventOrInterval();
      continue;
    }
    await Promise.allSettled(cycles.map((cycle) => scanOnce(cycle, nextTradeSizes(), true)));
    if (!running) break;
    if (pendingMarketCycles.size === 0) await waitForMarketEventOrInterval();
  }
  log.info('Scanner loop stopped');
}

import type { ProviderQuoteResult } from './aggregators/index.js';
import { startScannerStage } from './scanner-stage-profile.js';
import { scannerDeadline } from './scanner-bulkheads.js';
import {
  getRouteLabels,
  isFullFillQuote,
  providerKind,
  type Quote,
  type QuoteParams,
  type QuoteProvider,
  type QuoteProviderName,
} from './aggregators/types.js';
import { CONFIG, DECIMALS } from './config.js';
import { exact, fromAtomic } from './math.js';
import {
  calculateEstimatedRoundTripProfit,
  type EstimatedCostInput,
  type EstimatedRoundTripProfit,
} from './profit.js';

export type RouteClassification = 'DIRECT_CROSS_DEX' | 'AGGREGATOR_ROUTE' | 'AGGREGATOR_ARBITRAGE';
export type OpportunityCategory = 'NEGATIVE' | 'BELOW_THRESHOLD' | 'POTENTIAL' | 'HIGH_SPREAD';
export type ValidationTier = 'OBSERVATION' | 'QUOTE_CANDIDATE' | 'CONSERVATIVE_CANDIDATE';
export type OpportunityScope =
  | 'RAW_MARKET_OPPORTUNITY'
  | 'EXECUTABLE_CANDIDATE'
  | 'DISCOVERY_ONLY_TOKEN_2022';

export interface RoundTripResult {
  sourceLane?: import('./execution/source-lane.js').SourceLane;
  advisoryBreakdown?: import('./economics/economic-breakdown.js').EconomicBreakdownV1;
  previousSignalId?: string;
  refreshIdentity?: string;
  diagnosticSignalId?: string;
  buyQuote: Quote;
  sellQuote: Quote;
  classification: RouteClassification;
  liquidityOverlap: boolean | null;
  quoteSkewMs: number;
  stale: boolean;
  profit: EstimatedRoundTripProfit;
  category: OpportunityCategory;
  validationTier: ValidationTier;
  /** Broad quote evidence is distinct from an executor-reproducible route. */
  opportunityScope?: OpportunityScope;
}

export interface RoundTripFailure {
  buyProvider: QuoteProviderName;
  sellProvider: QuoteProviderName;
  error: Error;
}

export interface RoundTripMatrix {
  routes: RoundTripResult[];
  failures: RoundTripFailure[];
}

function canonicalVenue(label: string): Extract<QuoteProviderName, 'raydium' | 'orca' | 'meteora'> | undefined {
  const normalized = label.toLowerCase();
  if (normalized.includes('raydium')) return 'raydium';
  if (normalized.includes('orca') || normalized.includes('whirlpool')) return 'orca';
  if (normalized.includes('meteora') || normalized.includes('dlmm')) return 'meteora';
  return undefined;
}

function normalizedVenueLabel(label: string): string | undefined {
  const canonical = canonicalVenue(label);
  if (canonical) return canonical;
  const normalized = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 1 && normalized !== 'unknown' ? normalized : undefined;
}

export function quoteLiquidityVenues(quote: Quote): Set<string> {
  const venues = new Set<string>();
  if (providerKind(quote.provider) === 'direct') venues.add(quote.provider);
  for (const label of getRouteLabels(quote)) {
    const venue = normalizedVenueLabel(label);
    if (venue) venues.add(venue);
  }
  return venues;
}

export function detectLiquidityOverlap(buy: Quote, sell: Quote): boolean | null {
  if (providerKind(buy.provider) === 'direct' && providerKind(sell.provider) === 'direct') {
    return buy.provider === sell.provider;
  }
  const buyVenues = quoteLiquidityVenues(buy);
  const sellVenues = quoteLiquidityVenues(sell);
  if (buyVenues.size === 0 || sellVenues.size === 0) return null;
  return [...buyVenues].some((venue) => sellVenues.has(venue));
}

export function classifyRoute(buy: Quote, sell: Quote): RouteClassification {
  const buyKind = providerKind(buy.provider);
  const sellKind = providerKind(sell.provider);
  if (buyKind === 'direct' && sellKind === 'direct') return 'DIRECT_CROSS_DEX';
  if (buyKind === 'aggregator' && sellKind === 'aggregator') return 'AGGREGATOR_ARBITRAGE';
  return 'AGGREGATOR_ROUTE';
}

export function categorizeProfit(profit: EstimatedRoundTripProfit): OpportunityCategory {
  if (profit.estimatedNetProfitUsdc.isNegative()) return 'NEGATIVE';
  if (profit.estimatedNetProfitUsdc.lt(CONFIG.minNetProfitUsdc)
    || profit.profitBps.lt(CONFIG.minProfitBps)) return 'BELOW_THRESHOLD';
  return profit.profitBps.gte(Math.max(10, CONFIG.minProfitBps * 5))
    ? 'HIGH_SPREAD'
    : 'POTENTIAL';
}

/**
 * A quote is evidence of a possible spread, not proof that a trade can execute.
 * The strongest paper-only tier requires a fresh, independently sourced route
 * whose provider minimum output is still profitable after estimated costs.
 */
export function classifyValidationTier(
  category: OpportunityCategory,
  stale: boolean,
  liquidityOverlap: boolean | null,
  profit: EstimatedRoundTripProfit,
): ValidationTier {
  const positiveCategory = category === 'POTENTIAL' || category === 'HIGH_SPREAD';
  if (!positiveCategory || stale || liquidityOverlap === true
    || !profit.estimatedNetProfitUsdc.gt(0)) return 'OBSERVATION';
  if (liquidityOverlap === false && profit.worstCaseNetProfitUsdc.gt(0)) {
    return 'CONSERVATIVE_CANDIDATE';
  }
  return 'QUOTE_CANDIDATE';
}

const pendingPairSupport = new WeakMap<QuoteProvider, Map<string, Promise<boolean>>>();
/** A soft deadline must not turn one hung discovery read into unbounded orphan work. */
function sharedPairSupport(provider: QuoteProvider, inputMint: string, outputMint: string): Promise<boolean> {
  if (!provider.supportsPair) return Promise.resolve(true);
  let pending = pendingPairSupport.get(provider);
  if (!pending) { pending = new Map(); pendingPairSupport.set(provider, pending); }
  const key = `${inputMint}:${outputMint}`;
  const existing = pending.get(key); if (existing) return existing;
  if (pending.size >= 32) return Promise.resolve(false);
  const work = Promise.resolve().then(() => provider.supportsPair!(inputMint, outputMint)).finally(() => pending!.delete(key));
  pending.set(key, work); return work;
}

export async function buildRoundTripMatrix(
  firstLegResults: ProviderQuoteResult[],
  sellProviders: QuoteProvider[],
  baseParams: Omit<QuoteParams, 'inputMint' | 'outputMint' | 'amountAtomic'> & {
    intermediateMint: string;
    startingMint: string;
  },
  estimatedNetworkFeeUsdc: number | EstimatedCostInput,
  include: (buy: Quote, sellProvider: QuoteProvider) => boolean = () => true,
  scannerBudgetMs?: number,
  onRoute?: (route: RoundTripResult) => void,
  profileLane?: 'aggregatorMatrix' | 'directMatrix' | 'mixedMatrix',
): Promise<RoundTripMatrix> {
  const finishProfile = profileLane ? startScannerStage(profileLane) : () => undefined;
  try {
  const deadlineAt = scannerBudgetMs === undefined ? undefined : Date.now() + scannerBudgetMs;
  const buys = firstLegResults.flatMap((result) =>
    result.quote && isFullFillQuote(result.quote) ? [result.quote] : [],
  );
  const supported = await Promise.allSettled(sellProviders.map(async (provider) => ({
    provider,
    supported: provider.isRateLimited?.() ? false : typeof provider.supportsPair !== 'function'
      || await (scannerBudgetMs === undefined
        ? sharedPairSupport(provider, baseParams.intermediateMint, baseParams.startingMint)
        : scannerDeadline(sharedPairSupport(provider, baseParams.intermediateMint, baseParams.startingMint), scannerBudgetMs, false)),
  })));
  const supportedSellProviders = supported.flatMap((result) =>
    result.status === 'fulfilled' && result.value.supported ? [result.value.provider] : [],
  );
  const jobs = buys.flatMap((buy) => supportedSellProviders
    .filter((sellProvider) => sellProvider.name !== buy.provider && include(buy, sellProvider))
    .map((sellProvider) => ({ buy, sellProvider })));

  const settled = await Promise.allSettled(jobs.map(async ({ buy, sellProvider }) => {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Error('SCANNER_SECOND_LEG_SOFT_DEADLINE');
    const work = sellProvider.getQuote({
      inputMint: baseParams.intermediateMint,
      outputMint: baseParams.startingMint,
      amountAtomic: buy.outAmount, // exact integer output from leg 1
      slippageBps: baseParams.slippageBps,
      dexes: baseParams.dexes,
      priority: baseParams.priority,
    });
    const sellQuote = deadlineAt === undefined ? await work
      : await scannerDeadline<Quote | undefined>(work, Math.max(0, deadlineAt - Date.now()), undefined);
    if (!sellQuote) throw new Error('SCANNER_SECOND_LEG_SOFT_DEADLINE');
    if (!isFullFillQuote(sellQuote)) {
      throw new Error(`${sellProvider.name} returned a partial second-leg fill`);
    }
    if (sellQuote.inAmount !== buy.outAmount) {
      throw new Error(`${sellProvider.name} second-leg input does not equal exact first-leg output`);
    }
    const quoteSkewMs = Math.abs(sellQuote.responseTimestamp - buy.responseTimestamp);
    const stale = quoteSkewMs > CONFIG.maxQuoteAgeMs
      || sellQuote.responseTimestamp - buy.responseTimestamp > CONFIG.maxQuoteAgeMs;
    const startingUsdc = fromAtomic(buy.inAmount, DECIMALS.USDC).toString();
    const profit = calculateEstimatedRoundTripProfit(
      startingUsdc,
      sellQuote,
      estimatedNetworkFeeUsdc,
    );
    const classification = classifyRoute(buy, sellQuote);
    const liquidityOverlap = detectLiquidityOverlap(buy, sellQuote);
    const category = categorizeProfit(profit);
    const result = {
      buyQuote: buy,
      sellQuote,
      classification,
      liquidityOverlap,
      quoteSkewMs,
      stale,
      category,
      // An unrestricted quote can demonstrate a market spread, but it cannot
      // be called conservative/executable until the separate live prefilter
      // requotes it under the executor's exact routing surface.
      validationTier: classifyValidationTier(category, stale, liquidityOverlap, profit) === 'CONSERVATIVE_CANDIDATE'
        ? 'QUOTE_CANDIDATE'
        : classifyValidationTier(category, stale, liquidityOverlap, profit),
      opportunityScope: 'RAW_MARKET_OPPORTUNITY',
      profit,
    } satisfies RoundTripResult;
    onRoute?.(result);
    return result;
  }));

  const routes: RoundTripResult[] = [];
  const failures: RoundTripFailure[] = [];
  settled.forEach((result, index) => {
    const job = jobs[index]!;
    if (result.status === 'fulfilled') routes.push(result.value);
    else failures.push({
      buyProvider: job.buy.provider,
      sellProvider: job.sellProvider.name,
      error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
    });
  });
  routes.sort((a, b) => b.profit.estimatedNetProfitUsdc.cmp(a.profit.estimatedNetProfitUsdc));
  return { routes, failures };
  } finally { finishProfile(); }
}

export function printRoundTripMatrix(title: string, matrix: RoundTripMatrix): void {
  console.log(`\n=== ${title} (LIVE MARKET / READ-ONLY) ===`);
  console.log('BUY'.padEnd(10) + 'SELL'.padEnd(10) + 'TYPE'.padEnd(20)
    + 'FINAL USDC'.padStart(14) + 'NET'.padStart(13) + 'ROI'.padStart(11)
    + '  STATUS / OVERLAP');
  console.log('-'.repeat(100));
  for (const route of matrix.routes) {
    const overlap = route.liquidityOverlap === true
      ? 'OVERLAP'
      : route.liquidityOverlap === false ? 'NO' : 'UNKNOWN';
    const status = route.stale ? 'STALE' : `${route.validationTier}/${route.category}`;
    console.log(
      route.buyQuote.provider.padEnd(10)
      + route.sellQuote.provider.padEnd(10)
      + route.classification.padEnd(20)
      + route.profit.estimatedFinalUsdc.toFixed(6).padStart(14)
      + route.profit.estimatedNetProfitUsdc.toFixed(6).padStart(13)
      + `${route.profit.profitPct.toFixed(4)}%`.padStart(11)
      + `  ${status} / ${overlap}`,
    );
  }
  if (matrix.routes.length === 0) console.log('No comparable full-fill routes.');
  if (matrix.failures.length > 0) {
    console.log(`Unavailable route quotes: ${matrix.failures.length} (scanner continued)`);
  }
  console.log('Venue fees and price impact are already reflected in quoted output; only ESTIMATED network costs are subtracted.');
  console.log('No transaction was created, signed, or submitted.');
}

export function bestEligibleRoute(routes: RoundTripResult[]): RoundTripResult | undefined {
  return routes.find((route) =>
    !route.stale
    && route.liquidityOverlap !== true
    && (route.category === 'POTENTIAL' || route.category === 'HIGH_SPREAD')
    && exact(route.profit.estimatedNetProfitUsdc).gt(0),
  );
}

/**
 * Returns the best route worth displaying as a scanner evaluation even when
 * no route is profitable. This never makes the route execution-eligible; the
 * normal risk engine still records the precise rejection reasons.
 */
export function bestObservableRoute(routes: RoundTripResult[]): RoundTripResult | undefined {
  return routes.find((route) => !route.stale && route.liquidityOverlap !== true)
    ?? routes.find((route) => route.liquidityOverlap !== true)
    ?? routes[0];
}

export type QuoteProviderName =
  | 'jupiter'
  | 'raptor'
  | 'raydium'
  | 'orca'
  | 'meteora';

export type QuoteProviderKind = 'aggregator' | 'direct';
export type ProviderAvailabilityState = 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'UNAVAILABLE';

export interface ProviderHealthSnapshot {
  state: ProviderAvailabilityState;
  requests: number;
  successes: number;
  failures: number;
  rateLimits429: number;
  averageLatencyMs: number;
  circuitOpen: boolean;
}

/**
 * Capabilities are deliberately independent. A source that can return a quote
 * is not automatically safe to use for transaction construction or execution.
 */
export interface ProviderCapabilities {
  quote: boolean;
  dryRun: boolean;
  execution: boolean;
  streaming: boolean;
  atomicCycle: boolean;
}

export function providerKind(name: QuoteProviderName): QuoteProviderKind {
  return name === 'jupiter' || name === 'raptor' ? 'aggregator' : 'direct';
}

export type QuotePriority = 'HIGH' | 'LOW' | 'EXEC_PREFILTER_HIGH' | 'DISCOVERY_HIGH' | 'DISCOVERY_LOW';

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  slippageBps: number;
  dexes?: string[];
  /** Provider routing constraints used by the executable-candidate prefilter. */
  maxHops?: number;
  onlyDirectRoutes?: boolean;
  maxAccounts?: number;
  priority?: QuotePriority;
}

export interface NormalizedRouteStep {
  swapInfo: {
    label?: string;
    ammKey?: string;
    programId?: string;
    inputMint?: string;
    outputMint?: string;
    inAmount?: string;
    outAmount?: string;
    feeAmount?: string;
    feeMint?: string;
  };
  percent?: number | null;
}

/**
 * Provider-independent, quote-only representation used throughout the scanner.
 * Amounts are atomic-unit strings so no precision is lost.
 */
export interface Quote {
  provider: QuoteProviderName;
  id: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  /** Actual raw input consumed. Differs from inAmount only for partial fills. */
  consumedInAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn';
  slippageBps: number;
  priceImpactPct?: string;
  platformFee?: { amount: string; feeBps: number } | null;
  feeAmount?: string;
  feeMint?: string;
  routePlan: NormalizedRouteStep[];
  poolIds: string[];
  isPartialFill: boolean;
  contextSlot?: number;
  timeTaken?: number;
  requestTimestamp: number;
  responseTimestamp: number;
  latencyMs: number;
  rawResponse: string;
}

export interface QuoteProvider {
  readonly name: QuoteProviderName;
  readonly kind: QuoteProviderKind;
  readonly capabilities: ProviderCapabilities;
  getQuote(params: QuoteParams): Promise<Quote>;
  supportsPair(inputMint: string, outputMint: string): Promise<boolean>;
  health(): ProviderHealthSnapshot;
  isRateLimited(): boolean;
}

/** Preferred Phase 3 name; Quote remains exported to preserve existing callers. */
export type NormalizedQuote = Quote;

export function assertAtomicAmount(value: string, field: string): void {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer string`);
  }
}

export function isFullFillQuote(
  quote: Pick<Quote, 'inAmount' | 'consumedInAmount' | 'isPartialFill'>,
): boolean {
  return !quote.isPartialFill && quote.consumedInAmount === quote.inAmount;
}

export function getRouteLabels(q: Pick<Quote, 'routePlan'>): string[] {
  const labels = q.routePlan.map((step) => step.swapInfo.label ?? 'unknown');
  return [...new Set(labels)];
}

export function getPoolIds(q: Pick<Quote, 'poolIds' | 'routePlan'>): string[] {
  const ids = [
    ...q.poolIds,
    ...q.routePlan.flatMap((step) => step.swapInfo.ammKey ? [step.swapInfo.ammKey] : []),
  ];
  return [...new Set(ids)];
}

export function routeSummary(q: Pick<Quote, 'routePlan'>): string {
  return getRouteLabels(q).join(' → ') || 'direct';
}

export function routeMatchesDexes(
  q: Pick<Quote, 'routePlan'>,
  requestedDexes: string[],
): boolean | null {
  if (requestedDexes.length === 0) return null;
  const requestedLower = new Set(requestedDexes.map((dex) => dex.toLowerCase()));
  return q.routePlan.every((step) =>
    requestedLower.has((step.swapInfo.label ?? '').toLowerCase()),
  );
}

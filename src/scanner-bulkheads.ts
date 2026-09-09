import type { QuoteParams, QuoteProvider } from './aggregators/types.js';
import { startScannerStage } from './scanner-stage-profile.js';
import type { ProviderQuoteResult } from './aggregators/index.js';
import { CONFIG, DECIMALS, MINTS } from './config.js';
import { toAtomic } from './math.js';

/** Reserving before dispatch prevents background lanes from accumulating across scan cycles. */
export class ScannerBackgroundLane {
  private active = 0;
  constructor(private readonly cap = 4) {}
  reserve(): (() => void) | undefined {
    if (this.active >= this.cap) return undefined;
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
  get pending(): number { return this.active; }
}

/** Scanner-only deadline. The underlying provider remains bounded/deduplicated until it settles. */
export async function scannerDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export class ScannerFirstLegBulkheads {
  private readonly pending = new Map<string, Promise<ProviderQuoteResult>>();
  constructor(private readonly quote: (providers: QuoteProvider[], params: QuoteParams) => Promise<ProviderQuoteResult[]>) {}

  start(providers: QuoteProvider[], params: QuoteParams, directDeadlineMs: number,
    observed: (lane: 'aggregator' | 'direct', elapsed: number) => void = () => undefined) {
    const start = Date.now();
    const liveInCapUsdc = CONFIG.executionMode === 'live'
      && params.inputMint === MINTS.USDC
      && /^\d+$/.test(params.amountAtomic)
      && BigInt(params.amountAtomic) <= BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC));
    // Do not let one slow first-leg aggregator age a faster quote for several
    // seconds before the round-trip matrix can begin. This is only a scanner
    // admission deadline; it does not extend execution freshness or cancel the
    // already-bounded underlying provider request.
    const aggregatorFreshnessDeadlineMs = Math.max(
      1,
      Math.min(directDeadlineMs, Math.floor(CONFIG.raptorExecutionQuoteAgeMs / 2)),
    );
    const lane = (kind: 'aggregator' | 'direct') => {
      const finish = startScannerStage(`${kind}FirstLeg`);
      return Promise.all(providers.filter((p) => p.kind === kind).map((provider) => {
      const unavailable = (reason: string): ProviderQuoteResult => ({ provider: provider.name, error: new Error(reason) });
      if (provider.isRateLimited()) return Promise.resolve(unavailable('Provider cooling down; scanner skipped'));
      // Executable-size discovery should not sit behind ordinary low-priority
      // observation work. Request count and provider limits are unchanged.
      const providerParams: QuoteParams = kind === 'aggregator' && liveInCapUsdc
        ? { ...params, priority: 'HIGH' }
        : params;
      const key = JSON.stringify([provider.name, providerParams.inputMint, providerParams.outputMint, providerParams.amountAtomic, providerParams.slippageBps,
        providerParams.dexes, providerParams.maxHops, providerParams.onlyDirectRoutes, providerParams.maxAccounts, providerParams.priority]);
      let work = this.pending.get(key);
      if (!work) {
        if (this.pending.size >= 64) return Promise.resolve(unavailable('Scanner first-leg bounded capacity'));
        work = this.quote([provider], providerParams).then((results) => results[0] ?? unavailable('No quote returned'),
          (error: unknown) => unavailable(error instanceof Error ? error.message : String(error)))
          .finally(() => this.pending.delete(key));
        this.pending.set(key, work);
      }
      if (kind === 'direct') return scannerDeadline(work, directDeadlineMs, unavailable('DIRECT_FIRST_LEG_SOFT_DEADLINE'));
      return liveInCapUsdc
        ? scannerDeadline(work, aggregatorFreshnessDeadlineMs, unavailable('AGGREGATOR_FIRST_LEG_FRESHNESS_DEADLINE'))
        : work;
    })).then((results) => { observed(kind, Date.now() - start); return results; }).finally(finish);
    };
    // Start both, but never join direct work into the aggregator first-leg promise.
    const aggregator = lane('aggregator'); const direct = lane('direct');
    return { aggregator, direct, mixed: Promise.all([aggregator, direct]).then(([a, d]) => [...a, ...d]) };
  }
}

import type { QuoteParams, QuoteProvider } from './aggregators/types.js';
import { startScannerStage } from './scanner-stage-profile.js';
import type { ProviderQuoteResult } from './aggregators/index.js';

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
    const lane = (kind: 'aggregator' | 'direct') => {
      const finish = startScannerStage(`${kind}FirstLeg`);
      return Promise.all(providers.filter((p) => p.kind === kind).map((provider) => {
      const unavailable = (reason: string): ProviderQuoteResult => ({ provider: provider.name, error: new Error(reason) });
      if (provider.isRateLimited()) return Promise.resolve(unavailable('Provider cooling down; scanner skipped'));
      const key = JSON.stringify([provider.name, params.inputMint, params.outputMint, params.amountAtomic, params.slippageBps,
        params.dexes, params.maxHops, params.onlyDirectRoutes, params.maxAccounts]);
      let work = this.pending.get(key);
      if (!work) {
        if (this.pending.size >= 64) return Promise.resolve(unavailable('Scanner first-leg bounded capacity'));
        work = this.quote([provider], params).then((results) => results[0] ?? unavailable('No quote returned'),
          (error: unknown) => unavailable(error instanceof Error ? error.message : String(error)))
          .finally(() => this.pending.delete(key));
        this.pending.set(key, work);
      }
      return kind === 'direct' ? scannerDeadline(work, directDeadlineMs, unavailable('DIRECT_FIRST_LEG_SOFT_DEADLINE')) : work;
    })).then((results) => { observed(kind, Date.now() - start); return results; }).finally(finish);
    };
    // Start both, but never join direct work into the aggregator first-leg promise.
    const aggregator = lane('aggregator'); const direct = lane('direct');
    return { aggregator, direct, mixed: Promise.all([aggregator, direct]).then(([a, d]) => [...a, ...d]) };
  }
}

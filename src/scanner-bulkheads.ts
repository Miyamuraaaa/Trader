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
  private aggregatorCursor = 0;
  constructor(private readonly quote: (providers: QuoteProvider[], params: QuoteParams) => Promise<ProviderQuoteResult[]>) {}

  start(providers: QuoteProvider[], params: QuoteParams, directDeadlineMs: number,
    observed: (lane: 'aggregator' | 'direct', elapsed: number) => void = () => undefined) {
    const start = Date.now();
    const liveInCapUsdc = CONFIG.executionMode === 'live'
      && params.inputMint === MINTS.USDC
      && /^\d+$/.test(params.amountAtomic)
      && BigInt(params.amountAtomic) <= BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC));

    const allAggregatorProviders = providers.filter((provider) => provider.kind === 'aggregator');
    let liveAggregatorProviders = allAggregatorProviders;
    if (liveInCapUsdc && allAggregatorProviders.length > 1) {
      // A live executable-size round trip only needs one fresh buy-side
      // aggregator quote before the matrix can immediately quote the opposite
      // provider for leg 2. Waiting for every aggregator first leg ages the
      // first quote before raw-positive promotion. Rotate the buy provider each
      // scan so both directions keep coverage without adding requests.
      let selectedIndex = this.aggregatorCursor % allAggregatorProviders.length;
      for (let offset = 0; offset < allAggregatorProviders.length; offset++) {
        const candidateIndex = (this.aggregatorCursor + offset) % allAggregatorProviders.length;
        if (!allAggregatorProviders[candidateIndex]!.isRateLimited()) {
          selectedIndex = candidateIndex;
          break;
        }
      }
      liveAggregatorProviders = [allAggregatorProviders[selectedIndex]!];
      this.aggregatorCursor = (selectedIndex + 1) % allAggregatorProviders.length;
    }

    const lane = (kind: 'aggregator' | 'direct') => {
      const finish = startScannerStage(`${kind}FirstLeg`);
      const laneProviders = kind === 'aggregator' ? liveAggregatorProviders : providers.filter((provider) => provider.kind === 'direct');
      return Promise.all(laneProviders.map((provider) => {
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
      // Direct/RPC discovery remains bounded by its scanner-only soft deadline.
      // Aggregator first legs deliberately wait for their legal provider slot:
      // freshness starts at the returned quote timestamp, and the matrix can
      // now begin immediately because only one rotated buy provider is awaited.
      return kind === 'direct'
        ? scannerDeadline(work, directDeadlineMs, unavailable('DIRECT_FIRST_LEG_SOFT_DEADLINE'))
        : work;
    })).then((results) => { observed(kind, Date.now() - start); return results; }).finally(finish);
    };
    // Start both, but never join direct work into the aggregator first-leg promise.
    const aggregator = lane('aggregator'); const direct = lane('direct');
    return { aggregator, direct, mixed: Promise.all([aggregator, direct]).then(([a, d]) => [...a, ...d]) };
  }
}

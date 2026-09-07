import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScannerFirstLegBulkheads, ScannerBackgroundLane } from '../src/scanner-bulkheads.js';
import type { Quote, QuoteParams, QuoteProvider, QuoteProviderName } from '../src/aggregators/types.js';
import { buildRoundTripMatrix } from '../src/routes.js';

afterEach(() => vi.useRealTimers());
const params: QuoteParams = { inputMint: 'TEST_USDC', outputMint: 'TEST_TOKEN', amountAtomic: '10000', slippageBps: 5 };
function provider(name: QuoteProviderName, delay = 0): QuoteProvider {
  return { name, kind: name === 'jupiter' || name === 'raptor' ? 'aggregator' : 'direct',
    capabilities: { quote: true, dryRun: false, execution: false, streaming: false, atomicCycle: false },
    health: () => ({ state: 'HEALTHY', requests: 0, successes: 0, failures: 0, rateLimits429: 0, averageLatencyMs: delay, circuitOpen: false }),
    isRateLimited: () => false, supportsPair: async () => true,
    getQuote: vi.fn(async (p: QuoteParams): Promise<Quote> => {
      await new Promise((r) => setTimeout(r, delay));
      return { provider: name, id: `TEST DATA ${name}`, inputMint: p.inputMint, outputMint: p.outputMint,
        inAmount: p.amountAtomic, consumedInAmount: p.amountAtomic, outAmount: '9990', otherAmountThreshold: '9980',
        swapMode: 'ExactIn', slippageBps: 5, routePlan: [], poolIds: [], isPartialFill: false,
        requestTimestamp: Date.now(), responseTimestamp: Date.now(), latencyMs: delay, rawResponse: 'TEST DATA' };
    }),
  };
}
function bulkheads() { return new ScannerFirstLegBulkheads(async (providers, p) => Promise.all(providers.map(async (provider) => ({ provider: provider.name, quote: await provider.getQuote(p) })))); }

describe('TEST DATA: scanner independent first-leg lanes', () => {
  it('deduplicates pair-support reads after second-leg soft deadlines', async () => {
    vi.useFakeTimers(); const p = provider('orca');
    p.supportsPair = vi.fn(() => new Promise<boolean>(() => undefined));
    for (let i = 0; i < 5; i++) {
      const work = buildRoundTripMatrix([], [p], { intermediateMint: 'TEST_TOKEN', startingMint: 'TEST_USDC', slippageBps: 5 }, 0, () => true, 10);
      await vi.advanceTimersByTimeAsync(11); await work;
    }
    expect(p.supportsPair).toHaveBeenCalledTimes(1);
  });
  it('bounds background direct work before dispatch and releases slots idempotently', () => {
    const lane = new ScannerBackgroundLane(1); const release = lane.reserve();
    expect(lane.reserve()).toBeUndefined(); expect(lane.pending).toBe(1);
    release?.(); release?.(); expect(lane.pending).toBe(0); expect(lane.reserve()).toBeTypeOf('function');
  });
  it.each(['orca', 'meteora'] as const)('slow %s cannot delay aggregator first leg or fast matrix', async (slow) => {
    vi.useFakeTimers(); const j = provider('jupiter', 10); const r = provider('raptor', 10); const d = provider(slow, 1000);
    const lanes = bulkheads().start([j, r, d], params, 100);
    let fastAt = 0;
    const start = Date.now();
    const fast = lanes.aggregator.then((quotes) => buildRoundTripMatrix(quotes, [j, r], { intermediateMint: 'TEST_TOKEN', startingMint: 'TEST_USDC', slippageBps: 5 }, 0)).then((matrix) => { fastAt = Date.now() - start; return matrix; });
    await vi.advanceTimersByTimeAsync(25); expect((await fast).routes).toHaveLength(2); expect(fastAt).toBe(20);
    await vi.advanceTimersByTimeAsync(100); expect((await lanes.direct)[0]?.error?.message).toContain('SOFT_DEADLINE');
    await vi.runAllTimersAsync();
  });
  it('dispatches each positive aggregator route before the direct/mixed lane and history work', async () => {
    vi.useFakeTimers(); const j = provider('jupiter', 10), r = provider('raptor', 10), d = provider('orca', 1000);
    const original = r.getQuote;
    r.getQuote = async (p) => ({ ...await original(p), outAmount: '50000', otherAmountThreshold: '49000' });
    const lanes = bulkheads().start([j, r, d], params, 2000);
    let directComplete = false; void lanes.direct.then(() => { directComplete = true; });
    const events: string[] = [];
    const matrix = lanes.aggregator.then((quotes) => buildRoundTripMatrix(quotes, [j, r], { intermediateMint: 'TEST_TOKEN', startingMint: 'TEST_USDC', slippageBps: 5 }, 0, () => true, undefined,
      (route) => { if (route.profit.estimatedNetProfitUsdc.gt(0)) events.push('PREFILTER_STARTED'); })).then(() => events.push('HISTORY'));
    await vi.advanceTimersByTimeAsync(25); await matrix;
    expect(events[0]).toBe('PREFILTER_STARTED'); expect(directComplete).toBe(false);
    await vi.runAllTimersAsync();
  });
  it('direct cooldown/429 does not delay aggregator completion or create retries', async () => {
    vi.useFakeTimers(); const j = provider('jupiter', 10); const r = provider('raptor', 10); const d = provider('meteora');
    d.isRateLimited = () => true;
    const lanes = bulkheads().start([j, r, d], params, 100);
    await vi.advanceTimersByTimeAsync(15); expect(await lanes.aggregator).toHaveLength(2); expect(d.getQuote).not.toHaveBeenCalled();
    d.isRateLimited = () => false; vi.mocked(d.getQuote).mockRejectedValue(new Error('TEST DATA HTTP 429'));
    const failed = bulkheads().start([j, r, d], params, 100);
    await vi.advanceTimersByTimeAsync(15); expect((await failed.direct)[0]?.error?.message).toContain('429'); expect(await failed.aggregator).toHaveLength(2); expect(d.getQuote).toHaveBeenCalledTimes(1);
  });
  it('healthy direct and mixed routes remain available with exact second-leg amounts', async () => {
    vi.useFakeTimers(); const providers = [provider('jupiter'), provider('raptor'), provider('orca'), provider('meteora'), provider('raydium')];
    const lanes = bulkheads().start(providers, params, 100);
    await vi.runAllTimersAsync();
    const matrixPromise = buildRoundTripMatrix(await lanes.mixed, providers, { intermediateMint: 'TEST_TOKEN', startingMint: 'TEST_USDC', slippageBps: 5 }, 0);
    await vi.runAllTimersAsync(); const matrix = await matrixPromise;
    expect(matrix.routes).toHaveLength(20);
    expect(matrix.routes.every((r) => r.sellQuote.inAmount === r.buyQuote.outAmount)).toBe(true);
    expect(matrix.routes.every((r) => r.opportunityScope === 'RAW_MARKET_OPPORTUNITY')).toBe(true);
  });
  it('deduplicates identical in-flight work even after a soft deadline', async () => {
    vi.useFakeTimers(); const d = provider('orca', 1000); const lanes = bulkheads();
    const first = lanes.start([d], params, 10); await vi.advanceTimersByTimeAsync(20); await first.direct;
    const second = lanes.start([d], params, 10); await vi.advanceTimersByTimeAsync(20); await second.direct;
    expect(d.getQuote).toHaveBeenCalledTimes(1); await vi.runAllTimersAsync();
  });
  it('bounds outstanding first-leg jobs instead of accumulating abandoned requests', async () => {
    vi.useFakeTimers(); const d = provider('orca', 1000); const lanes = bulkheads();
    const jobs = Array.from({ length: 80 }, (_, i) => lanes.start([d], { ...params, amountAtomic: String(i + 1) }, 10).direct);
    await vi.advanceTimersByTimeAsync(20); await Promise.all(jobs); expect(d.getQuote).toHaveBeenCalledTimes(64); await vi.runAllTimersAsync();
  });
  it('measures detached promotion barrier across seven no-network fixture scenarios', async () => {
    vi.useFakeTimers();
    const scenarios = ['healthy', 'Orca +1s', 'Meteora 429', '20 raw positives', 'above-cap positives', 'slow Jupiter constrained quote', 'slow Raptor constrained quote'];
    const rows = [];
    for (const scenario of scenarios) {
      const measures = [];
      for (const detached of [false, true]) {
        const j = provider('jupiter', 100), r = provider('raptor', 100);
        const o = provider('orca', scenario === 'Orca +1s' ? 1100 : 100), m = provider('meteora', 100);
        if (scenario === 'Meteora 429') m.getQuote = vi.fn(async () => { throw new Error('HTTP 429 TEST FIXTURE'); });
        const lanes = bulkheads(); const background = new ScannerBackgroundLane(2);
        const pending: Promise<unknown>[] = []; const durations: number[] = [];
        let aggregator = 0, direct = 0, mixed = 0, finishedAt = 0, prefilterCount = 0;
        const start = Date.now();
        const run = (async () => {
          for (let cycle = 0; cycle < 20; cycle++) {
            const at = Date.now(); const release = background.reserve();
            const first = lanes.start(release ? [j, r, o, m] : [j, r], { ...params, amountAtomic: String(10000 + cycle) }, 200);
            const fast = buildRoundTripMatrix(await first.aggregator, [j, r], { startingMint: params.inputMint, intermediateMint: params.outputMint, slippageBps: 5 }, 0);
            if (release) pending.push(first.direct.then(async (results) => {
              direct += (await buildRoundTripMatrix(results, [o, m], { startingMint: params.inputMint, intermediateMint: params.outputMint, slippageBps: 5 }, 0, undefined, 200)).routes.length;
              mixed += (await buildRoundTripMatrix(await first.mixed, [j, r, o, m], { startingMint: params.inputMint, intermediateMint: params.outputMint, slippageBps: 5 }, 0, (buy, sell) => ['jupiter', 'raptor'].includes(buy.provider) !== (sell.kind === 'aggregator'), 200)).routes.length;
            }).finally(release));
            aggregator += (await fast).routes.length;
            // Positive-trigger fixtures only. No synthetic quote ever becomes a real handoff.
            if (scenario !== 'above-cap positives' && (scenario === '20 raw positives' || scenario.startsWith('slow') || cycle % 4 === 0)) {
              prefilterCount++;
              const promotion = new Promise<void>((resolve) => setTimeout(resolve, scenario.startsWith('slow') ? 1200 : 600));
              if (detached) pending.push(promotion); else await promotion;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            durations.push(Date.now() - at);
          }
          finishedAt = Date.now();
        })();
        await vi.runAllTimersAsync(); await run; await Promise.all(pending);
        const elapsed = finishedAt - start; durations.sort((a, b) => a - b);
        measures.push({ elapsedMs: elapsed, aggregatorEvalsPerMinute: aggregator * 60000 / elapsed,
          completedCyclesPerMinute: 20 * 60000 / elapsed, cycleP50: durations[9], cycleP90: durations[17],
          aggregatorCompleted: aggregator, directCompletedIncludingDrain: direct, mixedCompletedIncludingDrain: mixed, prefilters: prefilterCount });
      }
      rows.push({ scenario, before: measures[0], after: measures[1] });
    }
    expect(rows[3]!.after!.aggregatorEvalsPerMinute).toBeGreaterThan(rows[3]!.before!.aggregatorEvalsPerMinute * 2);
    expect(rows[1]!.after!.aggregatorEvalsPerMinute).toBe(rows[0]!.after!.aggregatorEvalsPerMinute);
    expect(rows[4]!.after!.prefilters).toBe(0);
    process.stdout.write('SYNTHETIC LANE/BARRIER BENCHMARK (fixed mock latencies; no provider RPS model, no market success claim) ' + JSON.stringify(rows) + '\n');
  });
});

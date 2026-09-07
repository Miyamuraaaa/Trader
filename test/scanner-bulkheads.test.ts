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
});

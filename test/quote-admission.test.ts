import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteAdmission, semanticQuoteKey, type QuoteDeadline } from '../src/quote-admission.js';
import { ScannerFairService } from '../src/scanner-service-policy.js';
import type { Quote, QuoteParams } from '../src/aggregators/types.js';
const params: QuoteParams = { inputMint: 'TEST_INPUT', outputMint: 'TEST_OUTPUT', amountAtomic: '50000', slippageBps: 5, priority: 'EXEC_PREFILTER_HIGH' };
const result = (): Quote => ({ provider: 'raptor', id: 'TEST', inputMint: params.inputMint, outputMint: params.outputMint,
  inAmount: params.amountAtomic, consumedInAmount: params.amountAtomic, outAmount: '100', otherAmountThreshold: '99', swapMode: 'ExactIn',
  slippageBps: 5, routePlan: [], poolIds: [], isPartialFill: false, requestTimestamp: 1000, responseTimestamp: 1000, latencyMs: 0, rawResponse: null });
afterEach(() => vi.useRealTimers());
describe('monotonic quote admission and semantic sharing', () => {
  it('does not coalesce changes in any quote-affecting option', () => {
    const original = semanticQuoteKey('raptor', params);
    for (const changed of [{ amountAtomic: '50001' }, { slippageBps: 6 }, { inputMint: 'OTHER' }, { outputMint: 'OTHER' },
      { dexes: ['Whirlpool'] }, { onlyDirectRoutes: true }, { maxHops: 2 }, { maxAccounts: 64 }, { priority: 'LOW' as const }]) {
      expect(semanticQuoteKey('raptor', { ...params, ...changed })).not.toBe(original);
    }
    expect(semanticQuoteKey('jupiter', params)).not.toBe(original);
    expect(semanticQuoteKey('raptor', { ...params, scheduling: { deadlineMono: 20, traceId: 'other' } })).toBe(original);
  });
  it('shares one provider call but independently expires a shorter waiter', async () => {
    vi.useFakeTimers(); let mono = 0; const admission = new QuoteAdmission('raptor', 0, () => mono, () => 1000);
    let complete!: (q: Quote) => void; let calls = 0;
    const enqueue = (d: QuoteDeadline) => admission.dispatch(d, () => { calls++; return new Promise<Quote>((resolve) => { complete = resolve; }); });
    const first = admission.request(params, enqueue);
    const second = admission.request({ ...params, scheduling: { deadlineMono: 100 } }, enqueue);
    const expired = expect(second).rejects.toThrow('PREFILTER_QUEUE_DEADLINE_EXCEEDED');
    await vi.advanceTimersByTimeAsync(0); expect(calls).toBe(1);
    mono = 101; await vi.advanceTimersByTimeAsync(101); await expired;
    mono = 200; complete(result()); expect(await first).toMatchObject({ outAmount: '100' });
    await vi.advanceTimersByTimeAsync(0);
    expect(admission.snapshot()).toMatchObject({ active_shared_requests: 0, coalescing_hits: 1, provider_calls_avoided: 1, waiter_deadline_expired: 1 });
  });
  it('drops infeasible admission and rechecks prediction immediately before dispatch', async () => {
    let mono = 0; const admission = new QuoteAdmission('raptor', 1000, () => mono, () => 1000);
    expect(() => admission.request({ ...params, scheduling: { deadlineMono: 100 } }, async () => result())).toThrow('PREFILTER_QUEUE_DEADLINE_EXCEEDED');
    const work = vi.fn(async () => result());
    const pending = admission.request({ ...params, scheduling: { deadlineMono: 1000 } }, async (d) => { mono = 200; return admission.dispatch(d, work); });
    await expect(pending).rejects.toThrow('PREFILTER_QUEUE_DEADLINE_EXCEEDED'); expect(work).not.toHaveBeenCalled();
  });
  it('keeps a later waiter alive when the already-dispatched leader waiter expires', async () => {
    vi.useFakeTimers(); let mono = 0;
    const admission = new QuoteAdmission('raptor', 0, () => mono, () => 1000);
    let complete!: (q: Quote) => void;
    const work = vi.fn((d: QuoteDeadline) => admission.dispatch(d, () => new Promise<Quote>((resolve) => { complete = resolve; })));
    const leader = admission.request({ ...params, scheduling: { deadlineMono: 1000 } }, work);
    const rejected = expect(leader).rejects.toThrow('PREFILTER_QUEUE_DEADLINE_EXCEEDED');
    await vi.advanceTimersByTimeAsync(0);
    const follower = admission.request({ ...params, scheduling: { deadlineMono: 1700 } }, work);
    mono = 1001; await vi.advanceTimersByTimeAsync(1001); await rejected;
    mono = 1100; complete(result());
    expect(await follower).toMatchObject({ outAmount: '100' });
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledTimes(1);
    expect(admission.snapshot()).toMatchObject({ active_shared_requests: 0, waiter_deadline_expired: 1 });
  });
  it('never caches a failed shared request and cleans up all remaining waiters', async () => {
    const admission = new QuoteAdmission('raptor', 0, () => 0, () => 1000);
    const fail = vi.fn((d: QuoteDeadline) => admission.dispatch(d, async () => { throw new Error('HTTP 429'); }));
    await Promise.all([
      expect(admission.request(params, fail)).rejects.toThrow('HTTP 429'),
      expect(admission.request(params, fail)).rejects.toThrow('HTTP 429'),
    ]);
    await Promise.resolve(); await Promise.resolve();
    expect(admission.snapshot().active_shared_requests).toBe(0);
    await expect(admission.request(params, fail)).rejects.toThrow('HTTP 429');
    expect(fail).toHaveBeenCalledTimes(2);
  });
  it('keeps queue residence out of service estimation and rejects stale successful responses', async () => {
    let mono = 0; const admission = new QuoteAdmission('raptor', 0, () => mono, () => 1000);
    await admission.request(params, async (d) => { mono = 300; return admission.dispatch(d, async () => { mono = 400; return result(); }); });
    expect(admission.snapshot().serviceEstimateMs).toBe(100);
    await expect(admission.request(params, (d) => admission.dispatch(d, async () => ({ ...result(), responseTimestamp: -10000 })))).rejects.toThrow('QUOTE_RESULT_STALE');
    expect(admission.snapshot().coalescing_rejected_freshness).toBe(1);
  });
  it('does not charge a reclaimed P0 slot for a queued discovery request', async () => {
    let mono=0;
    const admission=new QuoteAdmission('raptor',1000,()=>mono,()=>1000,()=>({nextLegalSendMono:100,cooldownUntilMono:0}));
    await admission.request(params,(d)=>admission.dispatch(d,async()=>{mono=100;return result();}));
    await Promise.resolve(); await Promise.resolve();
    let completeDiscovery!: (quote: Quote)=>void;
    const discovery=admission.request({...params,priority:'DISCOVERY_LOW'},()=>new Promise<Quote>((resolve)=>{completeDiscovery=resolve;}));
    await Promise.resolve(); await Promise.resolve();
    const urgent=admission.request({...params,scheduling:{deadlineMono:900}},(d)=>admission.dispatch(d,async()=>result()));
    expect(await urgent).toMatchObject({outAmount:'100'});
    completeDiscovery(result()); await discovery;
  });
  it('bounds waiters and cleans abandoned queued requests without dispatch', async () => {
    vi.useFakeTimers(); let mono = 0; const admission = new QuoteAdmission('raptor', 0, () => mono, () => 1000);
    const enqueue = vi.fn((d: QuoteDeadline) => new Promise<Quote>((_, reject) => d.signal!.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true })));
    const waits = Array.from({ length: 32 }, () => admission.request(params, enqueue).catch(() => undefined));
    expect(() => admission.request(params, enqueue)).toThrow('PREFILTER_QUEUE_OVERFLOW');
    await vi.advanceTimersByTimeAsync(0); mono = 1801; await vi.advanceTimersByTimeAsync(1801); await Promise.all(waits);
    expect(enqueue).toHaveBeenCalledTimes(1); expect(admission.snapshot().active_shared_requests).toBe(0);
  });
  it('reclaims next service for urgent prefilter, orders by deadline and guarantees both discovery classes', () => {
    const fair = new ScannerFairService();
    const queue = [{ p: 'HIGH', d: 10000 }, { p: 'LOW', d: 10000 }, ...Array.from({ length: 20 }, (_, i) => ({ p: 'EXEC_PREFILTER_HIGH', d: 2000 - i }))];
    const seen = Array.from({ length: 6 }, () => fair.take(queue, (r) => r.p, (r) => r.d)!);
    expect(seen[0]!.d).toBe(1981); expect(seen.filter((r) => r.p === 'HIGH')).toHaveLength(1); expect(seen.filter((r) => r.p === 'LOW')).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ScannerFairService } from '../src/scanner-service-policy.js';
import { ScannerHistoryBuffer } from '../src/scanner-history-buffer.js';
import { executableSurfaceProvider } from '../src/scanner-executable-plane.js';
import { retryAfterMs } from '../src/http.js';
import { QuoteAdmission } from '../src/quote-admission.js';
import type { QuoteProvider, QuoteParams } from '../src/aggregators/types.js';

describe('production provider service reservations', () => {
  it('services saturated classes at 60/30/10 without adding provider dispatches', () => {
    const service = new ScannerFairService();
    const queue = ['EXEC_PREFILTER_HIGH','DISCOVERY_HIGH','DISCOVERY_LOW'].flatMap((p) => Array.from({length:100}, (_, i) => ({p, deadline:i+1000})));
    const selected = Array.from({length:100}, () => service.take(queue, (j) => j.p, (j) => j.deadline)!);
    expect(selected.filter((j) => j.p === 'EXEC_PREFILTER_HIGH')).toHaveLength(60);
    expect(selected.filter((j) => j.p === 'DISCOVERY_HIGH')).toHaveLength(30);
    expect(selected.filter((j) => j.p === 'DISCOVERY_LOW')).toHaveLength(10);
  });
  it('bounds borrowed debt and reclaims the next protected slot for arriving P0', () => {
    const service = new ScannerFairService();
    const queue = Array.from({length:30}, () => ({p:'DISCOVERY_LOW',deadline:10000}));
    for (let i=0;i<20;i++) service.take(queue, (j)=>j.p, (j)=>j.deadline);
    expect(service.snapshot().borrowedDebt).toBeLessThanOrEqual(6);
    queue.push({p:'EXEC_PREFILTER_HIGH',deadline:1800});
    expect(service.take(queue,(j)=>j.p,(j)=>j.deadline)!.p).toBe('EXEC_PREFILTER_HIGH');
    expect(service.snapshot()).toMatchObject({borrowedDebt:0,reclaimed:6});
  });
  it('defers lossy history, bounds its queue and does not fail dispatch on persistence errors', () => {
    const pending: Array<()=>void> = []; let now=0;
    const buffer = new ScannerHistoryBuffer(2, (f)=>pending.push(f), ()=>now);
    const write=vi.fn(); expect(buffer.enqueue(write)).toBe(true);
    expect(buffer.enqueue(()=>{throw new Error('TEST_DISK_ERROR');})).toBe(true);
    expect(buffer.enqueue(write)).toBe(false); expect(write).not.toHaveBeenCalled();
    now=20; pending.shift()!(); pending.shift()!();
    expect(buffer.snapshot()).toMatchObject({queued:0,dropped:1,completed:1,failed:1,persistDelayMs:{p50:20}});
  });
  it('keeps quarantined/metadata-ineligible work on P2 and constrains supported P1', async () => {
    const getQuote=vi.fn(async (_params: QuoteParams) => ({} as never));
    const jupiter={name:'jupiter',getQuote} as QuoteProvider;
    const raptor={name:'raptor',getQuote} as QuoteProvider;
    const params={inputMint:'TEST_IN',outputMint:'TEST_OUT',amountAtomic:'50000',slippageBps:5};
    await executableSurfaceProvider(jupiter,[raptor],true).getQuote(params);
    expect(getQuote.mock.calls.at(-1)?.[0]).toMatchObject({priority:'DISCOVERY_HIGH',dexes:['Whirlpool'],maxAccounts:28});
    await executableSurfaceProvider(jupiter,[raptor],false).getQuote(params);
    expect(getQuote.mock.calls.at(-1)?.[0]).toMatchObject({priority:'DISCOVERY_LOW'});
    const raydium={name:'raydium',getQuote} as QuoteProvider;
    await executableSurfaceProvider(raydium,[jupiter],true).getQuote(params);
    expect(getQuote.mock.calls.at(-1)?.[0]).toMatchObject({priority:'DISCOVERY_LOW'});
  });
  it('preserves Retry-After and attributes observation-caused rate limiting', () => {
    expect(retryAfterMs('12')).toBe(12000); expect(retryAfterMs(null)).toBeUndefined(); expect(retryAfterMs('nonsense')).toBeUndefined();
    const admission=new QuoteAdmission('raptor',1000);
    admission.recordRateLimit('DISCOVERY_LOW',12000,'TEST_ID','250000');
    expect(admission.snapshot()).toMatchObject({rateLimits_P2:1,requestedCooldownMs_P2:12000,cooldownCause:{requestClass:'P2',traceId:'TEST_ID',amountAtomic:'250000'}});
  });
});

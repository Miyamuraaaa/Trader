import { afterEach, expect, it, vi } from 'vitest';
import { ComparisonBarrier, comparisonBarrier, installComparisonFetchBarrier, collectCountersBeforeTermination } from '../src/comparison-drain.js';
import { QuoteAdmission } from '../src/quote-admission.js';
import { ScannerRpcLimiter } from '../src/scanner-rpc-limiter.js';

afterEach(()=>vi.useRealTimers());
const work={id:'candidate',sourceLane:'EXECUTABLE_FAST_LANE',stage:'LEG1'};
it('is inert in normal production and requires verified no-broadcast for activation',()=>{
  const barrier=new ComparisonBarrier();
  barrier.begin(work)(); expect(barrier.snapshot()).toEqual([]);
  expect(()=>barrier.configure(false)).toThrow('COMPARISON_REQUIRES_NO_BROADCAST');
  barrier.assertOpen(); expect(barrier.active).toBe(false);
});
it('blocks new work, permits pre-barrier settlement, preserves deadlines and flushes early',async()=>{
  vi.useFakeTimers(); const barrier=new ComparisonBarrier();barrier.configure(true);
  const deadline=Object.freeze({parentDeadline:1800});const end=barrier.begin(work);
  const flush=vi.fn(async()=>{}),stop=vi.fn();const draining=barrier.drain(stop,flush);
  expect(()=>barrier.begin(work)).toThrow('COMPARISON_SCHEDULING_STOPPED');
  expect(()=>barrier.assertOpen()).toThrow();expect(flush).not.toHaveBeenCalled();
  end();end();await vi.advanceTimersByTimeAsync(1);
  const report=await draining;expect(report.drainCompletedCleanly).toBe(true);
  expect(report.drainDurationMs).toBeLessThan(10000);expect(flush).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);expect(deadline.parentDeadline).toBe(1800);
  expect(barrier.snapshot()).toEqual([]);
});
it('times out without inventing completion or running late flush',async()=>{
  vi.useFakeTimers();const barrier=new ComparisonBarrier();barrier.configure(true);
  const end=barrier.begin(work),flush=vi.fn(async()=>{});
  const draining=barrier.drain(()=>{},flush);await vi.advanceTimersByTimeAsync(10000);
  const report=await draining;expect(report.invalidReason).toBe('INVALID_RUN_DRAIN_TIMEOUT');
  expect(report.pendingAtDrainTimeout).toEqual([work]);expect(report.drainCompletedCleanly).toBe(false);
  end();await vi.advanceTimersByTimeAsync(1);expect(flush).not.toHaveBeenCalled();
});
it('invalidates failed diagnostic flush, without calling it a timeout',async()=>{
  vi.useFakeTimers();const barrier=new ComparisonBarrier();barrier.configure(true);
  const draining=barrier.drain(()=>{},async()=>{throw Error('disk');});
  await vi.advanceTimersByTimeAsync(1);const report=await draining;
  expect(report.invalidReason).toBe('INVALID_DIAGNOSTIC_FLUSH');expect(report.drainTimedOut).toBe(false);
});
it('collects final counter proof before executor termination',async()=>{
  const order:string[]=[];await collectCountersBeforeTermination(async()=>{order.push('counters');return 0;},()=>{order.push('terminate');});
  expect(order).toEqual(['counters','terminate']);
});
it('real quote/RPC dispatch boundaries and fetch reject post-barrier work without sends or leaked permits',async()=>{
  vi.useFakeTimers();comparisonBarrier.configure(true);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const quoteSend=vi.fn();const admission=new QuoteAdmission('raptor',0,()=>0,()=>1000);
  const quote=admission.request({inputMint:'a',outputMint:'b',amountAtomic:'50000',slippageBps:5,priority:'EXEC_PREFILTER_HIGH'},async deadline=>{
    await gate;return admission.dispatch(deadline,quoteSend);
  });
  const quoteRejected=expect(quote).rejects.toThrow('COMPARISON_SCHEDULING_STOPPED');
  const rpc=new ScannerRpcLimiter({maxConcurrency:1,minIntervalMs:0,baseCooldownMs:1,maxCooldownMs:10,recoverySuccesses:2});
  const started=rpc.run('already-sent',async()=>{await gate;return 1;});
  const rpcSend=vi.fn(async()=>2);const queued=rpc.run('queued',rpcSend);
  const rpcRejected=expect(queued).rejects.toThrow('COMPARISON_SCHEDULING_STOPPED');
  await vi.advanceTimersByTimeAsync(0);
  const original=globalThis.fetch;const httpSend=vi.fn(async()=>new Response('ok'));globalThis.fetch=httpSend;
  const restore=installComparisonFetchBarrier();
  try{
    comparisonBarrier.stop();
    await expect(fetch('https://example.invalid')).rejects.toThrow('COMPARISON_SCHEDULING_STOPPED');
    release();await started;await vi.advanceTimersByTimeAsync(1);await quoteRejected;await rpcRejected;
    expect(quoteSend).not.toHaveBeenCalled();expect(rpcSend).not.toHaveBeenCalled();expect(httpSend).not.toHaveBeenCalled();
    expect(rpc.snapshot()).toMatchObject({active:0,queued:0});
    expect(admission.snapshot().active_shared_requests).toBe(0);expect(comparisonBarrier.snapshot()).toEqual([]);
  }finally{restore();globalThis.fetch=original;}
});

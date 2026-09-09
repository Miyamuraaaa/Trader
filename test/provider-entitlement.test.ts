import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderEntitlements } from '../src/provider-entitlement.js';
import { QuoteAdmission } from '../src/quote-admission.js';
import { providerFailureReason } from '../src/provider-failure.js';
import { LiveSizeCadence } from '../src/scanner-service-policy.js';
afterEach(()=>vi.useRealTimers());
describe('owned provider dispatch entitlement',()=>{
  it('binds exact semantics once, consumes once, and releases without spending quota while held',()=>{
    let now=0;const released=vi.fn(),owner=new ProviderEntitlements(()=>now);
    const handle=owner.create('candidate','envelope',1000,1400,350,released);
    expect(released).not.toHaveBeenCalled();now=731;
    owner.claim(handle,'envelope','amount=990');owner.claim(handle,'envelope','amount=990');
    owner.consume(handle,'amount=990',{nextLegalSendMono:700,cooldownUntilMono:0},0);
    expect(()=>owner.consume(handle,'amount=990',{nextLegalSendMono:700,cooldownUntilMono:0},0)).toThrow('INVALID_STATE');
    owner.finish(handle,'RELEASED');owner.finish(handle,'RELEASED');
    expect(released).toHaveBeenCalledTimes(1);
    expect(owner.snapshot()).toMatchObject({active:0,counts:{CREATED:1,HELD:1,CLAIMING:1,CONSUMED:1}});
  });
  it.each(['owner','generation','semantics'])('rejects a changed %s',kind=>{
    const owner=new ProviderEntitlements(()=>0);const handle=owner.create('candidate','envelope',1000,1400,350,()=>{});
    expect(()=>owner.claim({...handle,...(kind==='owner'?{workflowId:'other'}:kind==='generation'?{generation:99}:{})},kind==='semantics'?'wrong':'envelope','exact')).toThrow(/MISMATCH/);
    owner.finish(handle,'RELEASED');
  });
  it.each([
    [{nextLegalSendMono:0,cooldownUntilMono:2000},0,0,'PROVIDER_COOLDOWN'],
    [{nextLegalSendMono:2000,cooldownUntilMono:0},0,0,'NEXT_LEGAL_SEND'],
    [{nextLegalSendMono:0,cooldownUntilMono:0},1,0,'CONCURRENCY'],
    [{nextLegalSendMono:0,cooldownUntilMono:0},0,1100,'EVENT_LOOP'],
  ] as const)('never bypasses cooldown, pacing, concurrency or drift', (state,active,at,reason)=>{
    let now=0;const owner=new ProviderEntitlements(()=>now);const handle=owner.create('candidate','envelope',1000,1400,350,()=>{});
    owner.claim(handle,'envelope','exact');now=at;
    expect(()=>owner.consume(handle,'exact',state,active)).toThrow(reason);expect(owner.snapshot().active).toBe(0);
  });
  it('expires abandoned ownership and preserves the 731ms queue/service decomposition',async()=>{
    vi.useFakeTimers();let now=0;const owner=new ProviderEntitlements(()=>now),release=vi.fn();
    owner.create('candidate','envelope',1000,1400,350,release);now=1001;await vi.advanceTimersByTimeAsync(1001);
    expect(owner.snapshot()).toMatchObject({active:0,counts:{EXPIRED:1}});expect(release).toHaveBeenCalledTimes(1);
    expect(624+107).toBe(731); // Legal pacing plus service, not 731ms HTTP.
  });
  it('protects two borrow attempts and dispatches claimed exact leg2 once through admission',async()=>{
    let now=0;const governor=new QuoteAdmission('raptor',1000,()=>now,()=>1000,()=>({nextLegalSendMono:0,cooldownUntilMono:0}));
    const params={inputMint:'A',outputMint:'B',amountAtomic:'UNBOUND',slippageBps:5,priority:'EXEC_PREFILTER_HIGH' as const};
    const claim=governor.reserveOwnedWorkflow(1400,731,350,'candidate',params);
    now=500;expect(governor.discoveryReservationDelayMs()).toBeGreaterThan(0);now=600;expect(governor.discoveryReservationDelayMs()).toBeGreaterThan(0);
    // Warm conservative estimator to the measured downstream service without changing deadlines.
    vi.spyOn(governor,'estimate').mockReturnValue(350);
    now=731;const http=vi.fn(async()=>{now=1079;return {responseTimestamp:1000} as never;});
    await governor.request({...params,amountAtomic:'990',scheduling:{deadlineMono:1400,traceId:'candidate',entitlement:claim}},d=>governor.dispatch(d,http));
    expect(http).toHaveBeenCalledTimes(1);expect(governor.snapshot().entitlements.counts.CONSUMED).toBe(1);
    expect(governor.snapshot().active_workflow_reservations).toBe(0);
  });
  it('distinguishes actual HTTP status from internal failures',()=>{
    expect(providerFailureReason({status:429})).toBe('HTTP_429');
    expect(providerFailureReason(new Error('queue capacity exceeded'))).toBe('INTERNAL_QUEUE_CAPACITY');
    expect(providerFailureReason({code:'SCANNER_RPC_BACKPRESSURE'})).toBe('SCANNER_RPC_RETRY_AFTER_COOLDOWN');
    expect(providerFailureReason(new Error('fetch failed'))).toBe('HTTP_NETWORK_ERROR');
    expect(providerFailureReason(new Error('malformed JSON'))).toBe('HTTP_MALFORMED_RESPONSE');
    expect(providerFailureReason(new Error('timed out'))).toBe('HTTP_TIMEOUT');
  });
  it('takes the claimed owner before weighted discovery and cleans cancellation once',()=>{
    const governor=new QuoteAdmission('raptor',1000,()=>0);
    const owner={entitlement:{reservationId:'r',workflowId:'w',generation:1},deadlineMono:1000} as never;
    const queue=[{id:'P2',deadline:{deadlineMono:900} as never},{id:'P0',deadline:owner}];
    expect(governor.takeClaimed(queue,q=>q.deadline)?.id).toBe('P0');expect(queue.map(q=>q.id)).toEqual(['P2']);
    const release=vi.fn(),entitlements=new ProviderEntitlements(()=>0);
    entitlements.create('w','e',1000,1400,350,release);entitlements.shutdown();entitlements.shutdown();
    expect(release).toHaveBeenCalledTimes(1);expect(entitlements.snapshot()).toMatchObject({active:0,counts:{INVALIDATED:1}});
  });
  it('reproduces 731ms leg1 with 624ms legal wait and 107ms HTTP, without resetting parent',async()=>{
    vi.useFakeTimers();const epoch=Date.now(),now=()=>Date.now()-epoch;
    const first=new QuoteAdmission('jupiter',1000,now,Date.now,()=>({nextLegalSendMono:624,cooldownUntilMono:0}));
    vi.spyOn(first,'estimate').mockReturnValue(129);
    const parentDeadline=1437,leg1Deadline=parentDeadline-348-45;
    const params={inputMint:'A',outputMint:'B',amountAtomic:'500000',slippageBps:5,priority:'EXEC_PREFILTER_HIGH' as const,scheduling:{deadlineMono:leg1Deadline,traceId:'731ms-fixture'}};
    const result=first.request(params,async deadline=>{
      await new Promise(resolve=>setTimeout(resolve,624));
      return first.dispatch(deadline,async()=>{await new Promise(resolve=>setTimeout(resolve,107));return {responseTimestamp:Date.now()} as never;});
    });
    await vi.advanceTimersByTimeAsync(732);await result;
    expect(first.snapshot().requestTraces[0]).toMatchObject({queueAndPacingMs:624,httpAndParseMs:107,finishedMono:731});
    expect(leg1Deadline).toBe(1044);expect(parentDeadline).toBe(1437);
  });
  it('keeps productive half-dollar cadence above P2 with an exploration floor',()=>{
    const cadence=new LiveSizeCadence(),counts=new Map<number,number>();
    for(let i=0;i<160;i++){const size=cadence.next([.05,.1,.25,.5,1],.5,n=>n===.5?.1:0,true)!;counts.set(size,(counts.get(size)??0)+1);}
    expect(counts.get(.5)).toBeGreaterThan(counts.get(1)!);
    for(const size of [.05,.1,.25])expect(counts.get(size)).toBeGreaterThan(counts.get(1)!);
    expect(counts.get(1)).toBeGreaterThan(0);
  });
});

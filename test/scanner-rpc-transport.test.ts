import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const installEnvironment = vi.hoisted(() => {
  const install = () => {
    // Vitest forks expose process.send too. Exercise scanner admission, not the
    // production isolated-executor bypass (live mode + IPC).
    vi.stubEnv('EXECUTION_MODE', 'paper');
    vi.stubEnv('LIVE_TRADING_ENABLED', 'false');
    vi.stubEnv('MAX_QUOTE_AGE_MS', '5000');
    vi.stubEnv('HTTP_TIMEOUT_MS', '5000');
  };
  install();
  return install;
});
vi.mock('dotenv/config', () => ({}));
beforeEach(installEnvironment);
afterEach(() => vi.unstubAllEnvs());
import { performance } from 'node:perf_hooks';
import { ScannerRpcLimiter } from '../src/scanner-rpc-limiter.js';
import { ScannerRpcEndpoint,scannerRpcEndpoint,scannerEndpointId,registerScannerRpcGovernor } from '../src/scanner-rpc-transport.js';
const context={label:'meteora.quote',priority:'RPC_P1_EXECUTABLE_DISCOVERY_SUPPORT' as const,liveDependency:true};
const payload={id:1,method:'getMultipleAccounts',params:[['fixture'],{commitment:'confirmed'}]};
const response={result:{context:{slot:100}}};
const create=(interval=10)=>new ScannerRpcEndpoint('test-endpoint',new ScannerRpcLimiter({maxConcurrency:1,minIntervalMs:interval,baseCooldownMs:100,maxCooldownMs:100,recoverySuccesses:2}));
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(performance,'now').mockImplementation(()=>Date.now());});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('scanner HTTP-boundary admission',()=>{
  it('rejects duplicate endpoint governors',()=>{
    const url='https://duplicate.invalid',first=scannerRpcEndpoint(url);
    expect(()=>registerScannerRpcGovernor(url,new ScannerRpcEndpoint(first.endpointId,create().limiter))).toThrow('DUPLICATE_RPC_GOVERNOR');
  });
  it('does not coalesce live support behind queued broad refreshes',async()=>{
    const rpc=create(),work=vi.fn(async()=>response);
    const low=rpc.read(payload,'web3',work,{}, {...context,priority:'LOW'});
    const high=rpc.read(payload,'web3',work,{},context);
    await vi.advanceTimersByTimeAsync(20);await Promise.all([low,high]);expect(work).toHaveBeenCalledTimes(2);
  });
  it('keeps feasible P1 through cooldown and drains at legal pacing while shedding P2',async()=>{
    const rpc=create(10),sends:number[]=[];
    await rpc.read(payload,'web3',async()=>{throw Object.assign(new Error('limited'),{status:429,retryAfterMs:100});},{},context).catch(()=>{});
    const work=async()=>{sends.push(performance.now());return response;};
    const start=performance.now();
    const a=rpc.read(payload,'web3',work,{deadlineMono:start+300},context);
    const b=rpc.read({...payload,params:['different']},'web3',work,{deadlineMono:start+300},context);
    await expect(rpc.read(payload,'web3',work,{}, {...context,priority:'LOW'})).rejects.toThrow('backpressure');
    await vi.advanceTimersByTimeAsync(99);expect(sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30);await Promise.all([a,b]);expect(sends[0]!-start).toBeGreaterThanOrEqual(100);expect(sends[1]!-sends[0]!).toBeGreaterThanOrEqual(10);
  });
  it('shares canonical endpoints and never exposes credentials in identity',()=>{
    const first=scannerRpcEndpoint('https://example.invalid/?key=TEST_ONLY&a=1'),second=scannerRpcEndpoint('https://example.invalid/?a=1&key=TEST_ONLY');
    expect(first).toBe(second);expect(scannerEndpointId('https://example.invalid/?key=TEST_ONLY')).not.toContain('TEST_ONLY');
  });
  it('coalesces exact reads but rebinds JSON RPC response IDs',async()=>{
    const rpc=create(),work=vi.fn(async()=>response);
    const a=rpc.read(payload,'web3',work,{},context),b=rpc.read({...payload,id:2},'web3',work,{},context);
    expect((await a).id).toBe(1);expect((await b).id).toBe(2);expect(work).toHaveBeenCalledTimes(1);expect(rpc.snapshot().activeShared).toBe(0);
  });
  it.each(['commitment','context','adapter'])('does not coalesce changed %s semantics',async(kind)=>{
    const rpc=create(),work=vi.fn(async()=>response);
    const a=rpc.read(payload,'web3',work,{},context),b=rpc.read({...payload,params:kind==='adapter'?payload.params:[['fixture'],kind==='context'?{minContextSlot:1}:{commitment:'finalized'}]},kind==='adapter'?'kit':'web3',work,{},context);
    await vi.advanceTimersByTimeAsync(30);await Promise.all([a,b]);expect(work).toHaveBeenCalledTimes(2);
  });
  it('expired waiter detaches without cancelling another valid waiter',async()=>{
    const rpc=create();let complete!:(value:typeof response)=>void;const work=vi.fn(()=>new Promise<typeof response>(r=>complete=r));
    const a=rpc.read(payload,'web3',work,{deadlineMono:performance.now()+20},context).catch(e=>e.message);
    const b=rpc.read({...payload,id:2},'web3',work,{deadlineMono:performance.now()+100},context);
    await vi.advanceTimersByTimeAsync(21);expect(await a).toBe('QUEUE_DEADLINE');complete(response);expect((await b).id).toBe(2);expect(work).toHaveBeenCalledTimes(1);
  });
  it('checks each waiter context separately and does not cache invalid responses',async()=>{
    const rpc=create(),work=vi.fn(async()=>response);
    const a=rpc.read(payload,'web3',work,{minContextSlot:101,cacheTtlMs:20},context).catch(e=>e.message),b=rpc.read(payload,'web3',work,{minContextSlot:99},context);
    expect(await a).toBe('RPC_FRESHNESS_OR_CONTEXT_MISMATCH');await b;expect(rpc.snapshot().cacheEntries).toBe(0);
  });
  it('bounds waiters and clears all shared entries',async()=>{
    const rpc=create(),work=vi.fn(async()=>response);
    const results=await Promise.all(Array.from({length:40},()=>rpc.read(payload,'web3',work,{},context).catch(e=>e.message)));
    expect(results.filter(r=>r==='RPC_WAITER_BOUND')).toHaveLength(8);expect(rpc.snapshot().activeShared).toBe(0);
  });
  it('supports fresh/expired/old-slot advisory entries but bypasses P0',async()=>{
    const rpc=create(0),work=vi.fn(async()=>response);
    await rpc.read(payload,'web3',work,{cacheTtlMs:20},context);await rpc.read(payload,'web3',work,{cacheTtlMs:20},context);
    expect(work).toHaveBeenCalledTimes(1);expect(rpc.snapshot().traces.at(-1)?.cache).toBe('HIT_FRESH');
    await vi.advanceTimersByTimeAsync(21);await rpc.read(payload,'web3',work,{cacheTtlMs:20},context);expect(rpc.snapshot().traces.at(-1)?.cache).toBe('MISS_EXPIRED');
    await rpc.read(payload,'web3',work,{minContextSlot:101},context).catch(()=>{});expect(rpc.snapshot().traces.at(-1)?.cache).toBe('MISS_SLOT_TOO_OLD');
    await rpc.read(payload,'web3',work,{}, {...context,priority:'RPC_P0_EXECUTION_CRITICAL'});expect(rpc.snapshot().traces.at(-1)?.cache).toBe('BYPASS_SAFETY_CRITICAL');
  });
  it('records real 429 source and sheds cooldown work without sending it',async()=>{
    const rpc=create(),work=vi.fn(async()=>{throw Object.assign(new Error('fixture'),{status:429,retryAfterMs:100});});
    await expect(rpc.read(payload,'web3',work,{},context)).rejects.toThrow('HTTP_429');
    await expect(rpc.read(payload,'web3',work,{}, {label:'broad.refresh',priority:'LOW'})).rejects.toThrow('backpressure');
    expect(work).toHaveBeenCalledTimes(1);expect(rpc.snapshot().traces.at(-1)?.cooldownSource).toBeTruthy();expect(rpc.snapshot().counts.http429).toBe(1);
    await vi.advanceTimersByTimeAsync(101);await rpc.read(payload,'web3',async()=>response,{},context);
  });
  it('individual SDK fan-out sends are paced rather than one unpaced task burst',async()=>{
    const rpc=create(100),sent:number[]=[];
    const jobs=Array.from({length:4},(_,i)=>rpc.read({...payload,params:[[String(i)]]},'web3',async()=>{sent.push(performance.now());return response;},{},context));
    await vi.advanceTimersByTimeAsync(401);await Promise.all(jobs);expect(sent.slice(1).map((n,i)=>n-sent[i]!)).toEqual([100,100,100]);
    expect(rpc.snapshot().burstWindows['100']).toBe(1);
  });
  it('rejects deadline-infeasible queued work and never submits transactions',async()=>{
    const rpc=create(100);await rpc.read(payload,'web3',async()=>response,{},context);
    const work=vi.fn(async()=>response);await expect(rpc.read({...payload,params:[['different']]},'web3',work,{deadlineMono:performance.now()+10},context)).rejects.toThrow('INTERNAL_PACING_DEADLINE');
    await expect(rpc.read({method:'sendTransaction'},'web3',work)).rejects.toThrow('NON_READ_RPC_BLOCKED');expect(work).not.toHaveBeenCalled();
  });
});

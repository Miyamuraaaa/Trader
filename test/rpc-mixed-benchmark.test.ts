import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const installEnvironment = vi.hoisted(() => {
  const install = () => {
    // Keep the mixed fixture on scanner admission even in an IPC test worker.
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
import { ScannerRpcLimiter,type ScannerRpcPriority } from '../src/scanner-rpc-limiter.js';
import { ScannerRpcEndpoint } from '../src/scanner-rpc-transport.js';
import { summarizeRpcTraces } from '../src/rpc-soak-report.js';
it('deterministic mixed SDK fan-out benchmark: HTTP pacing and exact dedupe, zero broadcasts',async()=>{
  vi.useFakeTimers();vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
  try{
    const run=async(guarded:boolean)=>{
      const start=performance.now();let nextLegal=-Infinity;const before:Array<Record<string,unknown>>=[];
      const rpc=new ScannerRpcEndpoint('fixture-endpoint',new ScannerRpcLimiter({maxConcurrency:1,minIntervalMs:100,baseCooldownMs:150,maxCooldownMs:150,recoverySuccesses:2}));
      for(let batch=0;batch<12;batch++){
        await vi.advanceTimersByTimeAsync(Math.max(0,start+batch*5000-performance.now()));
        const cls=['P0','P1','P2'][batch%3]!,priority:ScannerRpcPriority=cls==='P0'?'RPC_P0_EXECUTION_CRITICAL':cls==='P1'?'RPC_P1_EXECUTABLE_DISCOVERY_SUPPORT':'LOW';
        const jobs=['A','A','B','C'].map((key,index)=>{
          const created=performance.now(),semantic=`${batch}:${key}`;
          const work=async()=>{const sent=performance.now(),limited=sent<nextLegal;if(!limited)nextLegal=sent+100;
            await new Promise(resolve=>setTimeout(resolve,20));
            if(!guarded)before.push({rpcRequestId:`${batch}:${index}`,semanticHash:semantic,endpointId:'fixture-endpoint',method:'getMultipleAccounts',class:cls,task:'fixture.sdk',createdMono:created,httpStartMono:sent,httpEndMono:performance.now(),totalMs:performance.now()-created,result:limited?'HTTP_429':'SENT_SUCCESS',cooldownIssuedMs:limited&&index===1?150:0,waits:{queue:0,pacing:0,cooldown:0,concurrency:0}});
            if(limited)throw Object.assign(new Error('fixture 429'),{status:429,retryAfterMs:150});return {result:{context:{slot:100}}};};
          return (guarded?rpc.read({id:index,method:'getMultipleAccounts',params:[[semantic],{commitment:'confirmed'}]},'web3',work,{}, {label:'fixture.sdk',priority,liveDependency:cls==='P1'}):work()).catch(()=>undefined);
        });
        await vi.advanceTimersByTimeAsync(500);await Promise.all(jobs);
      }
      return summarizeRpcTraces(guarded?rpc.snapshot().traces:before,60000);
    };
    const before=await run(false),after=await run(true);
    expect(before.total.sent).toBe(48);expect(before.total.rateLimits).toBe(36);expect(after.total.sent).toBe(40);expect(after.total.rateLimits).toBe(0);expect(after.total.coalescedServed).toBe(8);expect(after.total.usefulCompletionRate).toBe(1);
    console.log('SYNTHETIC MIXED RPC BENCHMARK; 60s virtual workload; no network or market claim',JSON.stringify({before,after}));
  }finally{vi.restoreAllMocks();vi.useRealTimers();}
});

import { createHash,randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Connection,type ConnectionConfig } from '@solana/web3.js';
import { createDefaultRpcTransport,createSolanaRpcFromTransport,mainnet,type RpcTransport } from '@solana/kit';
import { CONFIG,SCANNER_RPC_CONFIG } from './config.js';
import { ScannerRpcLimiter,scannerRpcLimiter,scannerRpcContext,type RpcTaskContext } from './scanner-rpc-limiter.js';

function canonical(value:unknown):unknown {
  if(typeof value==='bigint')return {integer:value.toString()};
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function scannerEndpointId(endpoint:string){const url=new URL(endpoint);url.hash='';url.searchParams.sort();return hash(url.toString()).slice(0,20);}
const taskName=(label:string)=>/^[\w.:-]+$/.test(label)?label.split('.').slice(0,3).join('.'):'REDACTED_TASK';
const percentile=(values:number[])=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return {count:a.length,p50:a[Math.ceil(a.length*.5)-1]??null,p90:a[Math.ceil(a.length*.9)-1]??null,p99:a[Math.ceil(a.length*.99)-1]??null,max:a.at(-1)??null};};
type Envelope={id?:unknown;method:string;params?:unknown};
type Reply={result?:{context?:{slot?:number|bigint}};error?:{code?:number;message?:string};id?:unknown};
export interface ReadRequirements { deadlineMono?:number; maxAgeMs?:number; minContextSlot?:number; cacheTtlMs?:number; bypass?:boolean; signal?:AbortSignal }
const coalescible=new Set(['getAccountInfo','getMultipleAccounts','getRecentPrioritizationFees','getMinimumBalanceForRentExemption']);
export class ScannerRpcEndpoint {
  private shared=new Map<string,{promise:Promise<{value:Reply;received:number}>;waiters:number;controller:AbortController}>();
  private cache=new Map<string,{value:Reply;received:number;expires:number}>();
  private traces:Array<Record<string,unknown>>=[];
  private counts:Record<string,number>={};
  private groups=new Map<string,{calls:number;sent:number;http429:number;cooldownMs:number;failures:number}>();
  private service:number[]=[];
  private sends:number[]=[];
  private cooldownSource:string|undefined;
  constructor(readonly endpointId:string,readonly limiter:ScannerRpcLimiter){}
  private count(name:string){this.counts[name]=(this.counts[name]??0)+1;}
  async read(payload:Envelope,adapter:string,work:(signal?:AbortSignal)=>Promise<Reply>,requirements:ReadRequirements={},context:RpcTaskContext=scannerRpcContext.getStore()??{label:'unattributed.scanner',priority:'LOW'}):Promise<Reply>{
    // Shared Orca primitives can be imported by the isolated executor. Never share scanner cache/admission there.
    if(typeof process.send==='function'&&CONFIG.executionMode==='live')return work();
    if(!/^get[A-Z]/.test(payload.method))throw new Error('SCANNER_NON_READ_RPC_BLOCKED');
    const created=performance.now(),deadline=Math.min(requirements.deadlineMono??Infinity,context.deadlineMono??Infinity,created+CONFIG.httpTimeoutMs,created+(requirements.bypass?CONFIG.httpTimeoutMs:CONFIG.maxQuoteAgeMs));
    const params=payload.params;
    const key=hash({endpoint:this.endpointId,adapter,method:payload.method,params});
    const requestId=randomUUID(),priority=context.priority,cls=priority==='RPC_P0_EXECUTION_CRITICAL'?'P0':priority==='HIGH'||priority==='RPC_P1_EXECUTABLE_DISCOVERY_SUPPORT'?'P1':'P2';
    const groupKey=[payload.method,cls,taskName(context.label)].join(':');
    if(!this.groups.has(groupKey)&&this.groups.size<128)this.groups.set(groupKey,{calls:0,sent:0,http429:0,cooldownMs:0,failures:0});
    const group=this.groups.get(groupKey);if(group)group.calls++;
    const trace:Record<string,unknown>={rpcRequestId:requestId,candidateId:context.traceId,endpointId:this.endpointId,method:payload.method,semanticHash:key,class:cls,task:taskName(context.label),liveDependency:context.liveDependency??false,createdMono:created,deadlineMono:deadline,admission:this.limiter.admissionState(),cooldownSource:this.cooldownSource,cache:'MISS_ABSENT',coalescing:'NOT_ELIGIBLE'};
    this.count('calls');
    const minSlot=requirements.minContextSlot??Number((Array.isArray(params)?params.find(v=>v&&typeof v==='object'&&'minContextSlot' in v):undefined)?.minContextSlot??0);
    const valid=(entry:{value:Reply;received:number})=>performance.now()<deadline&&performance.now()-entry.received<=(requirements.maxAgeMs??CONFIG.maxQuoteAgeMs)&&(!minSlot||Number(entry.value.result?.context?.slot??-1)>=minSlot);
    const eligible=coalescible.has(payload.method)&&cls!=='P0'&&!requirements.bypass;
    // Never strand live support behind an identical low-priority queued refresh.
    const sharedKey=key+':'+cls;
    const cached=eligible?this.cache.get(key):undefined;
    try{
      if(!eligible)trace.cache='BYPASS_SAFETY_CRITICAL';
      if(cached){trace.cacheAgeMs=created-cached.received;trace.sourceSlot=String(cached.value.result?.context?.slot??'unknown');
        if(cached.expires>created&&valid(cached)){trace.cache='HIT_FRESH';trace.result='CACHE_SERVED';this.count('cache_hits');return {...cached.value,id:payload.id};}
        trace.cache=cached.expires<=created?'MISS_EXPIRED':minSlot?'MISS_SLOT_TOO_OLD':'MISS_EXPIRED';this.cache.delete(key);
      }
      let shared=eligible?this.shared.get(sharedKey):undefined;
      if(shared){trace.coalescing='WAITER';this.count('coalescing_hits');}
      else {
        if(this.shared.size>=128)throw new Error('RPC_INFLIGHT_BOUND');
        trace.coalescing=eligible?'LEADER':'NOT_ELIGIBLE';
        const serviceMs=this.service.length?percentile(this.service).p90!:0;
        const controller=new AbortController();
        const promise=this.limiter.run(taskName(context.label),async()=>{
          const timeout=setTimeout(()=>controller.abort(),CONFIG.httpTimeoutMs);
          trace.httpStartMono=performance.now();trace.dispatch=this.limiter.admissionState();this.sends.push(performance.now());this.sends=this.sends.slice(-10000);this.count('sent');if(group)group.sent++;
          try{
            const value=await work(controller.signal);
            if(!value||typeof value!=='object'||(!('result' in value)&&!value.error))throw new Error('MALFORMED_RESPONSE');
            if(value.error){const limited=value.error.code===429||/rate.?limit|too many requests/i.test(value.error.message??'');throw Object.assign(new Error(limited?'RPC_RATE_LIMIT_ERROR':'RPC_RESPONSE_ERROR'),{rpcCode:value.error.code,status:limited?429:undefined});}
            const received=performance.now();trace.httpEndMono=received;this.service.push(received-Number(trace.httpStartMono));this.service=this.service.slice(-256);
            return {value,received};
          }catch(error){
            const e=error as {status?:number;retryAfterMs?:number;rpcCode?:number;context?:{statusCode?:number;headers?:Headers}};
            const status=e.status??e.context?.statusCode;
            const retry=e.context?.headers?.get('retry-after');
            if(retry&&e.retryAfterMs===undefined){const seconds=Number(retry);e.retryAfterMs=Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(retry)-Date.now());}
            if(status===429){this.cooldownSource=requestId;this.count(e.rpcCode?'rpc_rate_limit':'http429');if(group){group.http429++;group.cooldownMs+=e.retryAfterMs??SCANNER_RPC_CONFIG.baseCooldownMs;}trace.status=status;trace.retryAfterMs=e.retryAfterMs;}
            trace.rpcErrorCode=e.rpcCode;trace.httpEndMono=performance.now();
            throw Object.assign(new Error(status===429?(e.rpcCode?'RPC_RATE_LIMIT_ERROR':'HTTP_429'):error instanceof Error&&/MALFORMED|RPC_RESPONSE/.test(error.message)?error.message:'NETWORK_ERROR'),{status,retryAfterMs:e.retryAfterMs});
          }finally{clearTimeout(timeout);}
        },priority,{signal:controller.signal,deadlineMono:deadline,serviceMs,liveDependency:context.liveDependency,onDispatch:timing=>{trace.waits=timing;trace.dequeuedMono=performance.now();}});
        shared={promise,waiters:0,controller};
        if(eligible){this.shared.set(sharedKey,shared);void promise.finally(()=>this.shared.delete(sharedKey)).catch(()=>{});}
      }
      if(shared.waiters>=32)throw new Error('RPC_WAITER_BOUND');shared.waiters++;
      let timer:ReturnType<typeof setTimeout>|undefined;let abort:(()=>void)|undefined;
      try{
        const entry=await Promise.race([shared.promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('QUEUE_DEADLINE')),Math.max(0,deadline-performance.now()));abort=()=>reject(new Error('CANCELLED'));requirements.signal?.addEventListener('abort',abort,{once:true});if(requirements.signal?.aborted)abort();})]);
        if(!valid(entry))throw new Error('RPC_FRESHNESS_OR_CONTEXT_MISMATCH');
        if(eligible&&(requirements.cacheTtlMs??0)>0){this.cache.set(key,{...entry,expires:entry.received+Math.min(requirements.cacheTtlMs!,requirements.maxAgeMs??CONFIG.maxQuoteAgeMs)});while(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);}
        trace.result=trace.coalescing==='WAITER'?'COALESCED_SERVED':'SENT_SUCCESS';trace.sourceSlot=String(entry.value.result?.context?.slot??'unknown');return {...entry.value,id:payload.id};
      }finally{shared.waiters--;if(shared.waiters===0)shared.controller.abort();if(timer)clearTimeout(timer);if(abort)requirements.signal?.removeEventListener('abort',abort);}
    }catch(error){const message=error instanceof Error?error.message:'NETWORK_ERROR';trace.result=/backpressure/i.test(message)?'PROVIDER_COOLDOWN_DROP':/^[A-Z_0-9]+$/.test(message)?message:'NETWORK_ERROR';if(trace.result==='HTTP_429'||trace.result==='RPC_RATE_LIMIT_ERROR')trace.cooldownIssuedMs=Math.max(0,this.limiter.admissionState().cooldownUntilMono-performance.now());this.count(String(trace.result));if(group)group.failures++;throw error;}
    finally{trace.deliveryMono=performance.now();trace.totalMs=performance.now()-created;this.traces.push(trace);this.traces=this.traces.slice(-2048);}
  }
  snapshot(){const gap=this.sends.slice(1).map((t,i)=>t-this.sends[i]!);return {endpointId:this.endpointId,counts:{...this.counts},groups:Object.fromEntries(this.groups),activeShared:this.shared.size,cacheEntries:this.cache.size,governor:this.limiter.snapshot(),interArrivalMs:percentile(gap),burstWindows:Object.fromEntries([100,1000,10000].map(window=>{let start=0,max=0;for(let i=0;i<this.sends.length;i++){while(this.sends[i]!-this.sends[start]!>=window)start++;max=Math.max(max,i-start+1);}return [window,max];})),traces:[...this.traces]};}
}
const endpoints=new Map<string,ScannerRpcEndpoint>();let reused=0,duplicates=0;
export function registerScannerRpcGovernor(endpoint:string,governor:ScannerRpcEndpoint){const id=scannerEndpointId(endpoint);if(governor.endpointId!==id)throw new Error('RPC_ENDPOINT_ID_MISMATCH');if(endpoints.has(id)&&endpoints.get(id)!==governor){duplicates++;throw new Error('DUPLICATE_RPC_GOVERNOR');}if(!endpoints.has(id)&&endpoints.size>=16)throw new Error('RPC_ENDPOINT_BOUND');endpoints.set(id,governor);return governor;}
export function scannerRpcEndpoint(endpoint:string){const id=scannerEndpointId(endpoint);let governor=endpoints.get(id);if(governor){reused++;return governor;}governor=new ScannerRpcEndpoint(id,id===scannerEndpointId(CONFIG.rpcUrl)?scannerRpcLimiter:new ScannerRpcLimiter(SCANNER_RPC_CONFIG));return registerScannerRpcGovernor(endpoint,governor);}
export function scannerRpcTransportSnapshot(since?:Map<string,number>){return {registryReuses:reused,duplicateGovernors:duplicates,endpoints:[...endpoints.values()].map(e=>{const value=e.snapshot();if(since){value.traces=value.traces.filter(t=>Number(t.deliveryMono)>(since.get(e.endpointId)??-Infinity));if(value.traces.length)since.set(e.endpointId,Math.max(...value.traces.map(t=>Number(t.deliveryMono))));}return value;})};}
export function scannerConnection(endpoint:string,options:ConnectionConfig={},task='scanner.sdk'){
  const governor=scannerRpcEndpoint(endpoint);
  const fetcher:typeof fetch=async(input,init)=>{
    if(typeof init?.body!=='string')throw new Error('SCANNER_RPC_BODY_UNSUPPORTED');const payload=JSON.parse(init.body) as Envelope;
    const value=await governor.read(payload,'web3',async(signal)=>{const response=await fetch(input,{...init,signal:signal??init.signal});if(!response.ok){const retry=response.headers.get('retry-after');const seconds=Number(retry);const retryAfterMs=retry===null?undefined:Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(retry)-Date.now());throw Object.assign(new Error('HTTP_ERROR'),{status:response.status,retryAfterMs});}return await response.json() as Reply;},{signal:init.signal??undefined,bypass:/wallet|balance/.test(task)},scannerRpcContext.getStore()??{label:task,priority:'LOW'});
    return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
  };
  return new Connection(endpoint,{...options,disableRetryOnRateLimit:true,fetch:fetcher});
}
export function scannerKitRpc(endpoint:string){const governor=scannerRpcEndpoint(endpoint),transport=createDefaultRpcTransport({url:mainnet(endpoint)});const wrapped:RpcTransport=async(config)=>governor.read(config.payload as Envelope,'kit',(signal)=>transport({...config,signal:signal??config.signal}),{signal:config.signal}) as never;return createSolanaRpcFromTransport(wrapped as typeof transport);}

type Trace=Record<string,unknown>;
export function rpcPercentiles(values:number[]){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return {count:a.length,p50:a[Math.ceil(a.length*.5)-1]??null,p90:a[Math.ceil(a.length*.9)-1]??null,p99:a[Math.ceil(a.length*.99)-1]??null,max:a.at(-1)??null};}
/** Definition: useful uniqueness is exact semantics per one-second evidence bucket, successfully delivered. */
export function summarizeRpcTraces(input:Trace[],durationMs:number){
  const traces=[...new Map(input.map(t=>[t.rpcRequestId,t])).values()];
  const groups=new Map<string,Trace[]>();for(const t of traces){const key=[t.endpointId,t.method,t.class,t.task].join(':');const g=groups.get(key)??[];g.push(t);groups.set(key,g);}
  const summarize=(rows:Trace[])=>{
    const sent=rows.filter(t=>typeof t.httpStartMono==='number'),useful=rows.filter(t=>['SENT_SUCCESS','COALESCED_SERVED','CACHE_SERVED'].includes(String(t.result)));
    const uniqueUseful=new Set(useful.map(t=>`${t.semanticHash}:${Math.floor(Number(t.createdMono)/1000)}`)).size;
    const count=(status:string)=>rows.filter(t=>t.result===status).length;
    const rateLimits=count('HTTP_429')+count('RPC_RATE_LIMIT_ERROR'),skips=count('PROVIDER_COOLDOWN_DROP');
    const timing=(name:string)=>rpcPercentiles(sent.map(t=>Number((t.waits as Record<string,number>|undefined)?.[name]??0)));
    return {calls:rows.length,sent:sent.length,uniqueSemantics:new Set(rows.map(t=>t.semanticHash)).size,uniqueUseful,rateLimits,cooldownDrops:skips,
      rateLimitsPerMinute:rateLimits/(durationMs/60000),rateLimitsPer1000UniqueUseful:uniqueUseful?rateLimits*1000/uniqueUseful:null,
      cooldownMsPerMinute:rows.reduce((n,t)=>n+Number(t.cooldownIssuedMs??0),0)/(durationMs/60000),cooldownDropsPer1000UniqueUseful:uniqueUseful?skips*1000/uniqueUseful:null,
      coalescedServed:count('COALESCED_SERVED'),cacheServed:count('CACHE_SERVED'),usefulCompletionRate:rows.length?useful.length/rows.length:0,
      queueMs:timing('queue'),pacingMs:timing('pacing'),concurrencyMs:timing('concurrency'),cooldownWaitMs:timing('cooldown'),
      httpMs:rpcPercentiles(sent.filter(t=>typeof t.httpEndMono==='number').map(t=>Number(t.httpEndMono)-Number(t.httpStartMono))),endToEndMs:rpcPercentiles(rows.map(t=>Number(t.totalMs)))};
  };
  return {definition:'Unique useful = successfully delivered exact semantic hash per one-second creation bucket; not trade success.',total:summarize(traces),byEndpointMethodClassTask:Object.fromEntries([...groups].map(([key,value])=>[key,summarize(value)]))};
}

/** Comparison-only lifecycle. No configuration, signer, transport or trading imports. */
export interface PendingMeasurementWork { id:string; sourceLane:string|null; stage:string }
export class ComparisonStoppedError extends Error { readonly code='COMPARISON_SCHEDULING_STOPPED'; constructor(){super('COMPARISON_SCHEDULING_STOPPED');} }
export class ComparisonBarrier {
  private enabled=false;
  private closedAt:number|null=null;
  private sequence=0;
  private work=new Map<number,PendingMeasurementWork>();
  private listeners=new Set<()=>void>();
  private stopListeners=new Set<()=>void>();
  constructor(private readonly now=()=>performance.now()){}
  configure(noBroadcastVerified:boolean){if(!noBroadcastVerified)throw new Error('COMPARISON_REQUIRES_NO_BROADCAST');this.enabled=true;}
  get active(){return this.enabled;}
  get stopped(){return this.enabled&&this.closedAt!==null;}
  assertOpen(){if(this.stopped)throw new ComparisonStoppedError();}
  onStop(callback:()=>void){if(!this.enabled)return()=>{};this.stopListeners.add(callback);return()=>this.stopListeners.delete(callback);}
  stop(){if(!this.enabled)throw new Error('COMPARISON_NOT_CONFIGURED');if(this.closedAt===null){this.closedAt=this.now();for(const callback of this.stopListeners)callback();this.stopListeners.clear();}return this.closedAt;}
  begin(meta:PendingMeasurementWork){if(!this.enabled)return()=>{};this.assertOpen();return this.retain(meta);}
  private retain(meta:PendingMeasurementWork){const key=++this.sequence;this.work.set(key,meta);let done=false;return()=>{if(done)return;done=true;this.work.delete(key);for(const notify of this.listeners)notify();};}
  track<T>(meta:PendingMeasurementWork,work:Promise<T>):Promise<T>{if(!this.enabled)return work;const end=this.retain(meta);return work.finally(end);}
  snapshot(){return [...this.work.values()].map(v=>({...v}));}
  idle(signal?:AbortSignal):Promise<boolean>{return new Promise(resolve=>{
    let settled=false;
    const finish=(clean:boolean)=>{if(settled)return;settled=true;this.listeners.delete(check);signal?.removeEventListener('abort',abort);resolve(clean);};
    const check=()=>{if(!this.work.size)setImmediate(()=>{if(!this.work.size)finish(true);});};
    const abort=()=>finish(false);this.listeners.add(check);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else check();
  });}
  async drain(stopScheduling:()=>void,flush:()=>Promise<void>,hardCapMs=10000){
    if(!Number.isInteger(hardCapMs)||hardCapMs<1000||hardCapMs>15000)throw new Error('INVALID_COMPARISON_DRAIN_CAP');
    const drainStartedAt=this.now(),measurementSchedulingStoppedAt=this.stop();stopScheduling();
    let stage='PRE_BARRIER_WORK';let timer:ReturnType<typeof setTimeout>|undefined;let timedOut=false;const cancel=new AbortController();
    const settled=this.idle(cancel.signal).then(async idle=>{if(!idle)return false;stage='DIAGNOSTIC_FLUSH';await flush();stage='COMPLETE';return true;}).catch(()=>{stage='DIAGNOSTIC_FLUSH_FAILED';return false;});
    let clean=false;
    try{clean=await Promise.race([settled,new Promise<false>(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve(false);},hardCapMs);})]);}finally{if(timer)clearTimeout(timer);cancel.abort();}
    const drainEndedAt=this.now();
    return {measurementSchedulingStoppedAt,drainStartedAt,drainEndedAt,drainDurationMs:drainEndedAt-drainStartedAt,drainHardCapMs:hardCapMs,
      drainCompletedCleanly:clean,drainTimedOut:timedOut,pendingAtDrainTimeout:clean?[]:[...this.snapshot(),...(stage.startsWith('DIAGNOSTIC_FLUSH')?[{id:'diagnostics',sourceLane:null,stage}]:[])],
      invalidReason:clean?null:timedOut?'INVALID_RUN_DRAIN_TIMEOUT':'INVALID_DIAGNOSTIC_FLUSH'};
  }
}
export const comparisonBarrier=new ComparisonBarrier();
export async function collectCountersBeforeTermination<T>(collect:()=>Promise<T>,terminate:()=>void):Promise<T>{const result=await collect();terminate();return result;}
/** Installed only by the two no-broadcast comparison entrypoints, before SDK imports. */
export function installComparisonFetchBarrier(){
  if(!comparisonBarrier.active)throw new Error('COMPARISON_NOT_CONFIGURED');
  const original=globalThis.fetch;
  globalThis.fetch=(...args)=>{
    try{comparisonBarrier.assertOpen();return comparisonBarrier.track({id:'http',sourceLane:null,stage:'HTTP_IN_FLIGHT'},original(...args));}
    catch(error){return Promise.reject(error);}
  };
  return()=>{globalThis.fetch=original;};
}

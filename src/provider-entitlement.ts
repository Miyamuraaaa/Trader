import { randomUUID } from 'node:crypto';
export interface EntitlementClaim { reservationId: string; workflowId: string; generation: number }
type State = 'HELD' | 'CLAIMING' | 'CONSUMED' | 'RELEASED' | 'EXPIRED' | 'INVALIDATED' | 'FAILED_AFTER_CONSUME';
type RecordState = EntitlementClaim & { state: State; envelope: string; exactKey?: string; claimBy: number; parentDeadline: number; serviceMs: number; release: () => void; timer: ReturnType<typeof setTimeout> };
export class EntitlementError extends Error {
  readonly code: string;
  constructor(readonly reason: string) { super(`RESERVATION_${reason}`); this.code = this.message; }
}
/** Owned by the provider admission/dispatch governor; it cannot send HTTP or mint quota. */
export class ProviderEntitlements {
  private records = new Map<string, RecordState>();
  private generation = 0;
  private events: Array<EntitlementClaim & { at: number; state: string; reason?: string }> = [];
  private counts: Record<string, number> = {};
  constructor(private readonly now: () => number) {}
  private event(record: EntitlementClaim, state: string, reason?: string) {
    this.counts[state] = (this.counts[state] ?? 0) + 1;
    this.events.push({ ...record, reservationId: record.reservationId, workflowId:record.workflowId, generation:record.generation, at:this.now(),state,reason });
    // Do not retain functions, raw semantics, endpoints or transaction data in telemetry.
    this.events = this.events.map(({reservationId,workflowId,generation,at,state,reason})=>({reservationId,workflowId,generation,at,state,reason})).slice(-256);
  }
  create(workflowId: string, envelope: string, claimBy: number, parentDeadline: number, serviceMs: number, release: () => void): EntitlementClaim {
    if (this.records.size >= 16 || claimBy <= this.now()) { release(); throw new EntitlementError('INVALID_STATE'); }
    const handle = { reservationId:randomUUID(),workflowId,generation:++this.generation };
    let released=false;
    const releaseOnce=()=>{if(!released){released=true;release();}};
    const timer=setTimeout(()=>this.finish(handle,'EXPIRED',this.records.get(handle.reservationId)?.state==='CLAIMING'?'EVENT_LOOP_DISPATCH_DRIFT':'OWNER_DID_NOT_CLAIM'),Math.max(0,claimBy-this.now())); timer.unref?.();
    this.records.set(handle.reservationId,{...handle,state:'HELD',envelope,claimBy,parentDeadline,serviceMs,release:releaseOnce,timer});
    this.event(handle,'CREATED');this.event(handle,'HELD');return handle;
  }
  private owned(handle: EntitlementClaim): RecordState {
    const record=this.records.get(handle.reservationId);
    if (!record) throw new EntitlementError('INVALID_STATE');
    if (record.workflowId!==handle.workflowId) throw new EntitlementError('OWNER_MISMATCH');
    if (record.generation!==handle.generation) throw new EntitlementError('GENERATION_MISMATCH');
    return record;
  }
  claim(handle: EntitlementClaim,envelope:string,exactKey:string) {
    const record=this.owned(handle);
    if (this.now()>record.claimBy) { this.finish(handle,'EXPIRED','L1_LATE');throw new EntitlementError('EXPIRED'); }
    if (record.envelope!==envelope || (record.exactKey!==undefined&&record.exactKey!==exactKey)) {
      this.finish(handle,'INVALIDATED','SEMANTIC_MISMATCH');throw new EntitlementError('SEMANTIC_MISMATCH');
    }
    if (record.state==='CLAIMING') return;
    if (record.state!=='HELD') throw new EntitlementError('INVALID_STATE');
    record.exactKey=exactKey;record.state='CLAIMING';this.event(handle,'CLAIMING');
  }
  consume(handle: EntitlementClaim,exactKey:string,state:{nextLegalSendMono:number;cooldownUntilMono:number},active:number) {
    const record=this.owned(handle),now=this.now();
    const fail=(reason:string):never=>{this.finish(handle,'EXPIRED',reason);throw new EntitlementError(reason);};
    if (record.state!=='CLAIMING'||record.exactKey!==exactKey) throw new EntitlementError('INVALID_STATE');
    if (state.cooldownUntilMono>now) fail('PROVIDER_COOLDOWN_BEYOND_DEADLINE');
    if (state.nextLegalSendMono>now) fail('NEXT_LEGAL_SEND_AFTER_CLAIM_BY');
    if (active>0) fail('CONCURRENCY_UNAVAILABLE');
    if (now>record.claimBy||now+record.serviceMs>record.parentDeadline) fail('EVENT_LOOP_DISPATCH_DRIFT');
    record.state='CONSUMED';clearTimeout(record.timer);record.release();this.event(handle,'CONSUMED');
  }
  finish(handle: EntitlementClaim,state: 'RELEASED'|'EXPIRED'|'INVALIDATED'|'FAILED_AFTER_CONSUME',reason?:string) {
    const record=this.records.get(handle.reservationId);if(!record)return;
    this.owned(handle);clearTimeout(record.timer);record.release();
    if(record.state!=='CONSUMED'||state==='FAILED_AFTER_CONSUME')this.event(handle,state,reason);
    this.records.delete(handle.reservationId);
  }
  snapshot(){return {counts:{...this.counts},active:this.records.size,events:[...this.events]};}
  shutdown(){for(const record of [...this.records.values()])this.finish(record,'INVALIDATED','CANCELED');}
}

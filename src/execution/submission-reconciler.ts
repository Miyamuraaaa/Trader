import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { Connection } from '@solana/web3.js';
import { SUBMISSION_POSSIBLE_STATES,hasRecoveryMetadata,terminalAccountingMatches,type PersistentExecutionJournal,type ExecutionRecord } from './execution-journal.js';
import { confirmAndAccountForCycle,type ConfirmedCycleAccounting } from './confirmation-accounting.js';
import { confirmedRiskPnl,type PersistentRiskManager } from './risk-manager.js';

export const RECONCILIATION_VERSION=1;
export interface RecoveryObservation {landed:boolean;accounting?:ConfirmedCycleAccounting;failed?:boolean}
interface RecoveryOptions {
  journal:PersistentExecutionJournal;risk:PersistentRiskManager;
  observe:(signature:string,record:ExecutionRecord)=>Promise<RecoveryObservation>;
  height:()=>Promise<number>;now?:()=>number;pollMs:number;maxObservationAgeMs:number;
  endpoint:string;commitment:'confirmed'|'finalized';solPriceAtomic?:bigint;
}
/** No signer, transaction builder or transport exists in this coordinator. */
export class SubmissionReconciler {
  private heights=new Map<string,{height:number;at:number;first:number;firstHeight:number}>();
  private highWater=new Map<string,{height:number;at:number}>();
  private busy=false;
  readonly counters={ticks:0,landed:0,expired:0,blocked:0};
  private observations:Array<Record<string,unknown>>=[];
  snapshot(){return {...this.counters,observations:[...this.observations]};}
  private observeEvent(event:Record<string,unknown>){this.observations.push(event);this.observations=this.observations.slice(-128);}
  constructor(private readonly options:RecoveryOptions){}
  async tick():Promise<'CLEAR'|'RECONCILIATION_ONLY'|'SETTLED'>{
    if(this.busy)return 'RECONCILIATION_ONLY';this.busy=true;this.counters.ticks++;
    const o=this.options,now=o.now??(()=>performance.now());let record:ExecutionRecord|undefined;
    try{
      const settled=o.risk.snapshot().settled;
      const records=o.journal.all().filter(r=>SUBMISSION_POSSIBLE_STATES.has(r.state)||(['CONFIRMED','TRANSACTION_FAILED','EXPIRED_UNLANDED'].includes(r.state)&&!Object.hasOwn(settled,r.id)));
      if(records.length>1)throw new Error('MULTIPLE_UNRESOLVED_SUBMISSIONS');
      record=records[0];if(!record)return 'CLEAR';
      if(!hasRecoveryMetadata(record)||record.recoveryBlockedReason)throw new Error('LEGACY_UNRESOLVED: INSUFFICIENT_LEGACY_METADATA');
      const observe=async()=>{const started=now();const result=await o.observe(record!.signature!,record!);this.observeEvent({id:record!.id,kind:'SIGNATURE_LOOKUP',endpoint:o.endpoint,commitment:o.commitment,observedMono:now(),latencyMs:now()-started,landed:result.landed});if(now()-started>o.maxObservationAgeMs)throw new Error('STALE_RECOVERY_OBSERVATION');return result;};
      const settle=async(result:RecoveryObservation)=>{
        if(!result.landed)return false;
        const terminal=!SUBMISSION_POSSIBLE_STATES.has(record!.state);
        if(terminal){
          if(record!.state==='EXPIRED_UNLANDED')throw new Error('CONTRADICTORY_TERMINAL_LANDING');
          if(!result.accounting)return false;
          if(!terminalAccountingMatches(record!,result.accounting,result.failed===true))throw new Error('CONFLICTING_TERMINAL_ACCOUNTING');
        }else await o.journal.observeRecovery(record!.id,{observedLanded:true,observedCommitment:result.accounting?.observedCommitment});
        this.heights.delete(record!.id);
        if(!result.accounting)return false;
        const a=result.accounting;
        if(a.signature!==record!.signature)throw new Error('RECOVERY_SIGNATURE_MISMATCH');
        if(!a.observedCommitment||(o.commitment==='finalized'&&a.observedCommitment!=='finalized'))throw new Error('RECOVERY_COMMITMENT_MISMATCH');
        const debit=a.before.solLamports-a.after.solLamports;
        if(!o.solPriceAtomic)throw new Error('RECOVERY_COST_CONVERSION_UNAVAILABLE');
        const financialEvidence=[record!.id,a.signature,a.actualFeeLamports,a.before.baseAmount,a.before.solLamports,a.before.intermediateAmount,a.after.baseAmount,a.after.solLamports,a.after.intermediateAmount,a.realizedBasePnlAtomic,a.intermediateDustAtomic].map(String);
        const evidenceHash=createHash('sha256').update(JSON.stringify(financialEvidence)).digest('hex');
        await o.risk.recordConfirmed(record!.id,confirmedRiskPnl(a.realizedBasePnlAtomic,debit>a.actualFeeLamports?debit:a.actualFeeLamports,o.solPriceAtomic),result.failed===true,record!.signature,'LANDED',evidenceHash);
        await o.journal.recordAccounting(record!.id,a,result.failed===true);this.highWater.delete(record!.id);this.counters.landed++;return true;
      };
      const first=await observe();if(first.landed)return await settle(first)?'SETTLED':'RECONCILIATION_ONLY';
      if(record.observedLanded||record.state==='CONFIRMED'||record.state==='TRANSACTION_FAILED')return 'RECONCILIATION_ONLY';
      const started=now(),height=await o.height(),at=now();
      this.observeEvent({id:record.id,kind:'BLOCK_HEIGHT',endpoint:o.endpoint,commitment:o.commitment,height,observedMono:at,latencyMs:at-started});
      if(at-started>o.maxObservationAgeMs||!Number.isSafeInteger(height)||height<0)throw new Error('STALE_OR_INVALID_BLOCK_HEIGHT');
      const previous=this.heights.get(record.id),watermark=this.highWater.get(record.id);
      if(watermark&&(height<watermark.height||at<watermark.at))throw new Error('NON_MONOTONIC_BLOCK_HEIGHT');
      this.highWater.set(record.id,{height,at});
      if(height<=record.lastValidBlockHeight!){this.heights.set(record.id,{height,at,first:at,firstHeight:height});return 'RECONCILIATION_ONLY';}
      const qualifies=previous&&previous.height>record.lastValidBlockHeight!&&at-previous.at<=o.maxObservationAgeMs;
      const firstAt=qualifies?previous.first:at;
      const firstHeight=qualifies?previous.firstHeight:height;
      this.heights.set(record.id,{height,at,first:firstAt,firstHeight});
      if(!qualifies||at-firstAt<o.pollMs)return 'RECONCILIATION_ONLY';
      // Final status AND transaction observation happens after qualifying height.
      const final=await observe();if(final.landed)return await settle(final)?'SETTLED':'RECONCILIATION_ONLY';
      const finalLookupMono=now();
      if(now()-at>o.maxObservationAgeMs)throw new Error('STALE_FINAL_BLOCK_HEIGHT');
      await o.risk.recordConfirmed(record.id,0n,false,record.signature,'UNLANDED');
      if(now()-at>o.maxObservationAgeMs)throw new Error('STALE_BLOCK_HEIGHT_AFTER_RISK_PERSISTENCE');
      await o.journal.recordUnlanded(record.id,{endpoint:o.endpoint,commitment:o.commitment,height,observedMono:at,latencyMs:at-started,firstHeight,firstObservedMono:firstAt,finalLookupMono,pollMs:o.pollMs});
      this.heights.delete(record.id);this.highWater.delete(record.id);this.counters.expired++;return 'SETTLED';
    }catch(error){if(record)this.heights.delete(record.id);this.counters.blocked++;throw error;}
    finally{this.busy=false;}
  }
}

export function chainRecoveryObserver(connection:Connection,commitment:'confirmed'|'finalized'){
  let lastContextSlot=-1;
  return async(signature:string,record:ExecutionRecord):Promise<RecoveryObservation>=>{
    const statuses=await connection.getSignatureStatuses([signature],{searchTransactionHistory:true});
    if(!Array.isArray(statuses.value)||statuses.value.length!==1||!Number.isSafeInteger(statuses.context?.slot))throw new Error('MALFORMED_RECOVERY_STATUS');
    if(statuses.context.slot<lastContextSlot)throw new Error('NON_MONOTONIC_RECOVERY_CONTEXT');
    lastContextSlot=statuses.context.slot;
    const status=statuses.value[0];
    if(status){
      if(status.confirmationStatus!==commitment&&!(commitment==='confirmed'&&status.confirmationStatus==='finalized'))return {landed:true};
      const accounting=await confirmAndAccountForCycle(connection,{signature,wallet:record.wallet!,baseMint:record.baseMint!,intermediateMint:record.intermediateMint!,commitment,returnFailedAccounting:true});
      return {landed:true,accounting,failed:accounting.failed};
    }
    const transaction=await connection.getTransaction(signature,{commitment,maxSupportedTransactionVersion:0});
    if(transaction===undefined)throw new Error('MALFORMED_RECOVERY_TRANSACTION');
    // Contradictory status/transaction sources cannot establish absence.
    return {landed:transaction!==null};
  };
}

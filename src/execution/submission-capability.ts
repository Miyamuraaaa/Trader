import { assertLiveSubmissionAllowed,type LiveSubmissionGuardConfig } from './live-guard.js';
import { OneShotBroadcaster,type OneShotBroadcasterOptions,type SubmissionTransport } from './broadcaster.js';
import type { PersistentExecutionJournal } from './execution-journal.js';
import type { PersistentRiskManager } from './risk-manager.js';
const issued=new WeakSet<object>();
export interface SubmissionCapability {readonly kind:'NO_BROADCAST'|'LIVE_SUBMISSION_ALLOWED'}
const counts={broadcasterFactory:0,transportConstruction:0,broadcasterSubmit:0,transportSend:0,submittedSignatures:0};
export const submissionCounters=()=>({...counts});
export function createSubmissionCapability(noBroadcast:boolean,config:LiveSubmissionGuardConfig,ready:boolean):SubmissionCapability{
  if(noBroadcast){if(config.liveTradingEnabled)throw new Error('Contradictory no-broadcast capability');}
  else assertLiveSubmissionAllowed(ready,config);
  const cap=Object.freeze({kind:noBroadcast?'NO_BROADCAST' as const:'LIVE_SUBMISSION_ALLOWED' as const});issued.add(cap);return cap;
}
/** Reject before executing the transport factory; no independent environment read. */
export function createSubmissionBroadcaster(cap:SubmissionCapability,transportFactory:()=>SubmissionTransport,journal:PersistentExecutionJournal,risk:PersistentRiskManager,options:OneShotBroadcasterOptions){
  if(!issued.has(cap)||cap.kind!=='LIVE_SUBMISSION_ALLOWED')throw new Error('NO_BROADCAST: submission capability denied');
  counts.broadcasterFactory++;
  const transport=transportFactory();counts.transportConstruction++;
  const wrapped:SubmissionTransport={kind:transport.kind,async submitExactSignedBytes(bytes){counts.transportSend++;const signature=await transport.submitExactSignedBytes(bytes);counts.submittedSignatures++;return signature;}};
  const broadcaster=new OneShotBroadcaster(wrapped,journal,risk,options);
  return {submit:async(...args:Parameters<OneShotBroadcaster['submit']>)=>{counts.broadcasterSubmit++;return broadcaster.submit(...args);}};
}

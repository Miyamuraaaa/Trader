import { CONFIG,DECIMALS } from '../config.js';
import { toAtomic } from '../math.js';
import { PersistentExecutionJournal,SUBMISSION_POSSIBLE_STATES,hasRecoveryMetadata } from './execution-journal.js';
import { PersistentRiskManager } from './risk-manager.js';
import { EXECUTABLE_POLICY_HASH } from './executable-route-policy.js';
import { validateLiveCriticalConfig } from './live-config-validation.js';
import { createSubmissionCapability } from './submission-capability.js';
import { EXECUTION_IMPLEMENTATION_READY } from './readiness-manifest.js';
export function createPersistentExecutionRisk(){return new PersistentRiskManager({maxTrades:CONFIG.maxTradesPerSession,maxConsecutiveFailures:CONFIG.maxExecutionConsecutiveFailures,maxSessionLossAtomic:BigInt(toAtomic(CONFIG.maxSessionLossUsdc,DECIMALS.USDC)),maxDailyLossAtomic:BigInt(toAtomic(CONFIG.maxDailyLossUsdc,DECIMALS.USDC)),maxSingleTradeLossAtomic:BigInt(toAtomic(CONFIG.maxSingleTradeLossUsdc,DECIMALS.USDC))});}
export async function bootstrapExecutor(noBroadcast:boolean,journal=new PersistentExecutionJournal(),risk=createPersistentExecutionRisk()){
  validateLiveCriticalConfig(CONFIG);
  // Validate mode guards before accessing any signer. Authority remains automatic.
  const capability=createSubmissionCapability(noBroadcast,CONFIG,EXECUTION_IMPLEMENTATION_READY);
  await journal.load();await journal.checkpoint();await risk.load();
  await journal.recoverInterruptedPreSubmission();
  const unresolved=journal.unresolved().filter(r=>SUBMISSION_POSSIBLE_STATES.has(r.state));
  let state:'READY_FOR_SIGNER'|'RECONCILIATION_ONLY'|'LEGACY_UNRESOLVED_BLOCKED'|'NOT_READY'='READY_FOR_SIGNER';
  let reason:string|undefined;
  if(unresolved.length>1){state='NOT_READY';reason='MULTIPLE_UNRESOLVED_SUBMISSIONS';}
  else if(unresolved.some(r=>!hasRecoveryMetadata(r)||r.recoveryBlockedReason)){state='LEGACY_UNRESOLVED_BLOCKED';reason='INSUFFICIENT_LEGACY_METADATA';}
  else if(unresolved.length){state='RECONCILIATION_ONLY';}
  else {
    try {risk.assertCanExecute('bootstrap-readiness');}catch{state='NOT_READY';reason='PERSISTENT_RISK_GATE';}
  }
  // Policy changes may not authorize fresh submissions against an old pending route.
  const policyCompatible=unresolved.every(r=>r.policyHash===EXECUTABLE_POLICY_HASH);
  const missingRisk=journal.all().filter(r=>(['CONFIRMED','TRANSACTION_FAILED','EXPIRED_UNLANDED'].includes(r.state)||(['ACCOUNTING_FAILED','SUBMISSION_FAILED'].includes(r.state)&&!!r.signature))&&!Object.hasOwn(risk.snapshot().settled,r.id));
  if(missingRisk.length){
    if(unresolved.length+missingRisk.length>1){state='NOT_READY';reason='MULTIPLE_UNRESOLVED_SETTLEMENTS';}
    else if(missingRisk.every(r=>hasRecoveryMetadata(r)&&['CONFIRMED','TRANSACTION_FAILED','EXPIRED_UNLANDED'].includes(r.state))){state='RECONCILIATION_ONLY';reason='TERMINAL_JOURNAL_RISK_SETTLEMENT_MISSING';}
    else{state='LEGACY_UNRESOLVED_BLOCKED';reason='TERMINAL_JOURNAL_RISK_SETTLEMENT_MISSING';}
  }
  return {state,reason,journal,risk,capability,policyCompatible};
}

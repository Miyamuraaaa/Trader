import { performance } from 'node:perf_hooks';
export type RecoveryReadiness='UNVERIFIED'|'READY_FOR_SIGNER'|'READY_FOR_NEW_SUBMISSIONS'|'RECONCILIATION_ONLY'|'LEGACY_UNRESOLVED_BLOCKED'|'NOT_READY'|'NO_BROADCAST';
let current:{state:RecoveryReadiness;updatedAt:number}={state:'UNVERIFIED',updatedAt:0};
let receivedMono=-Infinity;
export function setRecoveryReadiness(state:RecoveryReadiness){current={state,updatedAt:Date.now()};receivedMono=performance.now();}
export function recoveryReadiness(){const fresh=performance.now()-receivedMono<=5000;return {...current,heartbeatFresh:fresh,healthyForReconciliation:fresh&&current.state==='RECONCILIATION_ONLY',readyForNewSubmissions:fresh&&current.state==='READY_FOR_NEW_SUBMISSIONS'};}

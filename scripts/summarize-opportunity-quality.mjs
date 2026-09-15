// Offline report only: never imports runtime configuration, signer or broadcaster.
import { readFile } from 'node:fs/promises';
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const funnel = report.snapshot?.funnel;
const quality = funnel?.quality;
const legacy = report.telemetrySchemaVersion !== 2 || funnel?.telemetrySchemaVersion !== 2
  || !report.runId || funnel?.runId !== report.runId
  || (report.samples ?? []).some(s=>s.funnel?.telemetrySchemaVersion !== 2 || s.funnel?.runId !== report.runId);
const counts = report.submissionCounts;
const counterNames = ['broadcasterFactory','transportConstruction','broadcasterSubmit','transportSend','submittedSignatures'];
const unsafe = [counts,...(report.samples??[]).map(s=>s.submissionCounts),report.snapshot?.submissionCounts].some(c=>counterNames.some(k => Number(c?.[k]) > 0))
  || ['approvals','submissions','submittedSignatures','broadcasts'].some(k=>Number(report[k])>0);
const completeCounters = counterNames.every(k => counts?.[k] === 0);
const ledgers = [funnel?.rawPrefilter?.last15m, funnel?.executableObservations];
const invariant = ledgers.some(l => !l || ['unreconciled','duplicateTerminalCount','missingTerminalCount'].some(k=>l[k]!==0));
const integrity=report.diagnosticIntegrity;
const drain=report.drain;
const integrityComplete=integrity&&['criticalOverflowCount','ordinaryDropCount','writeFailureCount','pendingCriticalAtFinalize','diagnosticPartsWritten','diagnosticBytesWritten'].every(k=>Number.isFinite(integrity[k])&&integrity[k]>=0)
  &&Array.isArray(integrity.invalidReasons)&&'lastSuccessfulDiagnosticWriteAt' in integrity&&'diagnosticDirectory' in integrity;
const drainComplete=drain&&['drainStartedAt','drainEndedAt','drainDurationMs','drainHardCapMs','measurementSchedulingStoppedAt'].every(k=>Number.isFinite(drain[k]))
  &&drain.drainHardCapMs>=1000&&drain.drainHardCapMs<=15000&&drain.drainEndedAt>=drain.drainStartedAt
  &&drain.drainDurationMs>=0&&Array.isArray(drain.pendingAtDrainTimeout)&&drain.pendingAtDrainTimeout.length===0&&drain.drainCompletedCleanly===true&&drain.drainTimedOut===false;
const proofComplete=report.finalCountersReceived===true&&Number.isFinite(report.finalCountersCollectedAt)&&Number.isFinite(report.executorTerminatedAt)&&report.finalCountersCollectedAt<=report.executorTerminatedAt;
const coverageComplete=Array.isArray(quality?.lanes)&&Array.isArray(quality?.surfaces)&&typeof quality.wholeBotConclusionEligible==='boolean'&&Array.isArray(quality.wholeBotConclusionIneligibleReasons);
let previous = 0;
const samples = report.samples ?? [];
const gaps = samples.some(sample => { const delta = sample.elapsedMs - previous; previous = sample.elapsedMs; return !Number.isFinite(delta) || delta < 0 || delta > 90000; });
const invalid = legacy || !completeCounters || !report.zeroBroadcastVerified || !report.validProductionSoak
  || report.partial || report.comparison !== true || !quality?.diagnostics?.valid || quality?.diagnostics?.pendingCritical > 0 || invariant
  || gaps || samples.length === 0 || !Number.isFinite(report.requestedDurationMs) || previous < report.requestedDurationMs;
const invalidCompletion=!integrityComplete||integrity.diagnosticEvidenceValid!==true||integrity.invalidReasons.length>0||integrity.criticalOverflowCount>0||integrity.writeFailureCount>0||integrity.pendingCriticalAtFinalize!==0||!drainComplete||!proofComplete||!coverageComplete;
const fast = quality?.lanes?.find(l => l.lane === 'EXECUTABLE_FAST_LANE');
const control = quality?.lanes?.find(l => l.lane === 'UNRESTRICTED_CONTROL');
// No arbitrary improvement target; sample sufficiency is reported, not a claim of market success.
const sufficient = fast?.completedEconomicEvaluations >= 20 && Object.values(control?.providers ?? {}).reduce((n,p)=>n+(p.broadEconomicClassifications??0),0) >= 20;
const verdict = unsafe ? 'FAIL' : invalid||invalidCompletion ? 'INVALID_RUN' : sufficient ? 'PASS_MEASUREMENT_ONLY' : 'INSUFFICIENT_SAMPLE_FOR_LANE_COMPARISON';
console.log(JSON.stringify({ verdict, warning: legacy ? 'LEGACY_RAW_POSITIVE_COHORT_CONTAINS_UNPROVEN_FAST_LANE_ATTEMPTS' : undefined,
  telemetrySchemaVersion:report.telemetrySchemaVersion,runId:report.runId,buildCommit:report.buildCommit,requestedDurationMs:report.requestedDurationMs,durationMs:report.durationMs,
  continuity:report.continuity,zeroBroadcastVerified:report.zeroBroadcastVerified,submissionCounts:counts,
  diagnosticIntegrity:integrity,drain,invalidReason:drain?.drainTimedOut?'INVALID_RUN_DRAIN_TIMEOUT':undefined,
  cohorts:funnel?.session,rawReconciliation:ledgers[0],executableReconciliation:ledgers[1],quality,
  conclusion:'No lane-usefulness or profitability claim follows from PASS_MEASUREMENT_ONLY; inspect normalized yield, pressure and latency together.' },null,2));

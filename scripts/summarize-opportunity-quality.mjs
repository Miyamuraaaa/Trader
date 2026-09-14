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
const unsafe = counterNames.some(k => Number(counts?.[k]) > 0);
const completeCounters = counterNames.every(k => counts?.[k] === 0);
const ledgers = [funnel?.rawPrefilter?.last15m, funnel?.executableObservations];
const invariant = ledgers.some(l => !l || l.unreconciled || l.duplicateTerminalCount || l.missingTerminalCount);
let previous = 0;
const samples = report.samples ?? [];
const gaps = samples.some(sample => { const delta = sample.elapsedMs - previous; previous = sample.elapsedMs; return !Number.isFinite(delta) || delta < 0 || delta > 90000; });
const invalid = legacy || !completeCounters || !report.zeroBroadcastVerified || !report.validProductionSoak
  || report.partial || report.comparison !== true || !quality?.diagnostics?.valid || quality?.diagnostics?.pendingCritical > 0 || invariant
  || gaps || samples.length === 0 || !Number.isFinite(report.requestedDurationMs) || previous < report.requestedDurationMs;
const fast = quality?.lanes.find(l => l.lane === 'EXECUTABLE_FAST_LANE');
const control = quality?.lanes.find(l => l.lane === 'UNRESTRICTED_CONTROL');
// No arbitrary improvement target; sample sufficiency is reported, not a claim of market success.
const sufficient = fast?.completedEconomicEvaluations >= 20 && Object.values(control?.providers ?? {}).reduce((n,p)=>n+(p.broadEconomicClassifications??0),0) >= 20;
const verdict = unsafe ? 'FAIL' : invalid ? 'INVALID_RUN' : sufficient ? 'PASS_MEASUREMENT_ONLY' : 'INSUFFICIENT_SAMPLE_FOR_LANE_COMPARISON';
console.log(JSON.stringify({ verdict, warning: legacy ? 'LEGACY_RAW_POSITIVE_COHORT_CONTAINS_UNPROVEN_FAST_LANE_ATTEMPTS' : undefined,
  telemetrySchemaVersion:report.telemetrySchemaVersion,runId:report.runId,buildCommit:report.buildCommit,requestedDurationMs:report.requestedDurationMs,durationMs:report.durationMs,
  continuity:report.continuity,zeroBroadcastVerified:report.zeroBroadcastVerified,submissionCounts:counts,
  cohorts:funnel?.session,rawReconciliation:ledgers[0],executableReconciliation:ledgers[1],quality,
  conclusion:'No lane-usefulness or profitability claim follows from PASS_MEASUREMENT_ONLY; inspect normalized yield, pressure and latency together.' },null,2));

import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

it.each([
  ['complete', 'PASS_MEASUREMENT_ONLY'],
  ['small', 'INSUFFICIENT_SAMPLE_FOR_LANE_COMPARISON'],
  ['legacy', 'INVALID_RUN'],
  ['mixed-run', 'INVALID_RUN'],
  ['gap', 'INVALID_RUN'],
  ['unreconciled', 'INVALID_RUN'],
  ['pending-critical', 'INVALID_RUN'],
  ['critical-overflow', 'INVALID_RUN'],
  ['drain-timeout', 'INVALID_RUN'],
  ['missing-counter-proof', 'INVALID_RUN'],
  ['ordinary-drop', 'PASS_MEASUREMENT_ONLY'],
  ['send', 'FAIL'],
] as const)('offline comparison summary: %s', async (mode, verdict) => {
  const dir = await mkdtemp(join(tmpdir(), 'trader-quality-summary-'));
  try {
    const ledger = { unreconciled: mode === 'unreconciled' ? 1 : 0, duplicateTerminalCount: 0, missingTerminalCount: 0 };
    const funnel = { telemetrySchemaVersion: 2, runId: 'fixture', session: {}, rawPrefilter: { last15m: ledger }, executableObservations: ledger,
      quality: { surfaces: [], wholeBotConclusionEligible: false, wholeBotConclusionIneligibleReasons: ['PARTIAL_COVERAGE'], diagnostics: { valid: mode !== 'critical-overflow', pendingCritical: mode === 'pending-critical' ? 1 : 0 }, lanes: [
        { lane: 'EXECUTABLE_FAST_LANE', completedEconomicEvaluations: mode === 'small' ? 1 : 20 },
        { lane: 'UNRESTRICTED_CONTROL', providers: { pair: { broadEconomicClassifications: 20 } } },
      ] } };
    const samples = Array.from({ length: 30 }, (_, n) => ({ elapsedMs: (n + 1) * 30000, funnel }));
    if (mode === 'gap') samples[0] = { ...samples[0]!, elapsedMs: 100000 };
    if (mode === 'mixed-run') samples[0] = { ...samples[0]!, funnel: { ...funnel, runId: 'other' } };
    const file = join(dir, 'report.json');
    await writeFile(file, JSON.stringify({ telemetrySchemaVersion: mode === 'legacy' ? 1 : 2, runId: 'fixture', requestedDurationMs: 900000,
      comparison: true, validProductionSoak: true, zeroBroadcastVerified: true, snapshot: { funnel }, samples,
      diagnosticIntegrity: { diagnosticEvidenceValid: mode !== 'critical-overflow', invalidReasons: [], criticalOverflowCount: mode === 'critical-overflow' ? 1 : 0, ordinaryDropCount: mode === 'ordinary-drop' ? 3 : 0, writeFailureCount: 0, pendingCriticalAtFinalize: mode === 'pending-critical' ? 1 : 0, diagnosticPartsWritten: 1, diagnosticBytesWritten: 100, lastSuccessfulDiagnosticWriteAt: 900000, diagnosticDirectory: 'fixture' },
      drain: { drainStartedAt: 900000, drainEndedAt: 900001, drainDurationMs: 1, drainHardCapMs: 10000, measurementSchedulingStoppedAt: 900000, pendingAtDrainTimeout: [], drainCompletedCleanly: mode !== 'drain-timeout', drainTimedOut: mode === 'drain-timeout' },
      finalCountersReceived: mode !== 'missing-counter-proof', finalCountersCollectedAt: 900002, executorTerminatedAt: 900003,
      submissionCounts: { broadcasterFactory: 0, transportConstruction: 0, broadcasterSubmit: 0, transportSend: mode === 'send' ? 1 : 0, submittedSignatures: 0 } }));
    const result = spawnSync(process.execPath, ['scripts/summarize-opportunity-quality.mjs', file], { encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).verdict).toBe(verdict);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { log } from '../logger.js';

export type LiveCandidateOutcome = 'READY_TO_EXECUTE' | 'EXPIRED' | 'REJECTED';

export interface LiveCandidateWindowEntry {
  identity: string;
  outcome: LiveCandidateOutcome;
  reason?: string;
  lastCompletedStage?: string;
  candidateToOutcomeMs: number;
  recordedAt: number;
}

const recent: LiveCandidateWindowEntry[] = [];

/**
 * Observability-only rolling window. It never changes execution economics.
 * Its purpose is to reveal whether a non-essential scanner gate is starving
 * the executor, versus a real technical/economic rejection.
 */
export function recordLiveCandidateOutcome(entry: LiveCandidateWindowEntry): void {
  recent.push(entry);
  if (recent.length > 5) recent.splice(0, recent.length - 5);
  const accepted = recent.filter((item) => item.outcome === 'READY_TO_EXECUTE').length;
  const expired = recent.filter((item) => item.outcome === 'EXPIRED').length;
  const rejected = recent.filter((item) => item.outcome === 'REJECTED').length;
  const reasons = new Map<string, number>();
  for (const item of recent) {
    if (item.outcome === 'READY_TO_EXECUTE') continue;
    const key = item.reason ?? 'unspecified';
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  const dominant = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
  log.info('LIVE_CANDIDATE_WINDOW', {
    sampleSize: recent.length,
    readyToExecute: accepted,
    expired,
    rejected,
    targetReadyToExecute: 2,
    targetMet: recent.length < 5 || accepted >= 2,
    dominantBlocker: dominant?.[0],
    dominantBlockerCount: dominant?.[1],
    latest: entry,
  });
  if (recent.length === 5 && accepted < 2) {
    log.warn('Live candidate acceptance target is below 2/5; inspect dominant blocker before relaxing any hard execution gate', {
      accepted, expired, rejected, dominantBlocker: dominant?.[0],
    });
  }
}

export function getLiveCandidateWindow(): readonly LiveCandidateWindowEntry[] {
  return recent.map((entry) => ({ ...entry }));
}

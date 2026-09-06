import { log } from '../logger.js';
import type { ExecutionNetworkTiming } from './network-profiler.js';

export type ExecutionRejectionCategory =
  | 'NOT_PROFITABLE' | 'BELOW_MIN_ROI' | 'LOW_CONFIDENCE' | 'STALE'
  | 'SLIPPAGE_MOVED' | 'SIMULATION_FAILED' | 'INSUFFICIENT_BALANCE'
  | 'UNSUPPORTED_ROUTE' | 'TOKEN_POLICY' | 'TRANSACTION_TOO_LARGE'
  | 'COMPUTE_LIMIT' | 'RPC_TIMEOUT' | 'JOURNAL_BLOCKED' | 'STARTUP_FAILURE'
  | 'VALIDATION_FAILED';

export interface LatestExecutionStage {
  stage: string;
  reachedAt: number;
  elapsedFromCandidateMs: number;
}

const latestNonTerminalStage = new Map<string, LatestExecutionStage>();
const rollingStageTimings: Array<{
  segment: string;
  elapsedMs: number;
  completedAt: number;
}> = [];
const MAX_STAGE_TIMINGS = 500;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
}

export function executionStageMetrics(): Array<{
  segment: string;
  count: number;
  p50Ms: number;
  p90Ms: number;
  worstMs: number;
}> {
  const groups = new Map<string, number[]>();
  for (const timing of rollingStageTimings) {
    const group = groups.get(timing.segment) ?? [];
    group.push(timing.elapsedMs);
    groups.set(timing.segment, group);
  }
  return [...groups.entries()].map(([segment, values]) => ({
    segment,
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    worstMs: Math.max(...values),
  })).sort((a, b) => b.p90Ms - a.p90Ms);
}

function isTerminalStage(stage: string): boolean {
  return stage === 'REJECTED' || stage === 'EXPIRED' || stage === 'SIMULATION_FAILED'
    || stage === 'CONFIRMED' || stage === 'TRANSACTION_FAILED';
}

/** Captures the last completed hot-path stage for precise expiry diagnostics. */
export function getLatestExecutionStage(identity: string): LatestExecutionStage | undefined {
  const value = latestNonTerminalStage.get(identity);
  return value ? { ...value } : undefined;
}

export function classifyExecutionRejection(reason: string): ExecutionRejectionCategory {
  if (/minimum-output net|final economics|not profitable|profit.*below/i.test(reason)) return 'NOT_PROFITABLE';
  if (/ROI.*below|MIN_PROFIT_BPS/i.test(reason)) return 'BELOW_MIN_ROI';
  if (/confidence/i.test(reason)) return 'LOW_CONFIDENCE';
  if (/stale|expired|quote age|blockhash.*age/i.test(reason)) return 'STALE';
  if (/slippage|SlippageToleranceExceeded/i.test(reason)) return 'SLIPPAGE_MOVED';
  if (/simulation/i.test(reason)) return 'SIMULATION_FAILED';
  if (/insufficient.*balance|SOL reserve|MAX_TRADE/i.test(reason)) return 'INSUFFICIENT_BALANCE';
  if (/no executor|unsupported route|provider combination/i.test(reason)) return 'UNSUPPORTED_ROUTE';
  if (/mint|Token-2022|token policy|classic SPL|freeze authority/i.test(reason)) return 'TOKEN_POLICY';
  if (/packet limit|transaction.*large|1232|encoding capacity|encoding overruns Uint8Array/i.test(reason)) return 'TRANSACTION_TOO_LARGE';
  if (/compute/i.test(reason)) return 'COMPUTE_LIMIT';
  if (/timeout|HTTP 429|rate limit|ECONN|fetch failed/i.test(reason)) return 'RPC_TIMEOUT';
  if (/journal|lock|reconciliation|duplicate/i.test(reason)) return 'JOURNAL_BLOCKED';
  if (/startup|IPC|signer is unavailable/i.test(reason)) return 'STARTUP_FAILURE';
  return 'VALIDATION_FAILED';
}

/** Pin stale-candidate telemetry to the hot-path segment that consumed it. */
export function classifyExecutionExpiry(
  reason: string,
  lastCompletedStage?: string,
  networkTimings: readonly ExecutionNetworkTiming[] = [],
): 'EXPIRED_BEFORE_HANDOFF' | 'EXPIRED_WAITING_FOR_EXECUTOR' | 'EXPIRED_RAPTOR_QUOTE'
  | 'EXPIRED_RAPTOR_INSTRUCTIONS' | 'EXPIRED_BUILD' | 'EXPIRED_RPC'
  | 'EXPIRED_SIMULATION' | 'EXPIRED_FINAL_CHECK' {
  const failedRequest = [...networkTimings].reverse().find((timing) => !timing.ok);
  if (/Raptor execution quote/i.test(failedRequest?.label ?? '')
    || /Raptor execution quote/i.test(reason)) return 'EXPIRED_RAPTOR_QUOTE';
  if (/Raptor instruction build/i.test(failedRequest?.label ?? '')
    || /Raptor instruction build/i.test(reason)) return 'EXPIRED_RAPTOR_INSTRUCTIONS';
  if (/simulateTransaction/i.test(failedRequest?.label ?? '')) return 'EXPIRED_SIMULATION';
  if (failedRequest?.kind === 'rpc') return 'EXPIRED_RPC';
  if (lastCompletedStage === 'FOUND') return 'EXPIRED_BEFORE_HANDOFF';
  if (lastCompletedStage === 'P0_HANDOFF' || lastCompletedStage === 'EXECUTOR_RECEIVED') {
    return 'EXPIRED_WAITING_FOR_EXECUTOR';
  }
  // A quote can become stale *before* the simulation RPC is requested.  The
  // error text often still contains the word "simulation", so completed-stage
  // evidence must win over a broad string match.
  if (lastCompletedStage === 'SIMULATION_END' || lastCompletedStage === 'SIMULATION_PASS'
    || lastCompletedStage === 'FINAL_CHECK') return 'EXPIRED_FINAL_CHECK';
  if (lastCompletedStage === 'BUILD_END' || lastCompletedStage === 'BUILT'
    || lastCompletedStage === 'INSPECTION_PASS') {
    return 'EXPIRED_BUILD';
  }
  if (/timeout|429|ECONN|fetch failed|RPC/i.test(reason)) return 'EXPIRED_RPC';
  if (/simulation/i.test(reason)) return 'EXPIRED_SIMULATION';
  if (/build|inspection|transaction/i.test(reason)) {
    return 'EXPIRED_BUILD';
  }
  return 'EXPIRED_WAITING_FOR_EXECUTOR';
}

export function logExecutionStage(
  identity: string,
  stage: string,
  detectedAt: number,
  details: Record<string, unknown> = {},
): void {
  const now = Date.now();
  const previous = latestNonTerminalStage.get(identity);
  if (previous && previous.stage !== stage) {
    rollingStageTimings.push({
      segment: `${previous.stage}->${stage}`,
      elapsedMs: Math.max(0, now - previous.reachedAt),
      completedAt: now,
    });
    if (rollingStageTimings.length > MAX_STAGE_TIMINGS) {
      rollingStageTimings.splice(0, rollingStageTimings.length - MAX_STAGE_TIMINGS);
    }
  }
  if (!isTerminalStage(stage)) {
    latestNonTerminalStage.set(identity, {
      stage,
      reachedAt: now,
      elapsedFromCandidateMs: Math.max(0, now - detectedAt),
    });
  }
  const prior = (stage === 'REJECTED' || stage === 'EXPIRED')
    ? previous
    : undefined;
  log.info('LIVE_EXECUTION_PIPELINE', {
    identity,
    stage,
    stageAt: now,
    stageAtIso: new Date(now).toISOString(),
    candidateDetectedAt: detectedAt,
    candidateDetectedAtIso: new Date(detectedAt).toISOString(),
    candidateToStageMs: Math.max(0, now - detectedAt),
    elapsedSincePreviousStageMs: previous ? Math.max(0, now - previous.reachedAt) : 0,
    ...(prior ? {
      lastCompletedStage: prior.stage,
      timeSinceLastCompletedStageMs: Math.max(0, now - prior.reachedAt),
    } : {}),
    ...details,
  });
}

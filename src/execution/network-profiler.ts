import { performance } from 'node:perf_hooks';
import { log } from '../logger.js';

export type ExecutionNetworkKind = 'http' | 'rpc';

export interface ExecutionNetworkTiming {
  label: string;
  kind: ExecutionNetworkKind;
  elapsedMs: number;
  startedAt: number;
  completedAt: number;
  ok: boolean;
  error?: string;
}

export interface ExecutionNetworkSummary {
  label: string;
  kind: ExecutionNetworkKind;
  count: number;
  success: number;
  failures: number;
  p50Ms: number;
  p90Ms: number;
  worstMs: number;
}

export interface ExecutionNetworkTraceContext {
  identity: string;
  candidateDetectedAt: number;
}

const rollingTimings: ExecutionNetworkTiming[] = [];
const MAX_ROLLING_TIMINGS = 1_000;

function recordRolling(timing: ExecutionNetworkTiming): void {
  rollingTimings.push(timing);
  if (rollingTimings.length > MAX_ROLLING_TIMINGS) {
    rollingTimings.splice(0, rollingTimings.length - MAX_ROLLING_TIMINGS);
  }
}

function percentile(values: number[], value: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] ?? 0;
}

/** Process-wide rolling network telemetry; contains labels/timing only. */
export function executionNetworkMetrics(): ExecutionNetworkSummary[] {
  const groups = new Map<string, ExecutionNetworkTiming[]>();
  for (const timing of rollingTimings) {
    const key = `${timing.kind}:${timing.label}`;
    const group = groups.get(key) ?? [];
    group.push(timing);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const elapsed = group.map((timing) => timing.elapsedMs);
    return {
      label: group[0]!.label,
      kind: group[0]!.kind,
      count: group.length,
      success: group.filter((timing) => timing.ok).length,
      failures: group.filter((timing) => !timing.ok).length,
      p50Ms: percentile(elapsed, 0.5),
      p90Ms: percentile(elapsed, 0.9),
      worstMs: Math.max(...elapsed),
    };
  }).sort((a, b) => b.p90Ms - a.p90Ms);
}

/** Per-candidate request telemetry. It contains no request bodies, keys, or secrets. */
export class ExecutionNetworkProfiler {
  readonly timings: ExecutionNetworkTiming[] = [];

  constructor(private readonly context?: ExecutionNetworkTraceContext) {}

  trace(event: string, details: Record<string, unknown> = {}): void {
    if (!this.context) return;
    const at = Date.now();
    log.info('LIVE_EXECUTION_PIPELINE', {
      identity: this.context.identity,
      stage: event,
      stageAt: at,
      stageAtIso: new Date(at).toISOString(),
      candidateDetectedAt: this.context.candidateDetectedAt,
      candidateDetectedAtIso: new Date(this.context.candidateDetectedAt).toISOString(),
      candidateToStageMs: Math.max(0, at - this.context.candidateDetectedAt),
      ...details,
    });
  }

  async measure<T>(label: string, kind: ExecutionNetworkKind, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const started = performance.now();
    if (this.context) {
      log.info('LIVE_EXECUTION_NETWORK', {
        identity: this.context.identity,
        event: 'START',
        label,
        kind,
        startedAt,
        startedAtIso: new Date(startedAt).toISOString(),
        candidateAgeMs: Math.max(0, startedAt - this.context.candidateDetectedAt),
      });
    }
    try {
      const value = await operation();
      const timing: ExecutionNetworkTiming = {
        label, kind, startedAt, completedAt: Date.now(),
        elapsedMs: Number((performance.now() - started).toFixed(1)), ok: true,
      };
      this.timings.push(timing);
      recordRolling(timing);
      if (this.context) {
        log.info('LIVE_EXECUTION_NETWORK', {
          identity: this.context.identity,
          event: 'END',
          ...timing,
          startedAtIso: new Date(timing.startedAt).toISOString(),
          completedAtIso: new Date(timing.completedAt).toISOString(),
          candidateAgeMs: Math.max(0, timing.completedAt - this.context.candidateDetectedAt),
        });
      }
      return value;
    } catch (error) {
      const timing: ExecutionNetworkTiming = {
        label, kind, startedAt, completedAt: Date.now(),
        elapsedMs: Number((performance.now() - started).toFixed(1)), ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.timings.push(timing);
      recordRolling(timing);
      if (this.context) {
        log.info('LIVE_EXECUTION_NETWORK', {
          identity: this.context.identity,
          event: 'END',
          ...timing,
          startedAtIso: new Date(timing.startedAt).toISOString(),
          completedAtIso: new Date(timing.completedAt).toISOString(),
          candidateAgeMs: Math.max(0, timing.completedAt - this.context.candidateDetectedAt),
        });
      }
      throw error;
    }
  }
}

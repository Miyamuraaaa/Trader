import { z } from 'zod';
import { RawPrefilterLedger } from './raw-prefilter-ledger.js';
import type { PrefilterTrace } from './prefilter-trace.js';

export const FunnelTelemetry = z.object({ identity: z.string().max(200), stage: z.string().max(80),
  at: z.number().finite(), detectedAt: z.number().finite(), reason: z.string().max(100).optional(), conservativeNetAtomic: z.string().regex(/^-?\d+$/).optional() }).strict();
export type FunnelEvent = z.infer<typeof FunnelTelemetry>;
export interface PositiveSignal {
  prefilterTrace?: PrefilterTrace;
  liveEligibility?: string;
  id: string; detectedAt: number; providers: string; intermediateMint: string; inputAmount: string;
  rawNet: string; rawWorstCase: string; constrainedNet?: string; constrainedWorstCase?: string;
  networkFee?: string; priorityFee?: string; ataRent?: string; pools: string[][];
  prefilterResult?: string; executionId?: string; p0Handoff?: boolean; executorResult?: string;
  routeAlignment?: string; finalConservativeNet?: string; latencyByStage?: Record<string, number>;
}
const stages: Record<string, string> = { EXECUTABLE_CANDIDATE: 'EXECUTOR_CONSTRAINED_POSITIVE',
  RAW_SIGNAL_ENDED: 'MARKET_SIGNAL_ENDED_BEFORE_PREFILTER',
  ROUTE_ALIGNED: 'ROUTE_ALIGNED', SIMULATION_PASS: 'SIMULATION_PASSED',
  FINAL_PROFITABILITY_PASS: 'FINAL_PROFITABILITY_PASSED', APPROVED_BY_USER: 'USER_APPROVED',
  DISCOVERY_ONLY_TOKEN_2022: 'TOKEN_2022_DISCOVERY_ONLY', QUOTE_FAILED: 'QUOTE_FAILED' };

export class ExecutionFunnel {
  readonly raw: RawPrefilterLedger;
  private events: FunnelEvent[] = [];
  private seen = new Map<string, number>();
  private totals: Record<string, number> = {};
  private signals: PositiveSignal[] = [];
  private readonly startedAt: number;
  constructor(private readonly now: () => number = Date.now) { this.startedAt = now(); this.raw = new RawPrefilterLedger(now); }
  record(event: FunnelEvent): void {
    if (event.stage === 'REJECTED' && event.reason) {
      const reason = ({ NOT_PROFITABLE: 'BELOW_FINAL_PROFIT_THRESHOLD', STALE: 'EXPIRED', TOKEN_POLICY: 'TOKEN_POLICY_REJECTED', ROUTE_DIVERGED: 'EXECUTION_ROUTE_CHANGED' } as Record<string, string>)[event.reason] ?? event.reason;
      this.record({ ...event, stage: reason, reason: undefined });
    }
    const stage = stages[event.stage] ?? event.stage;
    const key = `${event.identity}:${stage}`;
    this.prune();
    if (!this.seen.has(key)) {
      this.seen.set(key, event.at); this.events.push({ ...event, stage }); this.totals[stage] = (this.totals[stage] ?? 0) + 1;
    }
    const signal = this.signals.find((s) => s.executionId === event.identity);
    if (signal) {
      if (event.conservativeNetAtomic !== undefined) signal.finalConservativeNet = `${Number(event.conservativeNetAtomic) / 1_000_000}`;
      signal.executorResult = event.reason ?? stage;
      if (stage === 'ROUTE_ALIGNED' || stage === 'EXECUTION_ROUTE_CHANGED') signal.routeAlignment = stage;
      signal.latencyByStage = { ...signal.latencyByStage, [stage]: Math.max(0, event.at - event.detectedAt) };
    }
  }
  signal(value: PositiveSignal): void {
    if (this.signals.some((s) => s.id === value.id)) return;
    this.signals.unshift(value); this.signals = this.signals.slice(0, 10);
  }
  update(id: string, values: Partial<PositiveSignal>): void { const signal = this.signals.find((s) => s.id === id); if (signal) Object.assign(signal, values); }
  private prune(): void {
    const cutoff = this.now() - 900_000;
    this.events = this.events.filter((e) => e.at >= cutoff).slice(-100_000);
    for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
    while (this.seen.size > 100_000) this.seen.delete(this.seen.keys().next().value!);
  }
  snapshot() {
    this.prune();
    const percentile = (values: number[], q: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]! : null;
    const stageTimes = new Map(this.events.map((event) => [`${event.identity}:${event.stage}`, event.at]));
    const segments = { p0ToExecutor: ['P0_HANDOFF', 'EXECUTOR_RECEIVED'], quoteBuild: ['BUILD_START', 'BUILD_END'], simulation: ['SIMULATION_START', 'SIMULATION_END'], candidateToReady: ['', 'READY_TO_EXECUTE'] };
    const timings = Object.fromEntries(Object.entries(segments).map(([label, [start, end]]) => {
      const values = this.events.filter((e) => e.stage === end).flatMap((event) => {
        const from = start ? stageTimes.get(`${event.identity}:${start}`) : event.detectedAt;
        return from === undefined ? [] : [Math.max(0, event.at - from)];
      });
      return [label, { count: values.length, p50Ms: percentile(values, .5), p90Ms: percentile(values, .9) }];
    }));
    const counts = (ms: number) => {
      const all = this.events.filter((e) => e.at >= this.now() - ms).reduce<Record<string, number>>((all, e) => { all[e.stage] = (all[e.stage] ?? 0) + 1; return all; }, {});
      const cohort = this.raw.snapshot(ms);
      if (cohort.session.RAW_POSITIVE) {
        all.MARKET_SIGNAL_ENDED_BEFORE_PREFILTER = 0;
        for (const key of ['ABOVE_LIVE_CAP','UNSUPPORTED_PROVIDER_PAIR','TOKEN_2022_DISCOVERY_ONLY','TOKEN_POLICY_REJECTED','ROUTE_POLICY_REJECTED','ECONOMICS_DIVERGED','QUOTE_FAILED','RAW_SIGNAL_ENDED','RAW_STALE_BEFORE_PREFILTER','PREFILTER_STALE','PREFILTER_RATE_LIMITED','COALESCED','OBSERVATION_ONLY','PENDING','RAW_NOT_POSITIVE','EXECUTOR_CONSTRAINED_POSITIVE']) all[key] = 0;
        for (const [key, value] of Object.entries(cohort.buckets)) all[stages[key] ?? key] = value;
        all.RAW_POSITIVE = cohort.rawPositive; all.PREFILTER_STARTED = cohort.started; all.PREFILTER_COMPLETED = cohort.completed;
      }
      return all;
    };
    const last15m = counts(900_000);
    const rawPrefilter = { last60s: this.raw.snapshot(60_000), last5m: this.raw.snapshot(300_000), last15m: this.raw.snapshot(900_000) };
    const explanation = !(last15m.RAW_POSITIVE ?? 0)
      ? 'No raw positive spreads survived conservative market costs in the last 15m.'
      : `Last 15m: ${last15m.RAW_POSITIVE ?? 0} raw positives -> ${last15m.EXECUTOR_CONSTRAINED_POSITIVE ?? 0} executable -> ${last15m.READY_TO_EXECUTE ?? 0} READY; ${rawPrefilter.last15m.rawPositive ? Object.entries(rawPrefilter.last15m.buckets).map(([key, count]) => `${key}: ${count}`).join(', ') : `economics diverged ${last15m.ECONOMICS_DIVERGED ?? 0}, Token-2022 ${last15m.TOKEN_2022_DISCOVERY_ONLY ?? 0}, route policy ${last15m.ROUTE_POLICY_REJECTED ?? 0}, above cap ${last15m.ABOVE_LIVE_CAP ?? 0}`}.`;
    const session = { ...this.totals };
    if (rawPrefilter.last15m.session.RAW_POSITIVE) {
      for (const [key, value] of Object.entries(rawPrefilter.last15m.session)) session[stages[key] ?? key] = value;
    }
    return { startedAt: this.startedAt, session, last60s: counts(60_000), last5m: counts(300_000), last15m,
      explanation, timings, rawPrefilter, lastPositiveSignals: structuredClone(this.signals), windowEventCapacity: 100_000 };
  }
}
export const executionFunnel = new ExecutionFunnel();

/** Explicit scalar-only IPC payload: never forwards error URLs, signer data or transaction bytes. */
export function emitFunnelExecutionStage(identity: string, stage: string, detectedAt: number, reason?: string, conservativeNetAtomic?: string): void {
  const event: FunnelEvent = { identity, stage, detectedAt, at: Date.now(), reason, conservativeNetAtomic };
  if (process.send && process.connected) {
    queueMicrotask(() => { if (process.connected) process.send?.({ type: 'EXECUTION_FUNNEL_EVENT', event }, () => undefined); });
  } else executionFunnel.record(event);
}

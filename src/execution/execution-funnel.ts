import { z } from 'zod';
import { RawPrefilterLedger } from './raw-prefilter-ledger.js';
import type { PrefilterTrace } from './prefilter-trace.js';
import { telemetryRun, LEGACY_COHORT_WARNING, type SourceLane } from './source-lane.js';
import type { EconomicBreakdownV1 } from '../economics/economic-breakdown.js';
import { EconomicTelemetry, economicComparison } from '../economics/economic-telemetry.js';
import { opportunityQuality } from '../economics/opportunity-quality.js';

export const FunnelTelemetry = z.object({ identity: z.string().max(200), stage: z.string().max(80),
  economicBreakdown: EconomicTelemetry.optional(),
  monotonicAt: z.number().finite().optional(),
  at: z.number().finite(), detectedAt: z.number().finite(), reason: z.string().max(100).optional(), conservativeNetAtomic: z.string().regex(/^-?\d+$/).optional() }).strict();
export type FunnelEvent = z.infer<typeof FunnelTelemetry>;
export interface PositiveSignal {
  sourceLane?: SourceLane;
  economicBreakdown?: EconomicBreakdownV1;
  executorComparison?: ReturnType<typeof economicComparison>;
  previousSignalId?: string;
  prefilterReason?: string;
  prefilterTrace?: PrefilterTrace;
  liveEligibility?: string;
  id: string; detectedAt: number; providers: string; intermediateMint: string; inputAmount: string;
  rawNet?: string; rawWorstCase?: string; constrainedNet?: string; constrainedWorstCase?: string;
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
  readonly executable: RawPrefilterLedger;
  private events: FunnelEvent[] = [];
  private seen = new Map<string, number>();
  private totals: Record<string, number> = {};
  private signals: PositiveSignal[] = [];
  private readonly startedAt: number;
  constructor(private readonly now: () => number = Date.now) { this.startedAt = now(); this.raw = new RawPrefilterLedger(now); this.executable = new RawPrefilterLedger(now); }
  startExecutableObservation(id: string, trace: PrefilterTrace): void {
    this.executable.register(id, trace);
    this.record({ identity: id, stage: 'EXEC_SURFACE_OBSERVATION_STARTED', at: this.now(), detectedAt: trace.rawPositiveDetectedAt });
  }
  finishExecutableObservation(id: string, result: string, trace?: PrefilterTrace): void {
    this.executable.finish(id, result, trace);
    this.record({ identity: id, stage: 'EXEC_SURFACE_OBSERVATION_COMPLETED', at: this.now(), detectedAt: trace?.rawPositiveDetectedAt ?? this.now() });
    if (result === 'EXECUTABLE_CANDIDATE') this.record({ identity: id, stage: 'EXECUTABLE_CANDIDATE', at: this.now(), detectedAt: trace?.rawPositiveDetectedAt ?? this.now() });
  }
  record(event: FunnelEvent): void {
    if (event.stage === 'RAW_POSITIVE') this.record({ ...event, stage: 'BROAD_ROUND_TRIP_POSITIVE' });
    event = { ...event, monotonicAt: event.monotonicAt ?? Number(process.hrtime.bigint() / 1000000n) };
    if (event.stage === 'REJECTED' && event.reason) {
      const reason = ({ NOT_PROFITABLE: 'BELOW_FINAL_PROFIT_THRESHOLD', STALE: 'EXPIRED', TOKEN_POLICY: 'TOKEN_POLICY_REJECTED', ROUTE_DIVERGED: 'EXECUTION_ROUTE_CHANGED' } as Record<string, string>)[event.reason] ?? event.reason;
      this.record({ ...event, stage: reason, reason: undefined });
    }
    const stage = stages[event.stage] ?? event.stage;
    const key = `${event.identity}:${stage}`;
    this.prune();
    if (!this.seen.has(key)) {
      if (event.economicBreakdown) opportunityQuality.executor(event.identity, event.economicBreakdown);
      opportunityQuality.stage(event.identity, stage);
      this.seen.set(key, event.at); this.events.push({ ...event, stage }); this.totals[stage] = (this.totals[stage] ?? 0) + 1;
    }
    const signal = this.signals.find((s) => s.executionId === event.identity);
    if (signal) {
      if (event.economicBreakdown && signal.economicBreakdown) signal.executorComparison = economicComparison(signal.economicBreakdown, event.economicBreakdown);
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
    const adjacent = new Map<string, number[]>(); const previous = new Map<string, FunnelEvent>();
    for (const event of this.events) {
      const prior = previous.get(event.identity);
      if (prior?.monotonicAt !== undefined && event.monotonicAt !== undefined) {
        const key = `${prior.stage}->${event.stage}`; const values = adjacent.get(key) ?? [];
        values.push(Math.max(0, event.monotonicAt - prior.monotonicAt)); adjacent.set(key, values);
      }
      previous.set(event.identity, event);
    }
    const adjacentStageLatency = Object.fromEntries([...adjacent].map(([key, values]) => [key, { count: values.length, p50: percentile(values, .5), p90: percentile(values, .9), p99: percentile(values, .99) }]));
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
      const executablePositive = all.EXECUTOR_CONSTRAINED_POSITIVE;
      const cohort = this.raw.snapshot(ms);
      if (cohort.session.RAW_POSITIVE) {
        all.MARKET_SIGNAL_ENDED_BEFORE_PREFILTER = 0;
        for (const key of ['ABOVE_LIVE_CAP','UNSUPPORTED_PROVIDER_PAIR','TOKEN_2022_DISCOVERY_ONLY','TOKEN_POLICY_REJECTED','ROUTE_POLICY_REJECTED','ECONOMICS_DIVERGED','QUOTE_FAILED','RAW_SIGNAL_ENDED','RAW_STALE_BEFORE_PREFILTER','PREFILTER_STALE','PREFILTER_RATE_LIMITED','COALESCED','OBSERVATION_ONLY','PENDING','RAW_NOT_POSITIVE','EXECUTOR_CONSTRAINED_POSITIVE']) all[key] = 0;
        for (const [key, value] of Object.entries(cohort.buckets)) all[stages[key] ?? key] = value;
        all.RAW_POSITIVE = cohort.rawPositive; all.PREFILTER_STARTED = cohort.started; all.PREFILTER_COMPLETED = cohort.completed;
      }
      if (executablePositive !== undefined) all.EXECUTOR_CONSTRAINED_POSITIVE = executablePositive;
      if (all.EXECUTOR_CONSTRAINED_POSITIVE !== undefined) all.EXEC_SURFACE_POSITIVE = all.EXECUTOR_CONSTRAINED_POSITIVE;
      return all;
    };
    const last15m = counts(900_000);
    const rawPrefilter = { last60s: this.raw.snapshot(60_000), last5m: this.raw.snapshot(300_000), last15m: this.raw.snapshot(900_000) };
    const explanation = `Last 15m: ${last15m.BROAD_ROUND_TRIP_POSITIVE ?? 0} completed broad positives; ${last15m.EXEC_SURFACE_OBSERVATION_STARTED ?? 0} executable-surface attempts; ${last15m.EXEC_SURFACE_POSITIVE ?? 0} constrained positives; ${last15m.READY_TO_EXECUTE ?? 0} READY. Attempts are not positive signals.`;
    const session = { ...this.totals };
    if (rawPrefilter.last15m.session.RAW_POSITIVE) {
      for (const [key, value] of Object.entries(rawPrefilter.last15m.session)) session[stages[key] ?? key] = value;
    }
    const executableObservations = this.executable.snapshot();
    const { rawPositive: observationCount, session: observationSession, ...observationDetail } = executableObservations;
    const { RAW_POSITIVE: startedObservations, ...terminalSession } = observationSession;
    session.EXECUTOR_CONSTRAINED_POSITIVE = this.totals.EXECUTOR_CONSTRAINED_POSITIVE ?? 0;
    session.EXEC_SURFACE_POSITIVE = session.EXECUTOR_CONSTRAINED_POSITIVE;
    return { ...telemetryRun, legacyWarning: LEGACY_COHORT_WARNING, startedAt: this.startedAt, session, last60s: counts(60_000), last5m: counts(300_000), last15m,
      quality: opportunityQuality.snapshot(), executableObservations: { ...observationDetail, observations: observationCount, session: { ...terminalSession, EXEC_SURFACE_OBSERVATION_STARTED: startedObservations } },
      explanation, timings, adjacentStageLatency, rawPrefilter, lastPositiveSignals: structuredClone(this.signals), windowEventCapacity: 100_000 };
  }
}
export const executionFunnel = new ExecutionFunnel();

/** Explicit scalar-only IPC payload: never forwards error URLs, signer data or transaction bytes. */
export function emitFunnelExecutionStage(identity: string, stage: string, detectedAt: number, reason?: string, conservativeNetAtomic?: string): void {
  const event: FunnelEvent = { identity, stage, detectedAt, at: Date.now(), monotonicAt: Number(process.hrtime.bigint() / 1000000n), reason, conservativeNetAtomic };
  if (process.send && process.connected) {
    queueMicrotask(() => { if (process.connected) process.send?.({ type: 'EXECUTION_FUNNEL_EVENT', event }, () => undefined); });
  } else executionFunnel.record(event);
}

/** Post-computation observation only; malformed diagnostics never change approval. */
export function emitExecutorEconomicBreakdown(identity: string, detectedAt: number, breakdown: EconomicBreakdownV1): void {
  const parsed = EconomicTelemetry.safeParse(breakdown);
  if (!parsed.success) return;
  const event: FunnelEvent = { identity, stage: 'EXECUTOR_ECONOMICS_COMPUTED', at: Date.now(), detectedAt, economicBreakdown: parsed.data };
  if (process.send && process.connected) queueMicrotask(() => { if (process.connected) process.send?.({ type: 'EXECUTION_FUNNEL_EVENT', event }, () => undefined); });
  else executionFunnel.record(event);
}

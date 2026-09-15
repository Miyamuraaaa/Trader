import type { PrefilterTrace } from './prefilter-trace.js';
import { ECONOMIC_OUTCOMES } from '../economics/economic-breakdown.js';

/** Raw-stage windows are detection cohorts, not unrelated completion-time event buckets. */
export class RawPrefilterLedger {
  private duplicateTerminals = 0;
  private missingTerminals = 0;
  private violations: Array<{ id: string; lastStage: string }> = [];
  private records = new Map<string, { trace: PrefilterTrace; result: string; sourceResult?: string }>();
  private session: Record<string, number> = { RAW_POSITIVE: 0, PENDING: 0 };
  constructor(private readonly now: () => number = Date.now) {}
  has(id: string): boolean { return this.records.has(id); }
  pendingObservations(){return [...this.records].filter(([,r])=>r.result==='PENDING').map(([id,r])=>({id,sourceLane:null,stage:r.trace.constrainedLeg2StartedAt!==undefined?'CONSTRAINED_LEG2':r.trace.constrainedLeg1StartedAt!==undefined?'CONSTRAINED_LEG1':'PREFILTER_PENDING'}));}
  register(id: string, trace: PrefilterTrace): void {
    if (this.records.has(id)) return;
    this.records.set(id, { trace, result: 'PENDING' }); this.session.RAW_POSITIVE!++; this.session.PENDING!++;
    this.prune();
  }
  finish(id: string, result: string, trace?: PrefilterTrace): void {
    const record = this.records.get(id); if (!record) { this.missingTerminals++; return; }
    if (record.result !== 'PENDING') { this.duplicateTerminals++; return; }
    if (trace) record.trace = trace;
    record.sourceResult = result;
    record.result = ({ EXECUTABLE_CANDIDATE: 'EXECUTOR_CONSTRAINED_POSITIVE', DISCOVERY_ONLY_TOKEN_2022: 'TOKEN_2022_DISCOVERY_ONLY',
      RAW_SIGNAL_ENDED: 'PREFILTER_QUEUE_DEADLINE_EXCEEDED', RAW_STALE_BEFORE_PREFILTER: 'PREFILTER_STALE',
      COALESCED: 'QUOTE_FAILED', OBSERVATION_ONLY: 'QUOTE_FAILED', TELEMETRY_CAPACITY: 'QUOTE_FAILED', RAW_NOT_POSITIVE: 'ECONOMICS_DIVERGED' } as Record<string, string>)[result] ?? result;
    if (![...ECONOMIC_OUTCOMES,'ABOVE_LIVE_CAP','UNSUPPORTED_PROVIDER_PAIR','TOKEN_2022_DISCOVERY_ONLY','TOKEN_POLICY_REJECTED','ROUTE_POLICY_REJECTED','ECONOMICS_DIVERGED','PREFILTER_QUEUE_DEADLINE_EXCEEDED','PREFILTER_RATE_LIMITED','QUOTE_FAILED','PREFILTER_STALE','EXECUTOR_CONSTRAINED_POSITIVE'].includes(record.result)) {
      this.missingTerminals++;
      this.violations.push({ id, lastStage: 'UNKNOWN_TERMINAL_OUTCOME' }); this.violations = this.violations.slice(-100);
      record.result = 'QUOTE_FAILED';
    }
    this.session.PENDING!--; this.session[record.result] = (this.session[record.result] ?? 0) + 1;
  }
  private prune(): void {
    for (const [id, record] of this.records) if (record.result === 'PENDING' && this.now() - record.trace.rawPositiveDetectedAt > 15000) this.missing(id);
    for (const [id, record] of this.records) if (record.result !== 'PENDING' && record.trace.rawPositiveDetectedAt < this.now() - 900_000) this.records.delete(id);
    // Retain bounded pending work; overflow is explicit, never unexplained disappearance.
    while (this.records.size > 100_000) {
      const id = this.records.keys().next().value!; this.finish(id, 'TELEMETRY_CAPACITY'); this.records.delete(id);
    }
  }
  private missing(id: string): void {
    const trace = this.records.get(id)!.trace;
    this.missingTerminals++;
    this.violations.push({ id, lastStage: trace.constrainedLeg2StartedAt !== undefined ? 'CONSTRAINED_LEG2' : trace.constrainedLeg1StartedAt !== undefined ? 'CONSTRAINED_LEG1' : trace.executablePrefilterStartedAt !== undefined ? 'PREFILTER_STARTED' : 'RAW_POSITIVE' });
    this.violations = this.violations.slice(-100);
    this.finish(id, 'QUOTE_FAILED');
    this.records.get(id)!.sourceResult = 'MISSING_OUTCOME_INVARIANT_VIOLATION';
  }
  shutdown(): void { for (const [id, record] of this.records) if (record.result === 'PENDING') this.missing(id); }
  snapshot(ms = 900_000) {
    this.prune();
    const records = [...this.records.values()].filter((r) => r.trace.rawPositiveDetectedAt >= this.now() - ms);
    const buckets: Record<string, number> = {};
    const sourceResults: Record<string, number> = {};
    for (const record of records) buckets[record.result] = (buckets[record.result] ?? 0) + 1;
    for (const record of records) { const source = record.sourceResult ?? 'PENDING'; sourceResults[source] = (sourceResults[source] ?? 0) + 1; }
    const metric = (key: keyof PrefilterTrace) => {
      const values = records.flatMap((r) => r.trace[key] === undefined ? [] : [r.trace[key]!]).sort((a, b) => a - b);
      return { count: values.length, p50: values[Math.ceil(values.length * .5) - 1] ?? null, p90: values[Math.ceil(values.length * .9) - 1] ?? null, p99: values[Math.ceil(values.length * .99) - 1] ?? null };
    };
    return { rawPositive: records.length, buckets, sourceResults, accounted: Object.values(buckets).reduce((a, b) => a + b, 0),
      terminalCount: records.filter((r) => r.result !== 'PENDING').length, unreconciled: records.filter((r) => r.result === 'PENDING').length,
      duplicateTerminalCount: this.duplicateTerminals, missingTerminalCount: this.missingTerminals, violations: [...this.violations],
      started: records.filter((r) => r.trace.executablePrefilterStartedAt !== undefined).length,
      completed: records.filter((r) => r.trace.prefilterFinishedAt !== undefined && r.trace.executablePrefilterStartedAt !== undefined).length,
      totalMs: metric('totalPrefilterMs'), queueMs: metric('prefilterQueueMs'), leg1Ms: metric('constrainedLeg1Ms'), leg2Ms: metric('constrainedLeg2Ms'),
      session: { ...this.session } };
  }
}

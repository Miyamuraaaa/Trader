import type { PrefilterTrace } from './prefilter-trace.js';

/** Raw-stage windows are detection cohorts, not unrelated completion-time event buckets. */
export class RawPrefilterLedger {
  private records = new Map<string, { trace: PrefilterTrace; result: string }>();
  private session: Record<string, number> = { RAW_POSITIVE: 0, PENDING: 0 };
  constructor(private readonly now: () => number = Date.now) {}
  register(id: string, trace: PrefilterTrace): void {
    if (this.records.has(id)) return;
    this.records.set(id, { trace, result: 'PENDING' }); this.session.RAW_POSITIVE!++; this.session.PENDING!++;
    this.prune();
  }
  finish(id: string, result: string, trace?: PrefilterTrace): void {
    const record = this.records.get(id); if (!record || record.result !== 'PENDING') return;
    if (trace) record.trace = trace;
    record.result = ({ EXECUTABLE_CANDIDATE: 'EXECUTOR_CONSTRAINED_POSITIVE', DISCOVERY_ONLY_TOKEN_2022: 'TOKEN_2022_DISCOVERY_ONLY',
      RAW_SIGNAL_ENDED: 'MARKET_SIGNAL_ENDED_BEFORE_PREFILTER' } as Record<string, string>)[result] ?? result;
    this.session.PENDING!--; this.session[record.result] = (this.session[record.result] ?? 0) + 1;
  }
  private prune(): void {
    for (const [id, record] of this.records) if (record.result !== 'PENDING' && record.trace.rawPositiveDetectedAt < this.now() - 900_000) this.records.delete(id);
    // Retain bounded pending work; overflow is explicit, never unexplained disappearance.
    while (this.records.size > 100_000) {
      const id = this.records.keys().next().value!; this.finish(id, 'TELEMETRY_CAPACITY'); this.records.delete(id);
    }
  }
  snapshot(ms = 900_000) {
    this.prune();
    const records = [...this.records.values()].filter((r) => r.trace.rawPositiveDetectedAt >= this.now() - ms);
    const buckets: Record<string, number> = {};
    for (const record of records) buckets[record.result] = (buckets[record.result] ?? 0) + 1;
    const metric = (key: keyof PrefilterTrace) => {
      const values = records.flatMap((r) => r.trace[key] === undefined ? [] : [r.trace[key]!]).sort((a, b) => a - b);
      return { count: values.length, p50: values[Math.ceil(values.length * .5) - 1] ?? null, p90: values[Math.ceil(values.length * .9) - 1] ?? null };
    };
    return { rawPositive: records.length, buckets, accounted: Object.values(buckets).reduce((a, b) => a + b, 0),
      started: records.filter((r) => r.trace.executablePrefilterStartedAt !== undefined).length,
      completed: records.filter((r) => r.trace.prefilterFinishedAt !== undefined && r.trace.executablePrefilterStartedAt !== undefined).length,
      totalMs: metric('totalPrefilterMs'), queueMs: metric('prefilterQueueMs'), leg1Ms: metric('constrainedLeg1Ms'), leg2Ms: metric('constrainedLeg2Ms'),
      session: { ...this.session } };
  }
}

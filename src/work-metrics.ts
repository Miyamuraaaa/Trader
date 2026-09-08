/** Bounded rolling-60s operational metrics; never stores request URLs or payloads. */
export class RollingWorkMetrics {
  private queueSamples: Array<{ at: number; size: number }> = [];
  observeQueue(size: number): void { this.queueSamples.push({ at: Date.now(), size }); this.prune(); }
  private samples: Array<{ at: number; queueMs: number; latencyMs?: number; ok?: boolean; limited?: boolean }> = [];
  start(queuedAt: number): (ok: boolean, limited?: boolean) => void {
    const sample = { at: Date.now(), queueMs: Math.max(0, Date.now() - queuedAt) } as typeof this.samples[number];
    this.samples.push(sample); this.prune();
    return (ok, limited = false) => { sample.latencyMs = Math.max(0, Date.now() - sample.at); sample.ok = ok; sample.limited = limited; };
  }
  private prune(): void { this.samples = this.samples.filter((s) => s.at >= Date.now() - 60_000).slice(-10_000); this.queueSamples = this.queueSamples.filter((s) => s.at >= Date.now() - 60_000).slice(-10_000); }
  snapshot() {
    this.prune();
    const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
    const queue = this.samples.map((s) => s.queueMs); const latency = this.samples.flatMap((s) => s.latencyMs === undefined ? [] : [s.latencyMs]);
    return { queueHighWater60s: this.queueSamples.reduce((max, s) => Math.max(max, s.size), 0), requests60s: this.samples.length, successes60s: this.samples.filter((s) => s.ok === true).length,
      failures60s: this.samples.filter((s) => s.ok === false).length, rateLimits60s: this.samples.filter((s) => s.limited).length,
      queueWaitP50: percentile(queue, .5), queueWaitP90: percentile(queue, .9),
      queueWaitP99: percentile(queue, .99), requestLatencyP99: percentile(latency, .99),
      requestLatencyP50: percentile(latency, .5), requestLatencyP90: percentile(latency, .9) };
  }
}

import { performance } from 'node:perf_hooks';
/** Only lossy scanner history; NEVER journal, risk, raw-terminal outcomes or submission state. */
export class ScannerHistoryBuffer {
  private queue: Array<{ at: number; write: () => void }> = [];
  private scheduled = false;
  private dropped = 0; private failed = 0; private completed = 0;
  private delays: number[] = []; private durations: number[] = [];
  constructor(private readonly capacity = 256, private readonly defer: (work: () => void) => void = (work) => { setImmediate(work); }, private readonly now = () => performance.now()) {}
  enqueue(write: () => void): boolean {
    if (this.queue.length >= this.capacity) { this.dropped++; return false; }
    this.queue.push({ at: this.now(), write });
    if (!this.scheduled) { this.scheduled = true; this.defer(() => this.drain()); }
    return true;
  }
  private drain(): void {
    // One small write per event-loop turn; provider timers/IO get a service opportunity between writes.
    const job = this.queue.shift();
    if (job) {
      const at = this.now(); this.delays.push(at - job.at);
      try { job.write(); this.completed++; } catch { this.failed++; }
      this.durations.push(this.now() - at); this.delays = this.delays.slice(-256); this.durations = this.durations.slice(-256);
    }
    if (this.queue.length) this.defer(() => this.drain()); else this.scheduled = false;
  }
  snapshot() {
    const metrics = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { count: sorted.length, p50: sorted[Math.ceil(sorted.length*.5)-1] ?? null, p90: sorted[Math.ceil(sorted.length*.9)-1] ?? null, p99: sorted[Math.ceil(sorted.length*.99)-1] ?? null, max: sorted.at(-1) ?? null }; };
    return { queued: this.queue.length, capacity: this.capacity, dropped: this.dropped, failed: this.failed, completed: this.completed, persistDelayMs: metrics(this.delays), writeMs: metrics(this.durations) };
  }
}
export const scannerHistoryBuffer = new ScannerHistoryBuffer();

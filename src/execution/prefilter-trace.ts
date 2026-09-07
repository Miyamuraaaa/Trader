export interface PrefilterTrace {
  rawPositiveDetectedAt: number;
  rawQuoteEvidenceAt: number;
  rawQuoteAgeAtDetectionMs: number;
  executablePrefilterQueuedAt: number;
  executablePrefilterStartedAt?: number;
  rawAgeAtPrefilterStartMs?: number;
  tokenPolicyStartedAt?: number;
  tokenPolicyFinishedAt?: number;
  tokenPolicyMs?: number;
  constrainedLeg1StartedAt?: number;
  constrainedLeg1FinishedAt?: number;
  constrainedLeg1Ms?: number;
  constrainedLeg2StartedAt?: number;
  constrainedLeg2FinishedAt?: number;
  constrainedLeg2Ms?: number;
  prefilterFinishedAt?: number;
  totalPrefilterMs?: number;
  prefilterQueueMs?: number;
}

/** Bounded admission, one active + one newest pending trigger per route; no waiter list. */
export class PrefilterCoalescer<T> {
  private entries = new Map<string, { evidenceAt: number; latest?: Job<T> }>();
  constructor(private readonly cap = 32, private readonly minimumEvidenceAdvanceMs = 50) {}
  schedule(key: string, evidenceAt: number, run: () => Promise<T>, skipped: (reason: 'COALESCED' | 'PREFILTER_RATE_LIMITED') => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job = { evidenceAt, run, skipped, resolve, reject };
      const entry = this.entries.get(key);
      if (entry) {
        if (evidenceAt < (entry.latest?.evidenceAt ?? entry.evidenceAt) + this.minimumEvidenceAdvanceMs) { resolve(skipped('COALESCED')); return; }
        if (entry.latest) entry.latest.resolve(entry.latest.skipped('COALESCED'));
        entry.latest = job; return;
      }
      if (this.entries.size >= this.cap) { resolve(skipped('PREFILTER_RATE_LIMITED')); return; }
      this.entries.set(key, { evidenceAt });
      this.start(key, job);
    });
  }
  private start(key: string, job: Job<T>): void {
    // Invoke immediately, rather than placing P0-trigger work behind a timer/mailbox.
    let work: Promise<T>;
    try { work = job.run(); } catch (error) { work = Promise.reject(error); }
    void work.then(job.resolve, job.reject).finally(() => {
      const next = this.entries.get(key)?.latest;
      if (next) { this.entries.set(key, { evidenceAt: next.evidenceAt }); this.start(key, next); }
      else this.entries.delete(key);
    });
  }
  get activeRoutes(): number { return this.entries.size; }
}
interface Job<T> { evidenceAt: number; run: () => Promise<T>; skipped: (reason: 'COALESCED' | 'PREFILTER_RATE_LIMITED') => T; resolve: (value: T) => void; reject: (reason: unknown) => void; }

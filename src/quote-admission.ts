import { performance } from 'node:perf_hooks';
import { CONFIG } from './config.js';
import type { Quote, QuoteParams } from './aggregators/types.js';

export interface QuoteDeadline {
  signal?: AbortSignal;
  createdMono: number; deadlineMono: number; budgetMs: number; traceId?: string;
  requestClass: 'EXECUTION_PREFILTER' | 'HIGH_PRIORITY_DISCOVERY' | 'LOW_PRIORITY_DISCOVERY';
}
export class QuoteAdmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'QuoteAdmissionError'; }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
/** Include every option, including future provider options, except non-semantic scheduling metadata. */
export function semanticQuoteKey(provider: string, params: QuoteParams): string {
  const { priority, scheduling, ...options } = params;
  return JSON.stringify(canonical({ provider, constrained: priority === 'EXEC_PREFILTER_HIGH', options }));
}
export function quoteDeadline(params: QuoteParams, provider: string, now = performance.now()): QuoteDeadline {
  if (params.scheduling && !Number.isFinite(params.scheduling.deadlineMono)) throw new QuoteAdmissionError('INVALID_QUOTE_DEADLINE');
  const constrained = params.priority === 'EXEC_PREFILTER_HIGH';
  const budgetMs = constrained ? provider === 'raptor' ? CONFIG.raptorExecutionQuoteAgeMs : CONFIG.maxExecutionQuoteAgeMs : CONFIG.maxQuoteAgeMs;
  return { createdMono: now, budgetMs, deadlineMono: Math.min(now + budgetMs, params.scheduling?.deadlineMono ?? Infinity),
    traceId: params.scheduling?.traceId, requestClass: constrained ? 'EXECUTION_PREFILTER' : params.priority === 'HIGH' || params.priority === 'DISCOVERY_HIGH' ? 'HIGH_PRIORITY_DISCOVERY' : 'LOW_PRIORITY_DISCOVERY' };
}
type Shared = { deadline: QuoteDeadline; promise: Promise<Quote>; waiters: number; dispatched: boolean; cancel: AbortController; pairKey: string; semantics: QuoteParams };

/** Admission/coalescing wraps, but never replaces or bypasses, a provider's existing pacing queue. */
export class QuoteAdmission {
  private entries = new Map<string, Shared>();
  private samples: Array<{ at: number; ms: number }> = [];
  private ewma: number | undefined;
  private lastDispatchMono = -Infinity;
  private counters: Record<string, number> = {};
  private reservations = new Map<symbol, { deadlineMono: number; readyMono: number; serviceMs: number }>();
  /** Protect only a future legal slot, never grant quota or authorize a transaction. */
  reserveWorkflow(deadlineMono: number, readyMono: number, serviceMs: number): () => void {
    this.pruneReservations();
    if (![deadlineMono, readyMono, serviceMs].every(Number.isFinite) || serviceMs < 0 || deadlineMono <= this.now()
      || readyMono + serviceMs > deadlineMono) throw new QuoteAdmissionError('PREFILTER_QUEUE_DEADLINE_EXCEEDED');
    if (this.reservations.size >= 16) throw new QuoteAdmissionError('PREFILTER_QUEUE_OVERFLOW');
    const id = Symbol(); this.reservations.set(id, { deadlineMono, readyMono, serviceMs });
    this.count('workflow_reservations');
    return () => { this.reservations.delete(id); };
  }
  private pruneReservations() {
    for (const [id, reservation] of this.reservations) if (reservation.deadlineMono <= this.now()) this.reservations.delete(id);
  }
  discoveryReservationDelayMs(): number {
    this.pruneReservations();
    const interval = typeof this.intervalMs === 'function' ? this.intervalMs() : this.intervalMs;
    const now = this.now();
    for (const reservation of this.reservations.values()) {
      // Borrowing this slot is safe only if another legal send can still finish the reserved leg.
      if (now + interval + reservation.serviceMs > reservation.deadlineMono) {
        this.count('observation_slot_borrow_prevented');
        return Math.max(1, Math.min(25, reservation.deadlineMono - now));
      }
    }
    return 0;
  }
  private cooldownCause: { requestClass: string; durationMs: number; traceId?: string; amountAtomic?: string; endpoint: string } | null = null;
  recordRateLimit(priority: QuoteParams['priority'], durationMs: number, traceId?: string, amountAtomic?: string, endpoint = 'quote') {
    const requestClass = priority === 'EXEC_PREFILTER_HIGH' ? 'P0' : priority === 'HIGH' || priority === 'DISCOVERY_HIGH' ? 'P1' : 'P2';
    this.count(`rateLimits_${requestClass}`);
    this.counters[`requestedCooldownMs_${requestClass}`] = (this.counters[`requestedCooldownMs_${requestClass}`] ?? 0) + durationMs;
    this.cooldownCause = { requestClass, durationMs, traceId, amountAtomic, endpoint };
  }
  constructor(readonly provider: string, private readonly intervalMs: number | (() => number),
    private readonly now: () => number = () => performance.now(), private readonly wall: () => number = Date.now,
    private readonly governorState?: () => { nextLegalSendMono: number; cooldownUntilMono: number }) {}
  forecast(budgetMs: number, earliestMono = this.now()) {
    const interval = typeof this.intervalMs === 'function' ? this.intervalMs() : this.intervalMs;
    const state = this.governorState?.();
    const serviceMs = this.estimate(budgetMs);
    const active = [...this.entries.values()].filter((e) => e.dispatched).length;
    const ready = Math.max(earliestMono, state?.nextLegalSendMono ?? this.lastDispatchMono + interval,
      state?.cooldownUntilMono ?? 0, active ? this.lastDispatchMono + serviceMs : 0);
    return { provider: this.provider, earliestMono, nextLegalSendMono: state?.nextLegalSendMono ?? this.lastDispatchMono + interval,
      cooldownUntilMono: state?.cooldownUntilMono ?? 0, serviceMs, samples: this.samples.length, active,
      predictedStartMono: ready, predictedCompletionMono: ready + serviceMs, cooldownCause: this.cooldownCause };
  }
  private count(key: string) { this.counters[key] = (this.counters[key] ?? 0) + 1; }
  estimate(budget: number): number {
    this.samples = this.samples.filter((s) => this.now() - s.at < 60_000).slice(-256);
    const sorted = this.samples.map((s) => s.ms).sort((a, b) => a - b);
    return Math.max(this.ewma ?? budget / 2, sorted[Math.ceil(sorted.length * .9) - 1] ?? 0);
  }
  private reject(deadline: QuoteDeadline, suffix = 'DEADLINE_EXCEEDED'): never {
    const code = deadline.requestClass === 'EXECUTION_PREFILTER' ? `PREFILTER_QUEUE_${suffix}` : `DISCOVERY_QUEUE_${suffix}`;
    this.count(code); throw new QuoteAdmissionError(code);
  }
  check(deadline: QuoteDeadline, queueMs = 0): void {
    if (this.now() + queueMs + this.estimate(deadline.budgetMs) > deadline.deadlineMono) this.reject(deadline);
  }
  async dispatch(deadline: QuoteDeadline, work: () => Promise<Quote>): Promise<Quote> {
    const entry = [...this.entries.values()].find((e) => e.deadline === deadline);
    if (!entry || entry.waiters === 0) this.reject(deadline, 'CANCELLED');
    this.check(deadline); entry.dispatched = true; this.lastDispatchMono = this.now();
    this.count(`dispatched_${deadline.requestClass}`);
    const at = this.now();
    let success = false;
    try { const quote = await work(); success = true; return quote; }
    finally {
      const ms = this.now() - at;
      if (success) { this.samples.push({ at: this.now(), ms }); this.ewma = this.ewma === undefined ? ms : this.ewma * .8 + ms * .2; }
    }
  }
  request(params: QuoteParams, enqueue: (deadline: QuoteDeadline) => Promise<Quote>, cached?: Quote): Promise<Quote> {
    const deadline = quoteDeadline(params, this.provider, this.now());
    if (deadline.deadlineMono <= this.now()) this.reject(deadline);
    const key = semanticQuoteKey(this.provider, params); this.count('coalescing_attempts');
    const pairKey = JSON.stringify([params.inputMint, params.outputMint, params.amountAtomic]);
    if (cached && this.now() < deadline.deadlineMono && this.wall() - cached.responseTimestamp >= 0 && this.wall() - cached.responseTimestamp < deadline.budgetMs) {
      this.count('provider_calls_avoided'); return Promise.resolve(cached);
    }
    let shared = this.entries.get(key);
    if (shared) { this.count('coalescing_hits'); this.count('provider_calls_avoided'); }
    else {
      if ([...this.entries.values()].some((e) => e.pairKey === pairKey)) this.count('coalescing_rejected_semantic_mismatch');
      const waiting = [...this.entries.values()].filter((e) => !e.dispatched);
      const sameClass = waiting.filter((e) => e.deadline.requestClass === deadline.requestClass).length;
      if (this.entries.size >= 128 || sameClass >= (deadline.requestClass === 'EXECUTION_PREFILTER' ? 32 : 48)) this.reject(deadline, 'OVERFLOW');
      // Fair service bounds legal start opportunities; HTTP estimate excludes queue residence.
      const ahead = deadline.requestClass === 'EXECUTION_PREFILTER' ? sameClass * 2 : waiting.length;
      const interval = typeof this.intervalMs === 'function' ? this.intervalMs() : this.intervalMs;
      const pacingRemaining = Math.max(0, this.forecast(deadline.budgetMs).predictedStartMono - this.now());
      this.check(deadline, pacingRemaining + ahead * interval);
      let resolve!: (q: Quote) => void, reject!: (e: unknown) => void;
      const promise = new Promise<Quote>((yes, no) => { resolve = yes; reject = no; });
      const cancel = new AbortController(); deadline.signal = cancel.signal;
      shared = { promise, deadline, waiters: 0, dispatched: false, cancel, pairKey, semantics: structuredClone(params) }; this.entries.set(key, shared);
      // Enqueue only after attaching the first waiter and publishing the shared entry.
      queueMicrotask(() => {
        Promise.resolve().then(() => enqueue(deadline)).then(resolve, reject).finally(() => this.entries.delete(key));
      });
    }
    if (shared.waiters >= 32) this.reject(deadline, 'OVERFLOW');
    shared.waiters++;
    const entry = shared;
    return new Promise<Quote>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: Quote) => {
        if (settled) return; settled = true; clearTimeout(timer); entry.waiters--;
        if (entry.waiters === 0 && !entry.dispatched) entry.cancel.abort();
        if (error) reject(error); else resolve(value!);
      };
      const timer = setTimeout(() => { this.count('waiter_deadline_expired'); finish(new QuoteAdmissionError(deadline.requestClass === 'EXECUTION_PREFILTER' ? 'PREFILTER_QUEUE_DEADLINE_EXCEEDED' : 'DISCOVERY_QUEUE_DEADLINE_EXCEEDED')); }, Math.max(0, deadline.deadlineMono - this.now()));
      entry.promise.then((quote) => {
        if (settled) return;
        if (this.now() >= deadline.deadlineMono || this.wall() - quote.responseTimestamp > deadline.budgetMs || quote.responseTimestamp > this.wall()) {
          this.count('coalescing_rejected_freshness'); finish(new QuoteAdmissionError('QUOTE_RESULT_STALE'));
        } else finish(undefined, quote);
      }, (error: unknown) => finish(error));
    });
  }
  snapshot() {
    this.pruneReservations();
    return { ...this.counters, active_workflow_reservations: this.reservations.size, cooldownCause: this.cooldownCause, active_shared_requests: this.entries.size,
      lanes: ['EXECUTION_PREFILTER','HIGH_PRIORITY_DISCOVERY','LOW_PRIORITY_DISCOVERY'].map((requestClass) => {
        const entries = [...this.entries.values()].filter((e) => e.deadline.requestClass === requestClass);
        return { requestClass, queued: entries.filter((e) => !e.dispatched).length, active: entries.filter((e) => e.dispatched).length,
          oldestQueuedAgeMs: Math.max(0, ...entries.filter((e) => !e.dispatched).map((e) => this.now() - e.deadline.createdMono)) };
      }), serviceEstimateMs: this.estimate(CONFIG.maxQuoteAgeMs) };
  }
}

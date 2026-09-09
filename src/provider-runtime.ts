import crypto from 'crypto';
import { QuoteAdmission, QuoteAdmissionError, semanticQuoteKey, type QuoteDeadline } from './quote-admission.js';
import type { QuoteParams } from './aggregators/types.js';
import { ScannerFairService } from './scanner-service-policy.js';
import { RollingWorkMetrics } from './work-metrics.js';
import { CONFIG } from './config.js';
import { HttpError } from './http.js';
import { log } from './logger.js';
import {
  isScannerRpcBackpressureError,
  runScannerRpc,
  scannerRpcLimiter,
} from './scanner-rpc-limiter.js';
import type { ProviderAvailabilityState, Quote, QuotePriority, QuoteProviderName } from './aggregators/types.js';

export interface ProviderHealth {
  admission: ReturnType<QuoteAdmission['snapshot']>;
  work: ReturnType<RollingWorkMetrics['snapshot']>;
  queueLength: number;
  active: number;
  provider: QuoteProviderName;
  requests: number;
  successes: number;
  failures: number;
  rateLimits429: number;
  averageLatencyMs: number;
  cacheHits: number;
  cacheMisses: number;
  deduplicatedRequests: number;
  circuitOpen: boolean;
  cooldownRemainingMs: number;
  state: ProviderAvailabilityState;
}

/**
 * Conservative per-provider scheduler for quote-only work.
 * It serializes a provider's requests, coalesces identical work, caches briefly,
 * and opens a temporary circuit after repeated failures. It never retries by
 * itself; HTTP retries remain bounded in getJson so there is only one retry layer.
 *
 * Orca and Meteora quote tasks are additionally admitted through the shared
 * scanner RPC limiter because both logical providers fan out into the same
 * scanner-side Solana RPC. Jupiter/Raptor remain independent HTTP paths.
 */
export class QuoteProviderRuntime {
  private admission: QuoteAdmission;
  private readonly fairService = new ScannerFairService();
  private readonly queue: Array<{
    task: () => Promise<Quote>;
    resolve: (quote: Quote) => void;
    reject: (error: unknown) => void;
    priority: QuotePriority;
    deadline?: QuoteDeadline;
  }> = [];
  private active = 0;
  private paceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cache = new Map<string, { quote: Quote; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<Quote>>();
  private lastRequestAt = 0;
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private latencyTotalMs = 0;
  private workMetrics = new RollingWorkMetrics();

  private readonly counters = {
    requests: 0,
    successes: 0,
    failures: 0,
    rateLimits429: 0,
    cacheHits: 0,
    cacheMisses: 0,
    deduplicatedRequests: 0,
  };

  constructor(
    readonly provider: QuoteProviderName,
    private readonly minIntervalMs: number,
    private readonly maxConcurrency = 1,
    private readonly maxQueue = CONFIG.directQuoteQueueMax,
  ) { this.admission = new QuoteAdmission(provider, minIntervalMs); }

  run(key: string, task: () => Promise<Quote>, priority: QuotePriority = 'LOW', params?: QuoteParams, deadline?: QuoteDeadline): Promise<Quote> {
    if (params) {
      const semanticKey = semanticQuoteKey(this.provider, params);
      const cached = this.cache.get(semanticKey);
      return this.admission.request(params, (deadline) => this.run(semanticKey, () => this.admission.dispatch(deadline, task), priority, undefined, deadline),
        cached && cached.expiresAt > Date.now() ? cached.quote : undefined);
    }
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.counters.cacheHits++;
      return Promise.resolve({ ...cached.quote, id: crypto.randomUUID() });
    }
    if (cached) this.cache.delete(key);
    this.counters.cacheMisses++;

    const inFlight = this.pending.get(key);
    if (inFlight) {
      this.counters.deduplicatedRequests++;
      return inFlight.then((quote) => ({ ...quote, id: crypto.randomUUID() }));
    }
    if (this.queue.length >= this.maxQueue) {
      throw new Error(`${this.provider} quote queue is at bounded discovery capacity`);
    }

    const queuedAt = Date.now();
    const promise = this.enqueue(async () => {
      if (deadline) {
        if (deadline.signal?.aborted) throw new QuoteAdmissionError('DISCOVERY_QUEUE_CANCELLED');
        this.admission.check(deadline);
      }
      const cooldownWait = Math.max(0, this.cooldownUntil - Date.now());
      if (cooldownWait > 0) {
        throw new Error(`${this.provider} provider circuit is cooling down for ${cooldownWait}ms`);
      }

      this.lastRequestAt = Date.now();
      this.counters.requests++;
      const started = Date.now();
      const finish = this.workMetrics.start(queuedAt);

      try {
        const runTask = () => task();
        const quote = this.provider === 'orca' || this.provider === 'meteora'
          ? await runScannerRpc(`${this.provider}.quote`, runTask, this.provider==='meteora'||priority === 'LOW' || priority === 'DISCOVERY_LOW' ? 'LOW' : 'HIGH')
          : await runTask();
        this.counters.successes++;
        finish(true);
        this.consecutiveFailures = 0;
        this.latencyTotalMs += Date.now() - started;
        this.cache.set(key, {
          quote,
          expiresAt: Date.now() + CONFIG.quoteCacheTtlMs,
        });
        while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
        return quote;
      } catch (error) {
        finish(false, /429|rate.?limit/i.test(error instanceof Error ? error.message : String(error)));
        // Shared scanner-RPC cooldown is deliberate admission control, not a
        // provider failure. Counting it as another provider error would open a
        // second circuit and lengthen the outage after the RPC is healthy.
        if (isScannerRpcBackpressureError(error) || error instanceof QuoteAdmissionError) throw error;

        this.counters.failures++;
        this.consecutiveFailures++;
        const rateLimited = (error instanceof HttpError && error.status === 429)
          || /\b429\b|rate limit/i.test(error instanceof Error ? error.message : String(error));
        if (rateLimited) {
          this.counters.rateLimits429++;
          log.warn(`[${this.provider}] rate-limited after bounded retries`);
        }
        if (this.consecutiveFailures >= CONFIG.providerFailureThreshold) {
          this.cooldownUntil = Date.now() + CONFIG.providerCooldownMs;
          log.warn(`[${this.provider}] circuit opened after repeated quote failures`, {
            cooldownMs: CONFIG.providerCooldownMs,
          });
        }
        throw error;
      }
    }, priority, deadline).finally(() => this.pending.delete(key));

    this.pending.set(key, promise);
    return promise;
  }

  isCoolingDown(): boolean {
    if (Date.now() < this.cooldownUntil) return true;
    return (this.provider === 'orca' || this.provider === 'meteora')
      && scannerRpcLimiter.isCoolingDown();
  }

  health(): ProviderHealth {
    const sharedCooldownRemainingMs = this.provider === 'orca' || this.provider === 'meteora'
      ? scannerRpcLimiter.snapshot().cooldownRemainingMs
      : 0;
    const ownCooldownRemainingMs = Math.max(0, this.cooldownUntil - Date.now());
    const state: ProviderAvailabilityState = this.isCoolingDown()
      ? 'COOLDOWN'
      : this.counters.failures > 0 && this.counters.successes === 0
        ? 'UNAVAILABLE'
        : this.counters.failures > 0 ? 'DEGRADED' : 'HEALTHY';
    return {
      provider: this.provider,
      admission: this.admission.snapshot(),
      work: this.workMetrics.snapshot(), queueLength: this.queue.length, active: this.active,
      ...this.counters,
      averageLatencyMs: this.counters.successes === 0
        ? 0
        : this.latencyTotalMs / this.counters.successes,
      circuitOpen: this.isCoolingDown(),
      cooldownRemainingMs: Math.max(ownCooldownRemainingMs, sharedCooldownRemainingMs),
      state,
    };
  }

  private enqueue(task: () => Promise<Quote>, priority: QuotePriority, deadline?: QuoteDeadline): Promise<Quote> {
    return new Promise<Quote>((resolve, reject) => {
      const queued = { task, resolve, reject, priority, deadline };
      this.queue.push(queued);
      deadline?.signal?.addEventListener('abort', () => {
        const index = this.queue.indexOf(queued);
        if (index >= 0) { this.queue.splice(index, 1); reject(new QuoteAdmissionError('DISCOVERY_QUEUE_CANCELLED')); }
      }, { once: true });
      this.workMetrics.observeQueue(this.queue.length);
      this.drain();
    });
  }

  /**
   * Start at most one request per provider interval while allowing a slow
   * request to overlap with the next paced request. This is intentionally a
   * small bounded queue: direct providers no longer serialize behind their
   * own RPC latency, but still cannot be hammered.
   */
  private drain(): void {
    if (this.paceTimer || this.active >= this.maxConcurrency || this.queue.length === 0) return;
    const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastRequestAt));
    if (waitMs > 0) {
      this.paceTimer = setTimeout(() => {
        this.paceTimer = null;
        this.drain();
      }, waitMs);
      return;
    }
    const next = this.fairService.take(this.queue, (item) => item.priority, (item) => item.deadline?.deadlineMono ?? Infinity)!;
    this.active++;
    next.task().then(next.resolve, next.reject).finally(() => {
      this.active--;
      this.drain();
    });
    // The following request may be eligible while this one is in flight.
    this.drain();
  }
}

export function quoteCacheKey(parts: Array<string | number | undefined>): string {
  return parts.map((part) => part ?? '').join('|');
}

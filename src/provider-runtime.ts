import crypto from 'crypto';
import { CONFIG } from './config.js';
import { HttpError } from './http.js';
import { log } from './logger.js';
import type { ProviderAvailabilityState, Quote, QuotePriority, QuoteProviderName } from './aggregators/types.js';

export interface ProviderHealth {
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
 */
export class QuoteProviderRuntime {
  private readonly queue: Array<{
    task: () => Promise<Quote>;
    resolve: (quote: Quote) => void;
    reject: (error: unknown) => void;
    priority: QuotePriority;
  }> = [];
  private active = 0;
  private paceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cache = new Map<string, { quote: Quote; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<Quote>>();
  private lastRequestAt = 0;
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private latencyTotalMs = 0;

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
  ) {}

  run(key: string, task: () => Promise<Quote>, priority: QuotePriority = 'LOW'): Promise<Quote> {
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
    if (this.queue.length >= this.maxQueue && priority !== 'HIGH') {
      throw new Error(`${this.provider} quote queue is at bounded discovery capacity`);
    }

    const promise = this.enqueue(async () => {
      const cooldownWait = Math.max(0, this.cooldownUntil - Date.now());
      if (cooldownWait > 0) {
        throw new Error(`${this.provider} provider circuit is cooling down for ${cooldownWait}ms`);
      }

      this.lastRequestAt = Date.now();
      this.counters.requests++;
      const started = Date.now();

      try {
        const quote = await task();
        this.counters.successes++;
        this.consecutiveFailures = 0;
        this.latencyTotalMs += Date.now() - started;
        this.cache.set(key, {
          quote,
          expiresAt: Date.now() + CONFIG.quoteCacheTtlMs,
        });
        return quote;
      } catch (error) {
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
    }, priority).finally(() => this.pending.delete(key));

    this.pending.set(key, promise);
    return promise;
  }

  isCoolingDown(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  health(): ProviderHealth {
    const state: ProviderAvailabilityState = this.isCoolingDown()
      ? 'COOLDOWN'
      : this.counters.failures > 0 && this.counters.successes === 0
        ? 'UNAVAILABLE'
        : this.counters.failures > 0 ? 'DEGRADED' : 'HEALTHY';
    return {
      provider: this.provider,
      ...this.counters,
      averageLatencyMs: this.counters.successes === 0
        ? 0
        : this.latencyTotalMs / this.counters.successes,
      circuitOpen: this.isCoolingDown(),
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - Date.now()),
      state,
    };
  }

  private enqueue(task: () => Promise<Quote>, priority: QuotePriority): Promise<Quote> {
    return new Promise<Quote>((resolve, reject) => {
      this.queue.push({ task, resolve, reject, priority });
      this.queue.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));
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
    const next = this.queue.shift()!;
    this.active++;
    next.task().then(next.resolve, next.reject).finally(() => {
      this.active--;
      this.drain();
    });
    // The following request may be eligible while this one is in flight.
    this.drain();
  }
}

function priorityRank(priority: QuotePriority): number {
  return priority === 'HIGH' ? 1 : 0;
}

export function quoteCacheKey(parts: Array<string | number | undefined>): string {
  return parts.map((part) => part ?? '').join('|');
}

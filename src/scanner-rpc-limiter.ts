import { log } from './logger.js';

export type ScannerRpcPriority = 'HIGH' | 'LOW';

export interface ScannerRpcLimiterOptions {
  maxConcurrency: number;
  minIntervalMs: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
  recoverySuccesses: number;
}

export interface ScannerRpcLimiterSnapshot {
  queued: number;
  active: number;
  effectiveConcurrency: number;
  maxConcurrency: number;
  rateLimits429: number;
  successfulTasks: number;
  failedTasks: number;
  cooldownRemainingMs: number;
  last429At: number | null;
}

interface QueueEntry<T> {
  label: string;
  priority: ScannerRpcPriority;
  sequence: number;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|too many requests|rate.?limit/i.test(message);
}

/**
 * Shared scanner-side RPC admission control.
 *
 * Orca/Meteora quote work, wallet/discovery reads, fee sampling, and scanner
 * policy reads all compete for the same public scanner RPC capacity. Keeping
 * one limiter here prevents independent provider schedulers from creating a
 * retry storm. The isolated live executor never imports or uses this limiter.
 */
export class ScannerRpcLimiter {
  private readonly queue: Array<QueueEntry<unknown>> = [];
  private active = 0;
  private effectiveConcurrency: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastStartAt = 0;
  private cooldownUntil = 0;
  private cooldownLevel = 0;
  private healthySince429 = 0;
  private sequence = 0;
  private rateLimits429 = 0;
  private successfulTasks = 0;
  private failedTasks = 0;
  private last429At: number | null = null;

  constructor(private readonly options: ScannerRpcLimiterOptions) {
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error('Scanner RPC maxConcurrency must be a positive integer');
    }
    if (options.minIntervalMs < 0 || options.baseCooldownMs < 0 || options.maxCooldownMs < options.baseCooldownMs) {
      throw new Error('Invalid scanner RPC timing configuration');
    }
    if (!Number.isInteger(options.recoverySuccesses) || options.recoverySuccesses < 1) {
      throw new Error('Scanner RPC recoverySuccesses must be a positive integer');
    }
    this.effectiveConcurrency = options.maxConcurrency;
  }

  run<T>(label: string, task: () => Promise<T>, priority: ScannerRpcPriority = 'LOW'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        priority,
        sequence: this.sequence++,
        task,
        resolve,
        reject,
      } as QueueEntry<unknown>);
      this.queue.sort((a, b) => {
        const priorityDelta = (b.priority === 'HIGH' ? 1 : 0) - (a.priority === 'HIGH' ? 1 : 0);
        return priorityDelta !== 0 ? priorityDelta : a.sequence - b.sequence;
      });
      this.drain();
    });
  }

  snapshot(): ScannerRpcLimiterSnapshot {
    return {
      queued: this.queue.length,
      active: this.active,
      effectiveConcurrency: this.effectiveConcurrency,
      maxConcurrency: this.options.maxConcurrency,
      rateLimits429: this.rateLimits429,
      successfulTasks: this.successfulTasks,
      failedTasks: this.failedTasks,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - Date.now()),
      last429At: this.last429At,
    };
  }

  private drain(): void {
    if (this.timer || this.active >= this.effectiveConcurrency || this.queue.length === 0) return;
    const now = Date.now();
    const waitMs = Math.max(
      0,
      this.cooldownUntil - now,
      this.options.minIntervalMs - (now - this.lastStartAt),
    );
    if (waitMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, waitMs);
      this.timer.unref?.();
      return;
    }

    const next = this.queue.shift()!;
    this.active++;
    this.lastStartAt = now;
    Promise.resolve()
      .then(next.task)
      .then((value) => {
        this.onSuccess(next.label);
        next.resolve(value);
      }, (error) => {
        this.onFailure(next.label, error);
        next.reject(error);
      })
      .finally(() => {
        this.active--;
        this.drain();
      });

    // Healthy mode may admit another task up to the current shared limit. The
    // minInterval still spaces starts, so a single logical quote cannot trigger
    // an unbounded cross-provider burst.
    this.drain();
  }

  private onFailure(label: string, error: unknown): void {
    this.failedTasks++;
    if (!isRateLimit(error)) return;
    this.rateLimits429++;
    this.last429At = Date.now();
    this.healthySince429 = 0;
    this.effectiveConcurrency = 1;
    this.cooldownLevel = Math.min(this.cooldownLevel + 1, 8);
    const cooldownMs = Math.min(
      this.options.maxCooldownMs,
      this.options.baseCooldownMs * 2 ** Math.max(0, this.cooldownLevel - 1),
    );
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldownMs);
    log.warn('Scanner RPC limiter entered adaptive cooldown after rate limit', {
      label,
      cooldownMs,
      effectiveConcurrency: this.effectiveConcurrency,
      queued: this.queue.length,
    });
  }

  private onSuccess(label: string): void {
    this.successfulTasks++;
    if (Date.now() < this.cooldownUntil || this.effectiveConcurrency >= this.options.maxConcurrency) return;
    this.healthySince429++;
    if (this.healthySince429 < this.options.recoverySuccesses) return;
    this.healthySince429 = 0;
    this.effectiveConcurrency++;
    this.cooldownLevel = Math.max(0, this.cooldownLevel - 1);
    log.info('Scanner RPC limiter restored capacity after healthy requests', {
      label,
      effectiveConcurrency: this.effectiveConcurrency,
      maxConcurrency: this.options.maxConcurrency,
    });
  }
}

export const scannerRpcLimiter = new ScannerRpcLimiter({
  maxConcurrency: boundedEnvInt('SCANNER_RPC_MAX_CONCURRENCY', 2, 1, 4),
  minIntervalMs: boundedEnvInt('SCANNER_RPC_MIN_INTERVAL_MS', 100, 0, 5_000),
  baseCooldownMs: boundedEnvInt('SCANNER_RPC_429_COOLDOWN_MS', 2_000, 100, 60_000),
  maxCooldownMs: boundedEnvInt('SCANNER_RPC_MAX_COOLDOWN_MS', 15_000, 500, 120_000),
  recoverySuccesses: boundedEnvInt('SCANNER_RPC_RECOVERY_SUCCESSES', 6, 1, 100),
});

export function runScannerRpc<T>(
  label: string,
  task: () => Promise<T>,
  priority: ScannerRpcPriority = 'LOW',
): Promise<T> {
  return scannerRpcLimiter.run(label, task, priority);
}

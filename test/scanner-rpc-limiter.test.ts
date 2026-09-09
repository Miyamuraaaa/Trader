import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  ScannerRpcBackpressureError,
  ScannerRpcLimiter,
} from '../src/scanner-rpc-limiter.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
afterEach(() => {vi.useRealTimers();vi.restoreAllMocks();});

describe('shared scanner RPC limiter', () => {
  it('prioritizes executable-prefilter work ahead of queued discovery work', async () => {
    const limiter = new ScannerRpcLimiter({
      maxConcurrency: 1,
      minIntervalMs: 0,
      baseCooldownMs: 1,
      maxCooldownMs: 10,
      recoverySuccesses: 2,
    });
    const order: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });

    const first = limiter.run('first', async () => {
      order.push('first');
      await blocker;
      return 'first';
    }, 'LOW');
    const low = limiter.run('low', async () => {
      order.push('low');
      return 'low';
    }, 'LOW');
    const high = limiter.run('high', async () => {
      order.push('high');
      return 'high';
    }, 'HIGH');

    await sleep(0);
    release();
    await Promise.all([first, low, high]);
    expect(order).toEqual(['first', 'high', 'low']);
  });

  it('drops to one shared task after a 429 and recovers only after healthy work', async () => {
    const limiter = new ScannerRpcLimiter({
      maxConcurrency: 2,
      minIntervalMs: 0,
      baseCooldownMs: 1,
      maxCooldownMs: 5,
      recoverySuccesses: 2,
    });

    await expect(limiter.run('rate-limited', async () => {
      throw new Error('HTTP 429 Too Many Requests');
    })).rejects.toThrow('429');

    expect(limiter.snapshot()).toMatchObject({
      effectiveConcurrency: 1,
      rateLimits429: 1,
      failedTasks: 1,
    });

    await sleep(3);
    await limiter.run('healthy-1', async () => 1);
    expect(limiter.snapshot().effectiveConcurrency).toBe(1);
    await limiter.run('healthy-2', async () => 2);
    expect(limiter.snapshot().effectiveConcurrency).toBe(2);
  });

  it('rejects queued and new scanner work immediately while a 429 cooldown is active', async () => {
    // Deterministic clock: a busy Windows runner must not consume this test's 20ms cooldown.
    vi.useFakeTimers();vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
    const limiter = new ScannerRpcLimiter({
      maxConcurrency: 1,
      minIntervalMs: 0,
      baseCooldownMs: 20,
      maxCooldownMs: 20,
      recoverySuccesses: 1,
    });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    let queuedRan = false;
    let newTaskRan = false;

    const first = limiter.run('rate-limited', async () => {
      await blocker;
      throw new Error('429 Too Many Requests');
    });
    const queued = limiter.run('queued', async () => {
      queuedRan = true;
      return 1;
    });

    release();
    await expect(first).rejects.toThrow('429');
    await expect(queued).rejects.toBeInstanceOf(ScannerRpcBackpressureError);
    expect(queuedRan).toBe(false);
    expect(limiter.snapshot().queued).toBe(0);

    await expect(limiter.run('new-during-cooldown', async () => {
      newTaskRan = true;
      return 2;
    })).rejects.toBeInstanceOf(ScannerRpcBackpressureError);
    expect(newTaskRan).toBe(false);

    expect(limiter.snapshot()).toMatchObject({ rejectedQueuedByBackpressure: 1, skippedDuringCooldown: 1, totalCooldowns: 1 });
    await vi.advanceTimersByTimeAsync(25);
    await expect(limiter.run('healthy-after-cooldown', async () => 3)).resolves.toBe(3);
  });
});

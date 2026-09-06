import { describe, expect, it } from 'vitest';
import { ScannerRpcLimiter } from '../src/scanner-rpc-limiter.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
});

import { afterEach, expect, it, vi } from 'vitest';
import { RollingWorkMetrics } from '../src/work-metrics.js';
afterEach(() => vi.useRealTimers());
it('TEST DATA: reports queue/latency percentiles and decays during inactivity', async () => {
  vi.useFakeTimers(); const metrics = new RollingWorkMetrics();
  const first = metrics.start(Date.now() - 10); await vi.advanceTimersByTimeAsync(100); first(true);
  const second = metrics.start(Date.now() - 30); await vi.advanceTimersByTimeAsync(200); second(false, true);
  expect(metrics.snapshot()).toMatchObject({ requests60s: 2, successes60s: 1, failures60s: 1, rateLimits60s: 1, queueWaitP50: 10, queueWaitP90: 30, requestLatencyP50: 100, requestLatencyP90: 200 });
  await vi.advanceTimersByTimeAsync(60_001); expect(metrics.snapshot().requests60s).toBe(0); expect(metrics.snapshot().requestLatencyP90).toBeNull();
});

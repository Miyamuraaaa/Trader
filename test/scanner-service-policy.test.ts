import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { LiveSizeCadence, ScannerFairService } from '../src/scanner-service-policy.js';
import { RollingWorkMetrics } from '../src/work-metrics.js';
import { RawPrefilterLedger } from '../src/execution/raw-prefilter-ledger.js';
afterEach(() => vi.useRealTimers());

describe('bounded scanner request-budget service', () => {
  it('reserves discovery service during a sustained prefilter burst', () => {
    const service = new ScannerFairService();
    const queue = Array.from({ length: 20 }, (_, id) => ({ id, priority: 'EXEC_PREFILTER_HIGH' }));
    queue.push({ id: 100, priority: 'HIGH' }, { id: 101, priority: 'LOW' });
    const first = Array.from({ length: 4 }, () => service.take(queue, (r) => r.priority)!.id);
    expect(first).toEqual([0, 1, 100, 101]); expect(queue.length).toBe(18);
    for (let round = 0; round < 10; round++) {
      queue.push({ id: 100, priority: 'HIGH' }, { id: 101, priority: 'LOW' });
      const selected = Array.from({ length: 4 }, () => service.take(queue, (r) => r.priority));
      expect(selected.some((r) => r?.id === 100)).toBe(true); expect(selected.some((r) => r?.id === 101)).toBe(true);
    }
  });
  it('keeps bounded prefilter priority and FIFO per class under discovery load', () => {
    const service = new ScannerFairService();
    const queue = ['LOW', 'LOW', 'HIGH', 'HIGH', 'EXEC_PREFILTER_HIGH', 'EXEC_PREFILTER_HIGH'];
    expect(Array.from({ length: 4 }, () => service.take(queue, (r) => r))).toEqual(['EXEC_PREFILTER_HIGH', 'EXEC_PREFILTER_HIGH', 'HIGH', 'LOW']);
    expect(service.take([], String)).toBeUndefined();
  });
  it('preserves all observation sizes at bounded lower cadence without increasing caps', () => {
    const sizes = [.01, .05, .1, .25, .5, 1]; const cadence = new LiveSizeCadence();
    const observed = Array.from({ length: 32 }, () => cadence.next(sizes, .05)!);
    expect(observed.filter((n) => n <= .05)).toHaveLength(24);
    expect(new Set(observed)).toEqual(new Set(sizes));
    expect(new LiveSizeCadence().next([], .05)).toBeUndefined();
    expect(new LiveSizeCadence().next([1], .05)).toBe(1);
  });
  it('keeps above-cap admission before constrained requests and background prefilters outside cycle barrier', async () => {
    const scanner = await readFile('src/scanner.ts', 'utf8');
    const admission = scanner.slice(scanner.indexOf('async function findExecutableCandidates'), scanner.indexOf('function spreadPrefilter'));
    expect(admission.indexOf("'ABOVE_LIVE_CAP'")).toBeLessThan(admission.indexOf('prefilterCoalescer.schedule'));
    expect(admission).toContain('eligibility ? { status: eligibility, trace }');
    const fast = scanner.slice(scanner.indexOf('const fastMatrix = await'), scanner.indexOf('const completeDirectWork'));
    expect(fast).not.toContain('await Promise.all(fastMatrix.routes');
    expect(fast).toContain('void job.then');
    expect(scanner).toContain('directBackgroundLane.reserve()');
    expect(scanner).toContain('backgroundDirect && !releaseDirect');
  });
  it('expires rolling work samples rather than resetting buckets; records high-water', async () => {
    vi.useFakeTimers(); const work = new RollingWorkMetrics(); work.observeQueue(20);
    const finish = work.start(Date.now() - 10); await vi.advanceTimersByTimeAsync(100); finish(true);
    expect(work.snapshot()).toMatchObject({ requests60s: 1, successes60s: 1, queueWaitP50: 10, requestLatencyP50: 100, queueHighWater60s: 20 });
    await vi.advanceTimersByTimeAsync(60_001); expect(work.snapshot()).toMatchObject({ requests60s: 0, queueHighWater60s: 0 });
  });
  it('assigns exactly one outcome per raw detection without lifecycle overriding cap', () => {
    const ledger = new RawPrefilterLedger(); const now = Date.now();
    const outcomes = ['ABOVE_LIVE_CAP', 'COALESCED', 'RAW_SIGNAL_ENDED', 'DISCOVERY_ONLY_TOKEN_2022', 'ECONOMICS_DIVERGED'];
    outcomes.forEach((status, i) => {
      ledger.register(String(i), { rawPositiveDetectedAt: now, rawQuoteEvidenceAt: now, rawQuoteAgeAtDetectionMs: 0, executablePrefilterQueuedAt: now });
      ledger.finish(String(i), status); ledger.finish(String(i), 'RAW_SIGNAL_ENDED');
    });
    expect(ledger.snapshot()).toMatchObject({ rawPositive: 5, accounted: 5, buckets: {
      ABOVE_LIVE_CAP: 1, QUOTE_FAILED: 1, PREFILTER_QUEUE_DEADLINE_EXCEEDED: 1, TOKEN_2022_DISCOVERY_ONLY: 1, ECONOMICS_DIVERGED: 1,
    } });
  });
  it('benchmarks identical finite service budgets before/after fair scheduling (synthetic, no network)', () => {
    const scenarios = ['healthy', '20 raw positives', 'above-cap positives'];
    const rows = scenarios.map((scenario) => {
      function run(fair: boolean) {
        const service = new ScannerFairService();
        const queue: Array<{ priority: string; at: number }> = []; const waits: number[] = [];
        let discovery = 0, prefilter = 0, highWater = 0;
        // 60 paced service slots in either implementation. No RPS or concurrency increase.
        for (let tick = 0; tick < 60; tick++) {
          if (tick % 2 === 0) queue.push({ priority: 'HIGH', at: tick }, { priority: 'LOW', at: tick });
          if (scenario === '20 raw positives') {
            if (tick < 20) queue.push({ priority: 'EXEC_PREFILTER_HIGH', at: tick });
          }
          highWater = Math.max(highWater, queue.length);
          const job = fair ? service.take(queue, (r) => r.priority) : queue.splice(Math.max(0, queue.findIndex((r) => r.priority !== 'LOW')), 1)[0];
          if (!job) continue;
          waits.push((tick - job.at) * 1000);
          if (job.priority === 'EXEC_PREFILTER_HIGH') prefilter++; else discovery++;
        }
        waits.sort((a, b) => a - b);
        return { discoveryRequests60s: discovery, prefilterRequests60s: prefilter, queueP50Ms: waits[Math.ceil(waits.length * .5) - 1], queueP90Ms: waits[Math.ceil(waits.length * .9) - 1], highWater };
      }
      return { scenario, before: run(false), after: run(true) };
    });
    expect(rows.every((r) => r.after.discoveryRequests60s + r.after.prefilterRequests60s <= 60)).toBe(true);
    expect(rows[0]!.after).toEqual(rows[2]!.after);
    process.stdout.write('SYNTHETIC SERVICE-BUDGET BENCHMARK (not route throughput or HTTP measurements) ' + JSON.stringify(rows) + '\n');
  });
});

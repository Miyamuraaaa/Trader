import { afterEach, expect, it, vi } from 'vitest';
import { QuoteAdmission, type QuoteDeadline } from '../src/quote-admission.js';
import { ScannerFairService } from '../src/scanner-service-policy.js';
import type { Quote, QuoteParams } from '../src/aggregators/types.js';
afterEach(() => vi.useRealTimers());

it('benchmarks the same 1 RPS/375ms service budget under a prefilter burst, with no late dispatch', async () => {
  vi.useFakeTimers(); const origin = Date.now();
  const summaries = [];
  for (const guarded of [false, true]) {
    const start = Date.now(); const now = () => Date.now() - start;
    const admission = new QuoteAdmission('raptor', 1000, now, () => Date.now());
    const fair = new ScannerFairService();
    type Job = { deadline: QuoteDeadline; params: QuoteParams; resolve: (q: Quote) => void; reject: (e: unknown) => void };
    const queue: Job[] = []; const waits: number[] = []; const prefilterWaits: number[] = []; const completions: Promise<unknown>[] = [];
    let requests = 0, discovery = 0, prefilter = 0, deadlineDrops = 0, infeasibleDispatched = 0, highWater = 0;
    const enqueue = (params: QuoteParams, deadline: QuoteDeadline) => new Promise<Quote>((resolve, reject) => {
      const job = { params, deadline, resolve, reject }; queue.push(job); highWater = Math.max(highWater, queue.length);
      deadline.signal?.addEventListener('abort', () => { const index = queue.indexOf(job); if (index >= 0) { queue.splice(index, 1); reject(new Error('CANCELLED')); } }, { once: true });
    });
    const submit = (priority: QuoteParams['priority'], id: number) => {
      const params: QuoteParams = { inputMint: 'IN', outputMint: 'OUT', amountAtomic: String(id), slippageBps: 5, priority };
      try {
        const work = guarded ? admission.request(params, (d) => enqueue(params, d)) : enqueue(params, { createdMono: now(), deadlineMono: now() + (priority === 'EXEC_PREFILTER_HIGH' ? 1800 : 5000), budgetMs: 5000, requestClass: priority === 'EXEC_PREFILTER_HIGH' ? 'EXECUTION_PREFILTER' : 'HIGH_PRIORITY_DISCOVERY' });
        completions.push(work.catch(() => { deadlineDrops++; }));
      } catch { deadlineDrops++; }
    };
    for (let tick = 0; tick < 60; tick++) {
      if (tick % 2 === 0) { submit('DISCOVERY_HIGH', tick * 100); submit('DISCOVERY_LOW', tick * 100 + 1); }
      if (tick === 10) for (let i = 0; i < 20; i++) submit('EXEC_PREFILTER_HIGH', 10000 + i);
      await vi.advanceTimersByTimeAsync(0);
      const job = fair.take(queue, (j) => j.params.priority, guarded ? (j) => j.deadline.deadlineMono : undefined);
      if (job) {
        const task = async () => {
          requests++; waits.push(now() - job.deadline.createdMono);
          if (now() + 375 > job.deadline.deadlineMono) infeasibleDispatched++;
          if (job.params.priority === 'EXEC_PREFILTER_HIGH') { prefilter++; prefilterWaits.push(now() - job.deadline.createdMono); } else discovery++;
          await new Promise((resolve) => setTimeout(resolve, 375));
          return { responseTimestamp: Date.now(), outAmount: '1' } as Quote;
        };
        void (guarded ? admission.dispatch(job.deadline, task) : task()).then(job.resolve, job.reject);
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    for (const job of queue.splice(0)) job.reject(new Error('BENCHMARK_ENDED'));
    await Promise.all(completions);
    waits.sort((a,b) => a-b);
    prefilterWaits.sort((a,b) => a-b);
    const summary = { guarded, requests60s: requests, discovery, prefilter, deadlineDrops, infeasibleDispatched, highWater, queueP50: waits[Math.ceil(waits.length*.5)-1], queueP90: waits[Math.ceil(waits.length*.9)-1], prefilterQueueP90: prefilterWaits[Math.ceil(prefilterWaits.length*.9)-1] };
    summaries.push(summary);
    expect(requests).toBeLessThanOrEqual(60);
    if (guarded) { expect(infeasibleDispatched).toBe(0); expect(discovery).toBeGreaterThan(30); expect(prefilter).toBeGreaterThan(0); expect(admission.snapshot().active_shared_requests).toBe(0); }
  }
  expect(Date.now()).toBeGreaterThan(origin);
  process.stdout.write('SYNTHETIC DEADLINE ADMISSION BENCHMARK (not market profit or route throughput) ' + JSON.stringify(summaries) + '\n');
});

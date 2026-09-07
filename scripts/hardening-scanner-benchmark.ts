import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, readFile, rename, open, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScannerFirstLegBulkheads, ScannerBackgroundLane } from '../src/scanner-bulkheads.js';
import { createAtomicJsonWriter } from '../src/persistence/atomic-json-file.js';
import type { Quote, QuoteParams, QuoteProvider, QuoteProviderName } from '../src/aggregators/types.js';

// Isolated synthetic scheduling benchmark: imports no scanner entrypoint/signer/sender.
// Deliberately does not produce arbitrage candidates or touch runtime data files.
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const percentile = (v: number[], q: number) => [...v].sort((a, b) => a - b)[Math.max(0, Math.ceil(v.length * q) - 1)] ?? null;
type Scenario = 'healthy' | 'orca+1000ms' | 'meteora429' | 'rpc-cooldown';
const params: QuoteParams = { inputMint: 'TEST_DATA_BASE', outputMint: 'TEST_DATA_TOKEN', amountAtomic: '10000', slippageBps: 5 };
async function measure(scenario: Scenario, isolated: boolean) {
  let requests = 0, rateLimits = 0, skips = 0, aggregatorEvals = 0, directEvals = 0, mixedEvals = 0;
  const latency: number[] = []; const cycleTimes: number[] = [];
  const providers: QuoteProvider[] = (['jupiter', 'raptor', 'orca', 'raydium', 'meteora'] as QuoteProviderName[]).map((name) => {
    const kind = name === 'jupiter' || name === 'raptor' ? 'aggregator' : 'direct';
    const ms = scenario === 'orca+1000ms' && name === 'orca' ? 1020 : 20;
    let cooldownUntil = 0;
    return { name, kind, capabilities: { quote: true, dryRun: false, execution: false, streaming: false, atomicCycle: false },
      health: () => ({ state: 'HEALTHY', requests: 0, successes: 0, failures: 0, rateLimits429: 0, averageLatencyMs: ms, circuitOpen: false }),
      supportsPair: async () => true,
      isRateLimited: () => { const skipped = (scenario === 'rpc-cooldown' && kind === 'direct') || Date.now() < cooldownUntil; if (skipped) skips++; return skipped; },
      getQuote: async (p): Promise<Quote> => {
        requests++; const start = performance.now(); await delay(ms); latency.push(performance.now() - start);
        if (scenario === 'meteora429' && name === 'meteora') { rateLimits++; cooldownUntil = Date.now() + 3000; throw new Error('TEST DATA 429'); }
        return { provider: name, id: 'TEST DATA', inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amountAtomic,
          consumedInAmount: p.amountAtomic, outAmount: '9990', otherAmountThreshold: '9980', swapMode: 'ExactIn',
          slippageBps: 5, routePlan: [], poolIds: [], isPartialFill: false, requestTimestamp: Date.now(), responseTimestamp: Date.now(), latencyMs: ms, rawResponse: 'TEST DATA' };
      } };
  });
  const quotes = async (ps: QuoteProvider[], p: QuoteParams) => Promise.all(ps.map(async (provider) => {
    if (provider.isRateLimited()) return { provider: provider.name };
    try { return { provider: provider.name, quote: await provider.getQuote(p) }; }
    catch { return { provider: provider.name }; }
  }));
  const lanes = new ScannerFirstLegBulkheads(quotes); const background = new ScannerBackgroundLane();
  const pending = new Set<Promise<void>>(); const start = performance.now(); const duration = 2500;
  while (performance.now() - start < duration) {
    const cycle = performance.now();
    const release = isolated ? background.reserve() : undefined;
    const selected = isolated && !release ? providers.filter((p) => p.kind === 'aggregator') : providers;
    if (isolated) {
      const first = lanes.start(selected, params, 100);
      const direct = first.mixed.then(async (results) => {
        // Fixed second-leg service time isolates the FIRST-LEG barrier under test.
        await delay(20); const d = results.filter((r) => r.quote && r.provider !== 'jupiter' && r.provider !== 'raptor').length;
        directEvals += d * Math.max(0, d - 1); mixedEvals += 4 * d;
      }).finally(() => { release?.(); pending.delete(direct); });
      pending.add(direct);
      await first.aggregator; await delay(20); aggregatorEvals += 2;
    } else {
      const results = await quotes(selected, params); await delay(20); aggregatorEvals += 2;
      const d = results.filter((r) => r.quote && r.provider !== 'jupiter' && r.provider !== 'raptor').length;
      directEvals += d * Math.max(0, d - 1); mixedEvals += 4 * d;
    }
    cycleTimes.push(performance.now() - cycle);
  }
  const elapsed = performance.now() - start;
  const perMinute = (n: number) => Math.round(n * 60_000 / elapsed);
  const result = { scenario, scheduler: isolated ? 'bulkheads' : 'old-all-provider-barrier',
    aggregatorEvalsPerMin: perMinute(aggregatorEvals), directEvalsPerMin: perMinute(directEvals), mixedEvalsPerMin: perMinute(mixedEvals),
    totalEvalsPerMin: perMinute(aggregatorEvals + directEvals + mixedEvals), completedScansPerMin: perMinute(cycleTimes.length),
    cycleP50Ms: percentile(cycleTimes, .5), cycleP90Ms: percentile(cycleTimes, .9), providerTaskP50Ms: percentile(latency, .5), providerTaskP90Ms: percentile(latency, .9),
    requests, rateLimits, backpressureSkips: skips, queueWait: 'not modeled; provider queues covered separately by tests', stale: 'no market evidence in this synthetic benchmark' };
  await Promise.all(pending); await delay(scenario === 'orca+1000ms' && isolated ? 1050 : 0);
  return result;
}
console.log('SYNTHETIC FIRST-LEG SCHEDULER BENCHMARK — NO MARKET DATA / NO BROADCAST');
console.log('Second-leg service held at 20ms; rates are scheduling capacity, NOT live provider throughput.');
for (const scenario of ['healthy', 'orca+1000ms', 'meteora429', 'rpc-cooldown'] as Scenario[]) {
  for (const isolated of [false, true]) console.log(JSON.stringify(await measure(scenario, isolated)));
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'trader-hardening-benchmark-'));
try {
  let attempts = 0;
  const write = createAtomicJsonWriter({ mkdir, open, unlink, rename: async (a, b) => {
    if (++attempts === 1) throw Object.assign(new Error('TEST DATA transient lock'), { code: 'EPERM' });
    return rename(a, b);
  } });
  const file = path.join(directory, 'test-only.json'); const start = performance.now();
  await write(file, () => ({ testOnly: true, unresolved: ['TEST_SUBMITTING'] }));
  console.log(JSON.stringify({ scenario: 'Windows transient EPERM', attempts, elapsedMs: performance.now() - start, documentPreserved: JSON.parse(await readFile(file, 'utf8')).unresolved[0] === 'TEST_SUBMITTING' }));
} finally {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('trader-hardening-benchmark-')) throw new Error('Unsafe temporary cleanup target');
  await rm(directory, { recursive: true, force: true });
}

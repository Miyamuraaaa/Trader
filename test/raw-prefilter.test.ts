import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { CONFIG, MINTS } from '../src/config.js';
import type { Quote, QuoteProviderName } from '../src/aggregators/types.js';
import type { RoundTripResult } from '../src/routes.js';
import { calculateEstimatedRoundTripProfit } from '../src/profit.js';
import { buildExecutableCandidateFromRaw } from '../src/execution/scanner-executable-prefilter.js';
import { PrefilterCoalescer, type PrefilterTrace } from '../src/execution/prefilter-trace.js';
import { RawPrefilterLedger } from '../src/execution/raw-prefilter-ledger.js';
import { scannerLifecycleDisplay } from '../src/execution/scanner-display-eligibility.js';
import { isFreshPositiveAuditedExecutionSignal } from '../src/execution/scanner-handoff-eligibility.js';

afterEach(() => vi.useRealTimers());
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function quote(provider: QuoteProviderName, inputMint: string, outputMint: string, amount: string): Quote {
  return { provider, id: `TEST_${provider}`, inputMint, outputMint, inAmount: amount, consumedInAmount: amount,
    outAmount: outputMint === MINTS.USDC ? '70000' : '1000', otherAmountThreshold: outputMint === MINTS.USDC ? '69000' : '990',
    isPartialFill: false, swapMode: 'ExactIn', slippageBps: 5, poolIds: [`TEST_POOL_${provider}`],
    routePlan: [{ swapInfo: { label: provider === 'raptor' ? 'Raydium CLMM' : 'Whirlpool',
      programId: provider === 'raptor' ? 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' : 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' } }],
    requestTimestamp: Date.now(), responseTimestamp: Date.now(), latencyMs: 0, rawResponse: 'TEST DATA ONLY' };
}
function raw(): RoundTripResult {
  const buyQuote = quote('jupiter', MINTS.USDC, MINTS.SOL, '50000');
  const sellQuote = quote('raptor', MINTS.SOL, MINTS.USDC, '1000');
  return { buyQuote, sellQuote, classification: 'AGGREGATOR_ARBITRAGE', liquidityOverlap: false, quoteSkewMs: 0, stale: false,
    category: 'HIGH_SPREAD', validationTier: 'QUOTE_CANDIDATE', opportunityScope: 'RAW_MARKET_OPPORTUNITY',
    profit: calculateEstimatedRoundTripProfit('.05', sellQuote, .001) };
}
const costs = { referenceSolPriceUsdc: 150, estimatedNetworkCostsUsdc: { baseNetworkFeeUsdc: .001, priorityFeeUsdc: 0 } };
const supported = async () => ({ status: 'SUPPORTED' as const, rentLamports: 0 });

describe('TEST DATA ONLY: raw-positive constrained prefilter', () => {
  it('never spends policy or provider capacity on above-cap raw positives', async () => {
    const candidate = raw(); candidate.buyQuote.inAmount = '1000000000000';
    const policy = vi.fn(supported); const quoted = vi.fn(async (...args: Parameters<typeof quote>) => quote(...args));
    expect((await buildExecutableCandidateFromRaw(candidate, costs, { policy, quote: quoted })).status).toBe('ABOVE_LIVE_CAP');
    expect(policy).not.toHaveBeenCalled(); expect(quoted).not.toHaveBeenCalled();
  });
  it('cannot bypass the live cap with a caller-created diagnostic symbol', async () => {
    const candidate = raw(); candidate.buyQuote.inAmount = '1000000000000';
    const policy = vi.fn(supported); const quoted = vi.fn(async (...args: Parameters<typeof quote>) => quote(...args));
    const result = await buildExecutableCandidateFromRaw(candidate, costs, { policy, quote: quoted, diagnosticCapability: Symbol('SHADOW_CAP_DIAGNOSTIC') });
    expect(result.status).toBe('ABOVE_LIVE_CAP');
    expect(policy).not.toHaveBeenCalled(); expect(quoted).not.toHaveBeenCalled();
  });
  it('records future raw evidence as a terminal prefilter result without provider work', async () => {
    const candidate = raw(); candidate.buyQuote.responseTimestamp += 60000; candidate.sellQuote.responseTimestamp += 60000;
    const quoted = vi.fn(async (...args: Parameters<typeof quote>) => quote(...args));
    const result = await buildExecutableCandidateFromRaw(candidate, costs, { policy: supported, quote: quoted });
    expect(result).toMatchObject({ status: 'PREFILTER_STALE', reason: 'INVALID_OR_FUTURE_MARKET_EVIDENCE' });
    expect(quoted).not.toHaveBeenCalled(); expect(result.trace?.prefilterFinishedAt).toBeDefined();
  });
  it('overlaps token policy with leg1, then propagates its enforceable minimum to leg2', async () => {
    vi.useFakeTimers(); const start = Date.now(); const calls: Array<{ at: number; amount: string }> = [];
    const result = buildExecutableCandidateFromRaw(raw(), costs, {
      monotonicNow: () => Date.now() - start,
      policy: async () => { await delay(100); return supported(); },
      quote: async (provider, input, output, amount) => { calls.push({ at: Date.now() - start, amount }); await delay(provider === 'jupiter' ? 80 : 60); return quote(provider, input, output, amount); },
    });
    await vi.advanceTimersByTimeAsync(81); expect(calls).toEqual([{ at: 0, amount: '50000' }]);
    await vi.advanceTimersByTimeAsync(80); const value = await result;
    expect(calls[1]).toEqual({ at: 100, amount: '990' });
    expect(value.status).toBe('EXECUTABLE_CANDIDATE');
    expect(value.trace).toMatchObject({ tokenPolicyMs: 100, constrainedLeg1Ms: 80, constrainedLeg2Ms: 60, totalPrefilterMs: 160 });
    expect(isFreshPositiveAuditedExecutionSignal(raw())).toBe(false);
    expect(isFreshPositiveAuditedExecutionSignal(value.route!)).toBe(true);
  });
  it.each(['TOKEN_2022', 'REJECTED'] as const)('never calls leg2 after %s policy classification', async (status) => {
    const quoted = vi.fn(async (...args: Parameters<typeof quote>) => quote(...args));
    const value = await buildExecutableCandidateFromRaw(raw(), costs, { policy: async () => ({ status, rentLamports: 0 }), quote: quoted });
    expect(value.status).toBe(status === 'TOKEN_2022' ? 'DISCOVERY_ONLY_TOKEN_2022' : 'TOKEN_POLICY_REJECTED');
    expect(quoted).toHaveBeenCalledTimes(1);
  });
  it('separates stale raw evidence, stale constrained quotes and rate limits', async () => {
    const old = raw(); old.buyQuote.responseTimestamp -= CONFIG.maxQuoteAgeMs + 1;
    const quoted = vi.fn(async (...args: Parameters<typeof quote>) => quote(...args));
    expect((await buildExecutableCandidateFromRaw(old, costs, { policy: supported, quote: quoted })).status).toBe('RAW_STALE_BEFORE_PREFILTER');
    expect(quoted).not.toHaveBeenCalled();
    expect((await buildExecutableCandidateFromRaw(raw(), costs, { policy: supported, quote: async (...args) => ({ ...quote(...args), responseTimestamp: Date.now() - CONFIG.maxQuoteAgeMs - 1 }) })).status).toBe('PREFILTER_STALE');
    expect((await buildExecutableCandidateFromRaw(raw(), costs, { policy: supported, quote: async () => { throw new Error('HTTP 429'); } })).status).toBe('PREFILTER_RATE_LIMITED');
  });
  it('retains negative constrained economics and blocks wrong-program quotes', async () => {
    const negative = await buildExecutableCandidateFromRaw(raw(), costs, { policy: supported, quote: async (...args) => ({ ...quote(...args), ...(args[2] === MINTS.USDC ? { outAmount: '49000', otherAmountThreshold: '48000' } : {}) }) });
    expect(negative.status).toBe('ECONOMICS_DIVERGED'); expect(negative.route!.profit.worstCaseNetProfitUsdc.lt(0)).toBe(true);
    const wrong = await buildExecutableCandidateFromRaw(raw(), costs, { policy: supported, quote: async (...args) => ({ ...quote(...args), routePlan: [{ swapInfo: { programId: 'BAD', label: 'Whirlpool' } }] }) });
    expect(wrong.status).toBe('ROUTE_POLICY_REJECTED');
  });
  it('coalesces identical evidence and retains only one newest bounded rerun', async () => {
    vi.useFakeTimers(); const scheduler = new PrefilterCoalescer<string>(1); let calls = 0;
    const run = async () => { calls++; await delay(100); return 'DONE'; };
    const first = scheduler.schedule('route', 100, run, String);
    expect(await scheduler.schedule('route', 100, run, String)).toBe('COALESCED');
    const replaced = scheduler.schedule('route', 200, run, String);
    const newest = scheduler.schedule('route', 300, run, String);
    expect(await replaced).toBe('COALESCED');
    expect(await scheduler.schedule('other', 300, run, String)).toBe('PREFILTER_RATE_LIMITED');
    expect(calls).toBe(1); await vi.advanceTimersByTimeAsync(201);
    expect(await first).toBe('DONE'); expect(await newest).toBe('DONE'); expect(calls).toBe(2); expect(scheduler.activeRoutes).toBe(0);
  });
  it('reconciles raw detection cohorts across the completion/window boundary', () => {
    let now = 100_000; const ledger = new RawPrefilterLedger(() => now);
    for (const [i, result] of ['ABOVE_LIVE_CAP', 'ECONOMICS_DIVERGED', 'EXECUTABLE_CANDIDATE', 'COALESCED', 'PREFILTER_RATE_LIMITED'].entries()) {
      const trace: PrefilterTrace = { rawPositiveDetectedAt: now, rawQuoteEvidenceAt: now, rawQuoteAgeAtDetectionMs: 0, executablePrefilterQueuedAt: now };
      ledger.register(String(i), trace); ledger.finish(String(i), result);
    }
    expect(ledger.snapshot().rawPositive).toBe(5); expect(ledger.snapshot().accounted).toBe(5);
    expect(ledger.snapshot().buckets.EXECUTOR_CONSTRAINED_POSITIVE).toBe(1);
    now += 60_001; expect(ledger.snapshot(60_000).rawPositive).toBe(0); expect(ledger.snapshot(300_000).accounted).toBe(5);
  });
  it('labels scanner lifecycle independently and preserves execution freshness and authority boundaries', async () => {
    expect(scannerLifecycleDisplay('EXPIRED')).toBe('MARKET_SIGNAL_ENDED');
    expect(CONFIG.maxExecutionQuoteAgeMs).toBe(1200);
    const source = await readFile('src/config.ts', 'utf8'); expect(source).toMatch(/RAPTOR_EXECUTION_QUOTE_AGE_MS[^\n]*1800/);
    const prefilter = await readFile('src/execution/scanner-executable-prefilter.ts', 'utf8');
    expect(prefilter).not.toMatch(/sendRawTransaction|sendTransaction|loadDedicatedSigner|broadcaster/);
  });
  it('benchmarks deterministic quote-only fixtures without publishing synthetic opportunities', async () => {
    vi.useFakeTimers();
    const samples: Array<{ before: number; after: number; queue: number; leg1: number; leg2: number }> = [];
    const ledger = new RawPrefilterLedger();
    for (let i = 0; i < 10; i++) {
      const policyMs = 100 + i * 10, leg1Ms = 80 + i * 5, leg2Ms = 60 + i * 5;
      const candidate = raw(); const at = Date.now();
      const trace: PrefilterTrace = { rawPositiveDetectedAt: at, rawQuoteEvidenceAt: at, rawQuoteAgeAtDetectionMs: 0, executablePrefilterQueuedAt: at };
      ledger.register(String(i), trace);
      const pending = buildExecutableCandidateFromRaw(candidate, costs, { trace,
        monotonicNow: () => Date.now() - at,
        policy: async () => { await delay(policyMs); return supported(); },
        quote: async (...args) => {
          await delay(args[0] === 'jupiter' ? leg1Ms : leg2Ms);
          if (i === 9) throw new Error('HTTP 429 fixture');
          const value = quote(...args);
          return i >= 6 && args[2] === MINTS.USDC ? { ...value, outAmount: '49000', otherAmountThreshold: '48000' } : value;
        },
      });
      await vi.runAllTimersAsync(); const result = await pending;
      ledger.finish(String(i), result.status, result.trace);
      samples.push({ before: policyMs + leg1Ms + (i === 9 ? 0 : leg2Ms), after: trace.totalPrefilterMs!, queue: trace.prefilterQueueMs!, leg1: trace.constrainedLeg1Ms!, leg2: trace.constrainedLeg2Ms ?? 0 });
    }
    const quantiles = (values: number[]) => { values.sort((a, b) => a - b); return { p50: values[4], p90: values[8], worst: values[9] }; };
    const result = ledger.snapshot();
    expect(result.rawPositive).toBe(10); expect(result.accounted).toBe(10); expect(result.completed).toBe(10);
    expect(result.buckets).toEqual({ EXECUTOR_CONSTRAINED_POSITIVE: 6, ECONOMICS_DIVERGED: 3, PREFILTER_RATE_LIMITED: 1 });
    process.stdout.write('SYNTHETIC NO-BROADCAST PREFILTER BENCHMARK ' + JSON.stringify({
      clock: 'deterministic simulated milliseconds; not real provider latency',
      sequentialBaseline: quantiles(samples.map((s) => s.before)), parallelPrefilter: quantiles(samples.map((s) => s.after)),
      rawToStart: quantiles(samples.map((s) => s.queue)), leg1: result.leg1Ms, leg2: result.leg2Ms,
      completedPercent: 100, distribution: result.buckets, p0Count: 0, executorCount: 0, executorExpiries: 0, broadcasts: 0,
    }) + '\n');
  });
});

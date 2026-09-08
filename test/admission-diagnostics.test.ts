import { describe, expect, it } from 'vitest';
import { breakEvenDiagnostic } from '../src/scanner-size-diagnostics.js';
import { BoundedAdvisoryCache } from '../src/bounded-advisory-cache.js';
import { RawPrefilterLedger } from '../src/execution/raw-prefilter-ledger.js';
import { LiveSizeCadence } from '../src/scanner-service-policy.js';
import { ExecutionFunnel } from '../src/execution/execution-funnel.js';

describe('admission diagnostics do not grant execution authority', () => {
  it('uses existing costs once, distinguishes missing ATA, and applies the stricter profit/ROI requirement', () => {
    const existing = breakEvenDiagnostic(.05, .05, { baseNetworkFeeUsdc: .001, priorityFeeUsdc: .0001, ataRentUsdc: 0 }, .0001, 10);
    expect(existing).toMatchObject({ additionalCostUsdc: '0.0011', costBps: '220', requiredMinimumQuotedOutputUsdc: '0.0512', executionEligible: true, costDataComplete: true });
    expect(breakEvenDiagnostic(.05, .05, { baseNetworkFeeUsdc: .001, priorityFeeUsdc: .0001, ataRentUsdc: .3 }, .0001, 10).additionalCostUsdc).toBe('0.3011');
    expect(breakEvenDiagnostic(1, .05, { baseNetworkFeeUsdc: .001, priorityFeeUsdc: .0001 }, .0001, 10)).toMatchObject({ executionEligible: false, costDataComplete: false, ataRentUsdc: null, requiredMinimumQuotedOutputUsdc: '1.0021' });
    expect(existing.providerFees).toBe('ALREADY_EMBEDDED_IN_QUOTED_OUTPUT');
  });
  it('retains bounded exploration for every size without increasing cap', () => {
    const cadence = new LiveSizeCadence(); const sizes = [.05, .1, .25, .5, 1];
    const selected = Array.from({ length: 160 }, () => cadence.next(sizes, .05, (size) => size === 1 ? 1 : 0)!);
    expect(selected.filter((size) => size <= .05)).toHaveLength(120);
    for (const size of sizes) expect(selected).toContain(size);
  });
  it('bounds advisory metadata, expires it monotonically, and never exposes cached payloads', () => {
    let now = 0; const cache = new BoundedAdvisoryCache<string, string>('TEST_RPC', 100, 2, () => now);
    cache.set('a', 'private-test-value'); cache.set('b', 'b'); cache.set('c', 'c');
    expect(cache.has('a')).toBe(false); expect(cache.size).toBe(2);
    expect(JSON.stringify(cache.snapshot())).not.toContain('private-test-value');
    now = 101; expect(cache.get('b')).toBeUndefined(); expect(cache.snapshot().entries).toBe(0);
  });
  it('reconciles exactly once and reports duplicate and missing outcomes instead of hiding them', () => {
    let now = 100; const ledger = new RawPrefilterLedger(() => now);
    const trace = { rawPositiveDetectedAt: now, rawQuoteEvidenceAt: now, rawQuoteAgeAtDetectionMs: 0, executablePrefilterQueuedAt: now };
    for (const id of ['a', 'b', 'c']) ledger.register(id, trace);
    ledger.finish('a', 'ABOVE_LIVE_CAP'); ledger.finish('a', 'EXECUTABLE_CANDIDATE'); ledger.finish('b', 'ECONOMICS_DIVERGED');
    expect(ledger.snapshot()).toMatchObject({ rawPositive: 3, terminalCount: 2, unreconciled: 1, duplicateTerminalCount: 1 });
    now += 16000;
    expect(ledger.snapshot()).toMatchObject({ rawPositive: 3, terminalCount: 3, unreconciled: 0, missingTerminalCount: 1, buckets: { ABOVE_LIVE_CAP: 1, ECONOMICS_DIVERGED: 1, QUOTE_FAILED: 1 }, sourceResults: { MISSING_OUTCOME_INVARIANT_VIOLATION: 1 } });
  });
  it('measures adjacent stage duration using monotonic evidence, not wall-clock jumps', () => {
    const funnel = new ExecutionFunnel(() => 5000);
    funnel.record({ identity: 'TEST', stage: 'P0_HANDOFF', at: 4000, detectedAt: 4000, monotonicAt: 100 });
    funnel.record({ identity: 'TEST', stage: 'EXECUTOR_RECEIVED', at: 3000, detectedAt: 4000, monotonicAt: 112 });
    expect(funnel.snapshot().adjacentStageLatency['P0_HANDOFF->EXECUTOR_RECEIVED']).toMatchObject({ count: 1, p50: 12 });
  });
});

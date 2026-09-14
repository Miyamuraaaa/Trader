import { describe, expect, it } from 'vitest';
import { ExecutionFunnel } from '../src/execution/execution-funnel.js';
import { scannerDisplayEligibility } from '../src/execution/scanner-display-eligibility.js';
import { calculateLiveExecutionDashboard } from '../src/execution/live-dashboard.js';
describe('TEST DATA: execution funnel semantics', () => {
  it('counts distinct stages, deduplicates repeated READY, and rolls 5m/15m independently', () => {
    let now = 1_000_000; const funnel = new ExecutionFunnel(() => now);
    const record = (stage: string) => funnel.record({ identity: 'TEST', stage, at: now, detectedAt: now });
    record('RAW_POSITIVE'); record('EXECUTABLE_CANDIDATE'); record('P0_HANDOFF'); record('EXECUTOR_RECEIVED');
    expect(funnel.snapshot().last15m.READY_TO_EXECUTE).toBeUndefined();
    record('READY_TO_EXECUTE'); record('READY_TO_EXECUTE');
    expect(funnel.snapshot().session.READY_TO_EXECUTE).toBe(1);
    expect(funnel.snapshot().session.CONFIRMED).toBeUndefined();
    now += 300_001; expect(funnel.snapshot().last5m).toEqual({}); expect(funnel.snapshot().last15m.RAW_POSITIVE).toBe(1);
    now += 900_001; expect(funnel.snapshot().last15m).toEqual({}); expect(funnel.snapshot().session.RAW_POSITIVE).toBe(1);
  });
  it('explains zero READY using actual elimination counts', () => {
    const funnel = new ExecutionFunnel(() => 1000);
    expect(funnel.snapshot().explanation).toContain('0 completed broad positives');
    for (const stage of ['RAW_POSITIVE', 'ECONOMICS_DIVERGED', 'EXECUTION_ROUTE_CHANGED']) funnel.record({ identity: 'TEST', stage, at: 1000, detectedAt: 1000 });
    expect(funnel.snapshot().explanation).toContain('1 completed broad positives');
    expect(funnel.snapshot().explanation).toContain('0 executable-surface attempts');
    expect(funnel.snapshot().last15m.EXECUTION_ROUTE_CHANGED).toBe(1);
  });
  it('derives executor stage percentiles only from matching evidence', () => {
    const funnel = new ExecutionFunnel(() => 1000);
    expect(funnel.snapshot().timings.simulation?.p90Ms).toBeNull();
    for (const [stage, at] of [['P0_HANDOFF', 100], ['EXECUTOR_RECEIVED', 110], ['SIMULATION_START', 200], ['SIMULATION_END', 300], ['READY_TO_EXECUTE', 350]] as const) funnel.record({ identity: 'TEST', stage, at, detectedAt: 90 });
    expect(funnel.snapshot().timings.p0ToExecutor?.p90Ms).toBe(10);
    expect(funnel.snapshot().timings.simulation?.p90Ms).toBe(100);
    expect(funnel.snapshot().timings.candidateToReady?.p50Ms).toBe(260);
  });
  it('READY and user-approved remain distinct from confirmed trades', () => {
    const value = calculateLiveExecutionDashboard([
      { id: 'ready', state: 'APPROVED_FOR_SUBMISSION', createdAt: 1, updatedAt: 1 },
      { id: 'approved', state: 'APPROVED_BY_USER', createdAt: 2, updatedAt: 2 },
    ]);
    expect(value.stats.completedTrades).toBe(0); expect(value.stats.rejectedTrades).toBe(0);
    expect(value.trades.map((t) => t.status)).toEqual(['APPROVED_BY_USER', 'READY_TO_EXECUTE']);
  });
  it('labels above-cap, unsupported, Token-2022 and raw-only observations non-executable', () => {
    const row = { trade_size_usdc: '.1', expected_profit_usdc: '.01', buy_provider: 'raptor', sell_provider: 'jupiter', opportunity_state: 'EXECUTABLE_CANDIDATE', stale: 0 };
    expect(scannerDisplayEligibility(row, .05)).toBe('ABOVE_LIVE_CAP');
    expect(scannerDisplayEligibility({ ...row, trade_size_usdc: '.05' }, .05)).toBe('EXECUTION_ELIGIBLE');
    expect(scannerDisplayEligibility({ ...row, opportunity_state: 'DISCOVERY_ONLY_TOKEN_2022' }, 1)).toBe('TOKEN_2022_DISCOVERY_ONLY');
    expect(scannerDisplayEligibility({ ...row, sell_provider: 'meteora' }, 1)).toBe('UNSUPPORTED_PROVIDER_PAIR');
    expect(scannerDisplayEligibility({ ...row, opportunity_state: 'RAW_MARKET_OPPORTUNITY' }, 1)).toBe('RAW_ONLY');
  });
});

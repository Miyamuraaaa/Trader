import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistentRiskManager, confirmedRiskPnl } from '../src/execution/risk-manager.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trader-risk-test-')); dirs.push(dir);
  let now = Date.UTC(2026, 8, 7, 23, 59);
  const file = path.join(dir, 'risk.json');
  const limits = { maxTrades: 100, maxConsecutiveFailures: 5, maxSessionLossAtomic: 1000n, maxDailyLossAtomic: 20n, maxSingleTradeLossAtomic: 15n };
  const create = () => new PersistentRiskManager(limits, file, () => now);
  const risk = create(); await risk.load();
  return { risk, create, file, nextDay: () => { now += 120_000; } };
}

describe('TEST DATA: persistent execution risk', () => {
  it('persists daily loss, session identity and duplicate protection through restart', async () => {
    const f = await fixture();
    await f.risk.recordConfirmed('one', -10n, false); await f.risk.recordConfirmed('two', -10n, false);
    const resumed = f.create(); await resumed.load();
    expect(resumed.snapshot().sessionId).toBe(f.risk.snapshot().sessionId);
    expect(resumed.snapshot().tradeCount).toBe(2);
    expect(() => resumed.assertCanExecute('new')).toThrow('MAX_DAILY_LOSS');
    expect(() => resumed.assertCanExecute('one')).toThrow('Duplicate');
  });
  it('rolls daily buckets at UTC midnight but not session or duplicates', async () => {
    const f = await fixture(); await f.risk.recordConfirmed('one', -10n, true);
    f.nextDay(); await f.risk.recordConfirmed('two', -3n, true);
    expect(f.risk.snapshot()).toMatchObject({ dateKeyUTC: '2026-09-08', dailyPnlAtomic: '-3', realizedPnlAtomic: '-13', tradeCount: 2 });
  });
  it('explicit new session preserves daily loss and blocks unresolved submission rotation', async () => {
    const f = await fixture(); await f.risk.recordSubmissionAttempt('pending');
    await expect(f.risk.beginReviewedSession('START_NEW_REVIEWED_SESSION')).rejects.toThrow('unresolved');
    await f.risk.recordConfirmed('pending', -10n, false);
    const previous = f.risk.snapshot().sessionId;
    await f.risk.beginReviewedSession('START_NEW_REVIEWED_SESSION');
    expect(f.risk.snapshot()).toMatchObject({ tradeCount: 0, dailyPnlAtomic: '-10' });
    expect(f.risk.snapshot().sessionId).not.toBe(previous);
    expect(() => f.risk.assertCanExecute('pending')).toThrow('Duplicate');
  });
  it('latches oversized realized single-trade loss and enforces modeled loss', async () => {
    const f = await fixture(); expect(() => f.risk.assertCanExecute('new', -16n)).toThrow('MAX_SINGLE_TRADE');
    await f.risk.recordConfirmed('one', -16n, false);
    const resumed = f.create(); await resumed.load();
    expect(() => resumed.assertCanExecute('new')).toThrow('MAX_SINGLE_TRADE');
    await expect(resumed.beginReviewedSession('START_NEW_REVIEWED_SESSION')).rejects.toThrow();
  });
  it('charges actual failed on-chain fees, rounds up and does not double charge reconciliation', async () => {
    const f = await fixture(); const pnl = confirmedRiskPnl(0n, 5_000n, 2_000_000n);
    expect(pnl).toBe(-10n); expect(confirmedRiskPnl(0n, 1n, 250_000_000n)).toBe(-1n);
    await f.risk.recordConfirmed('failed', pnl, true);
    const resumed = f.create(); await resumed.load(); await resumed.recordConfirmed('failed', pnl, true);
    expect(resumed.snapshot()).toMatchObject({ tradeCount: 1, failedTransactions: 1, dailyPnlAtomic: '-10', failedTransactionCostAtomic: '10' });
    await expect(resumed.recordConfirmed('failed', -11n, true)).rejects.toThrow('Conflicting');
  });
  it('local failure never fabricates fee loss; submission alone has no realized PnL', async () => {
    const f = await fixture(); await f.risk.recordFailure(); await f.risk.recordSubmissionAttempt('ambiguous');
    expect(f.risk.snapshot()).toMatchObject({ realizedPnlAtomic: '0', dailyPnlAtomic: '0', settled: {} });
  });
  it('legacy migration preserves every duplicate/counter but halts unknown daily history', async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify({ executedIds: ['old'], tradeCount: 1, failedTransactions: 0, consecutiveFailures: 0, realizedPnlAtomic: '-5' }));
    const resumed = f.create(); await resumed.load();
    expect(resumed.snapshot()).toMatchObject({ executedIds: ['old'], tradeCount: 1, realizedPnlAtomic: '-5' });
    expect(() => resumed.assertCanExecute('new')).toThrow('LEGACY_RISK_STATE');
  });
  it('hard-caps session settings at 100 and persists the configured trade cap', async () => {
    expect(() => new PersistentRiskManager({ maxTrades: 101, maxConsecutiveFailures: 1, maxSessionLossAtomic: 1n })).toThrow('1..100');
    const f = await fixture();
    const limited = new PersistentRiskManager({ maxTrades: 1, maxConsecutiveFailures: 1, maxSessionLossAtomic: 100n }, f.file);
    await limited.load(); await limited.recordSubmissionAttempt('one');
    expect(() => limited.assertCanExecute('two')).toThrow('MAX_TRADES_PER_SESSION');
  });
});

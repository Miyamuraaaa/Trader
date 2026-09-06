import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DisabledPaperExecutionEngine } from '../src/engine.js';
import { calculateLiveExecutionDashboard, mergeLiveDecisionJournal } from '../src/execution/live-dashboard.js';
import type { ExecutionRecord } from '../src/execution/execution-journal.js';

describe('live and dry-run paper-ledger isolation', () => {
  it('uses an inert engine that cannot confirm or mutate paper trades', async () => {
    const engine = new DisabledPaperExecutionEngine();
    expect(engine.getStartingBalance()).toBe(0);
    expect(engine.getBalance()).toBe(0);
    expect(engine.getPnl()).toBe(0);
    engine.reset();
    await expect(engine.confirmQuote({} as never)).rejects.toThrow('Paper execution is disabled');
  });

  it('keeps the live wallet, route evaluations, and real execution metrics visible', async () => {
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/<div>\s*<div[^>]*>Live Wallet Balance<\/div>/);
    expect(html).not.toMatch(/id="paper-balance-panel"[^>]*>\s*<div[^>]*>Live Wallet Balance/);
    expect(html).toMatch(/<!-- Opportunities Table -->\s*<div class="glass-panel/);
    expect(html).toMatch(/<!-- Quote confirmation table -->\s*<div id="execution-trades-panel"/);
    expect(html).toContain("['reset-paper-button', 'paper-balance-panel']");
  });

  it('derives win rate inputs and P&L only from confirmed on-chain accounting', () => {
    const record = (id: string, pnl: string, inputAmount: string): ExecutionRecord => ({
      id, state: 'CONFIRMED', createdAt: 1, updatedAt: Number(id), inputAmount,
      accounting: {
        actualFeeLamports: '5000', usdcBefore: '1000000', usdcAfter: '1000000',
        usdcDelta: pnl, solBeforeLamports: '10000', solAfterLamports: '5000',
        intermediateBefore: '0', intermediateAfter: '0', intermediateDust: '0',
      },
    });
    const dashboard = calculateLiveExecutionDashboard([
      record('1', '2000', '50000'), record('2', '-500', '50000'),
      { id: '3', state: 'REJECTED', createdAt: 3, updatedAt: 3, reason: 'unprofitable' },
    ]);
    expect(dashboard.stats).toMatchObject({
      completedTrades: 2, winCount: 1, lossCount: 1, rejectedTrades: 1,
      totalPnl: 0.0015, totalVolume: 0.1,
    });
    expect(dashboard.stats.expectancy).toBeCloseTo(0.00075);
    expect(dashboard.stats.profitFactor).toBeCloseTo(4);
  });

  it('shows scanner candidates and rejections without treating projected profit as realized P&L', () => {
    const decisions = [
      {
        id: 'candidate', timestamp: new Date(10).toISOString(), trade_size_usdc: '0.05',
        expected_profit_usdc: '0.001', worst_case_profit_usdc: '0.0005',
        category: 'HIGH_SPREAD', validation_tier: 'CONSERVATIVE_CANDIDATE',
        opportunity_state: 'LIVE_QUOTED',
        path: JSON.stringify(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'dynamicMint', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']),
        stale: 0, liquidity_overlap: 0, buy_provider: 'raptor', sell_provider: 'orca',
      },
      {
        id: 'rejected', timestamp: new Date(20).toISOString(), trade_size_usdc: '0.05',
        expected_profit_usdc: '-0.001', worst_case_profit_usdc: '-0.0012',
        category: 'NEGATIVE', validation_tier: 'OBSERVATION',
        opportunity_state: 'BELOW_THRESHOLD',
        path: JSON.stringify(['base', 'middle', 'base']), stale: 0, liquidity_overlap: 0,
        buy_provider: 'raydium', sell_provider: 'orca',
      },
    ];
    const merged = mergeLiveDecisionJournal([], decisions);
    expect(merged.map((trade) => trade.status)).toEqual(['REJECTED', 'REJECTED']);
    expect(merged.every((trade) => trade.realizedPnlUsdc === null)).toBe(true);
    expect(merged[1]!.reason).toContain('expected +0.001000');
    expect(merged[1]!.reason).toContain('NO AUDITED ATOMIC EXECUTOR');
  });

  it('does not present an expired positive discovery quote as executable', () => {
    const decisions = [{
      id: 'expired', timestamp: new Date(20).toISOString(), trade_size_usdc: '0.05',
      expected_profit_usdc: '0.008638', worst_case_profit_usdc: '0.008609',
      category: 'HIGH_SPREAD', validation_tier: 'CONSERVATIVE_CANDIDATE', opportunity_state: 'EXPIRED',
      path: JSON.stringify([
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ]),
      stale: 0, liquidity_overlap: 0, buy_provider: 'raptor', sell_provider: 'jupiter',
    }];
    const [trade] = mergeLiveDecisionJournal([], decisions);
    expect(trade?.status).toBe('REJECTED');
    expect(trade?.reason).toContain('QUOTE EXPIRED');
    expect(trade?.reason).toContain('9cRCn9…');
  });

  it('counts visible scanner lifecycle expirations in the live expiration KPI', () => {
    const execution = calculateLiveExecutionDashboard([]);
    const scanner = [{
      id: 'expired', timestamp: new Date(20).toISOString(), trade_size_usdc: '0.5',
      expected_profit_usdc: '0.0073', worst_case_profit_usdc: '0.0070',
      category: 'HIGH_SPREAD', validation_tier: 'CONSERVATIVE_CANDIDATE',
      opportunity_state: 'EXPIRED', path: JSON.stringify(['base', 'middle', 'base']),
      stale: 0, liquidity_overlap: 0, buy_provider: 'raptor', sell_provider: 'jupiter',
    }];
    execution.trades = mergeLiveDecisionJournal(execution.trades, scanner);
    execution.stats.expiredTrades += scanner.filter((row) =>
      row.opportunity_state === 'EXPIRED' || row.stale === 1).length;
    expect(execution.stats.expiredTrades).toBe(1);
  });

  it('preserves real executor records when scanner observations fill the journal limit', () => {
    const execution: import('../src/execution/live-dashboard.js').LiveExecutionDashboardTrade = {
      id: 'executor-rejection', timestamp: new Date(1).toISOString(), status: 'REJECTED',
      inputUsdc: 0.5, realizedPnlUsdc: null, reason: 'independent revalidation failed', signature: null,
    };
    const scanner = Array.from({ length: 100 }, (_, index) => ({
      id: `scanner-${index}`, timestamp: new Date(1000 + index).toISOString(), trade_size_usdc: '0.05',
      expected_profit_usdc: '-0.001', worst_case_profit_usdc: '-0.0011',
      category: 'NEGATIVE', validation_tier: 'OBSERVATION', opportunity_state: 'BELOW_THRESHOLD',
      path: JSON.stringify(['base', 'middle', 'base']), stale: 0, liquidity_overlap: 0,
      buy_provider: 'jupiter', sell_provider: 'raptor',
    }));
    const merged = mergeLiveDecisionJournal([execution], scanner, 100);
    expect(merged).toHaveLength(100);
    expect(merged.some((row) => row.id === execution.id)).toBe(true);
    expect(merged.filter((row) => row.id.startsWith('scanner:'))).toHaveLength(99);
  });
});

import { DECIMALS } from '../config.js';
import { getRecentLiveScannerDecisions, type LiveScannerDecisionRow } from '../db.js';
import { fromAtomic } from '../math.js';
import { PersistentExecutionJournal, type ExecutionRecord, type ExecutionState } from './execution-journal.js';

const FAILURE_STATES = new Set<ExecutionState>([
  'SIMULATION_FAILED', 'SUBMISSION_FAILED', 'TRANSACTION_FAILED', 'ACCOUNTING_FAILED',
]);

export interface LiveExecutionDashboardTrade {
  id: string;
  timestamp: string;
  /** Final execution decision for the dashboard; detailed state stays in reason. */
  status: 'ACCEPTED' | 'REJECTED';
  inputUsdc: number;
  realizedPnlUsdc: number | null;
  reason: string | null;
  signature: string | null;
}

function scannerDecisionTrade(row: LiveScannerDecisionRow): LiveExecutionDashboardTrade {
  const state = row.opportunity_state;
  const expected = Number(row.expected_profit_usdc);
  const worst = Number(row.worst_case_profit_usdc);
  let path: string[] = [];
  try {
    const parsed = JSON.parse(row.path) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) path = parsed;
  } catch { /* malformed historical rows remain displayable and fail closed */ }
  const isPositiveCandidate = row.validation_tier !== 'OBSERVATION' && expected > 0 && worst > 0;
  const isExpired = state === 'EXPIRED' || row.stale === 1;
  // Scanner output has no execution authority. It is rejected from the real
  // execution journal unless/until an independent executor creates its own
  // APPROVED_FOR_SUBMISSION record. There is deliberately no third
  // "discovery-only" execution decision.
  const status = 'REJECTED' as const;
  const route = `${row.buy_provider ?? 'unknown'} → ${row.sell_provider ?? 'unknown'}`;
  const format = (value: number) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(6)}` : 'unavailable';
  let eligibility: string;
  if (isExpired) eligibility = 'NOT EXECUTABLE: QUOTE EXPIRED';
  else if (state === 'DISCOVERY_ONLY_TOKEN_2022') eligibility = 'DISCOVERY ONLY: TOKEN-2022 EXECUTION IS UNSUPPORTED';
  else if (state === 'EXECUTABLE_CANDIDATE') eligibility = 'EXECUTOR-CONSTRAINED P0 CANDIDATE; INDEPENDENT REVALIDATION REQUIRED';
  else if (state === 'RAW_MARKET_OPPORTUNITY') eligibility = 'RAW MARKET OPPORTUNITY: NOT SENT TO LIVE EXECUTOR';
  else if (!isPositiveCandidate) eligibility = 'NOT EXECUTABLE: PROFIT/RISK THRESHOLD';
  else eligibility = `DISCOVERY ONLY: NO AUDITED ATOMIC EXECUTOR FOR ${route}`;
  const pathText = path.length === 3 ? `${path[0]!.slice(0, 6)}… → ${path[1]!.slice(0, 6)}… → ${path[2]!.slice(0, 6)}…` : 'path unavailable';
  return {
    id: `scanner:${row.id}`,
    timestamp: row.timestamp,
    status,
    inputUsdc: Number(row.trade_size_usdc) || 0,
    realizedPnlUsdc: null,
    reason: `${route} · ${pathText} · ${state} · ${row.validation_tier} · expected ${format(expected)} · worst ${format(worst)} USDC · ${eligibility}`,
    signature: null,
  };
}

export interface LiveExecutionDashboardStats {
  active: true;
  completedTrades: number;
  winCount: number;
  lossCount: number;
  rejectedTrades: number;
  expiredTrades: number;
  failedTrades: number;
  totalOpps: number;
  totalPnl: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdown: number;
  totalVolume: number;
}

function usdc(raw: string | undefined): number {
  if (!raw) return 0;
  try { return Number(fromAtomic(raw, DECIMALS.USDC)); } catch { return 0; }
}

export function calculateLiveExecutionDashboard(records: readonly ExecutionRecord[]): {
  stats: LiveExecutionDashboardStats;
  trades: LiveExecutionDashboardTrade[];
} {
  const ordered = [...records].sort((a, b) => a.updatedAt - b.updatedAt);
  const confirmed = ordered.filter((record) => record.state === 'CONFIRMED' && record.accounting);
  const realized = confirmed.map((record) => usdc(record.accounting?.usdcDelta));
  const wins = realized.filter((value) => value > 0);
  const losses = realized.filter((value) => value <= 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of realized) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  const totalPnl = realized.reduce((sum, value) => sum + value, 0);
  const completedTrades = confirmed.length;
  const stats: LiveExecutionDashboardStats = {
    active: true,
    completedTrades,
    winCount: wins.length,
    lossCount: losses.length,
    rejectedTrades: ordered.filter((record) => record.state === 'REJECTED').length,
    expiredTrades: ordered.filter((record) => record.state === 'EXPIRED').length,
    failedTrades: ordered.filter((record) => FAILURE_STATES.has(record.state)).length,
    totalOpps: ordered.length,
    totalPnl,
    expectancy: completedTrades > 0 ? totalPnl / completedTrades : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
    maxDrawdown,
    totalVolume: confirmed.reduce((sum, record) => sum + usdc(record.inputAmount), 0),
  };
  const acceptedStates = new Set<ExecutionState>([
    'APPROVED_FOR_SUBMISSION', 'SUBMITTING', 'SUBMITTED', 'CONFIRMING', 'CONFIRMED',
  ]);
  const trades = [...ordered].reverse().slice(0, 100).map((record) => ({
    id: record.id,
    timestamp: new Date(record.updatedAt).toISOString(),
    status: acceptedStates.has(record.state) ? 'ACCEPTED' as const : 'REJECTED' as const,
    inputUsdc: usdc(record.inputAmount),
    realizedPnlUsdc: record.accounting ? usdc(record.accounting.usdcDelta) : null,
    reason: record.reason ? `${record.state}: ${record.reason}` : record.state,
    signature: record.signature ?? null,
  }));
  return { stats, trades };
}

export function mergeLiveDecisionJournal(
  executionTrades: readonly LiveExecutionDashboardTrade[],
  scannerDecisions: readonly LiveScannerDecisionRow[],
  limit = 100,
): LiveExecutionDashboardTrade[] {
  // Scanner decisions arrive far more frequently than executor state changes.
  // Reserve journal capacity for actual executor records so rejected/submitted/
  // confirmed attempts cannot disappear merely because 100 new quotes arrived.
  const executionReserve = Math.min(executionTrades.length, Math.min(25, limit));
  const preservedExecution = executionTrades.slice(0, executionReserve);
  const scannerLimit = Math.max(0, limit - preservedExecution.length);
  return [...preservedExecution, ...scannerDecisions.slice(0, scannerLimit).map(scannerDecisionTrade)]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
}

let cache: { expiresAt: number; value: ReturnType<typeof calculateLiveExecutionDashboard> } | undefined;
let pending: Promise<ReturnType<typeof calculateLiveExecutionDashboard>> | undefined;

export async function getLiveExecutionDashboard(): Promise<ReturnType<typeof calculateLiveExecutionDashboard>> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  if (!pending) {
    pending = (async () => {
      const journal = new PersistentExecutionJournal();
      await journal.load();
      const value = calculateLiveExecutionDashboard(journal.all());
      const scannerDecisions = getRecentLiveScannerDecisions(100);
      value.trades = mergeLiveDecisionJournal(value.trades, scannerDecisions);
      value.stats.totalOpps = journal.all().length + scannerDecisions.length;
      // The route table includes scanner lifecycle expirations as well as
      // executor records. Reflect those same visible expirations in the KPI;
      // otherwise the table can say EXPIRED while its summary remains zero.
      value.stats.expiredTrades += scannerDecisions.filter((row) =>
        row.opportunity_state === 'EXPIRED' || row.stale === 1).length;
      cache = { expiresAt: Date.now() + 1_000, value };
      return value;
    })().finally(() => { pending = undefined; });
  }
  return pending;
}

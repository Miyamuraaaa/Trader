import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { CONFIG, DECIMALS, MINTS } from './config.js';
import { fromAtomic } from './math.js';

// Ensure data directory exists
try {
  mkdirSync('data', { recursive: true });
} catch (_e) { /* ignore */ }

const dbPath = join(process.cwd(), 'data', 'terminal.db');
export const db = new Database(dbPath);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// ---------------------------------------------------------------------------
// Schema (§16–§17)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    trade_size_usdc TEXT NOT NULL,
    scan_mode TEXT NOT NULL,
    reference_price TEXT NOT NULL,
    calc_version TEXT NOT NULL DEFAULT 'v1'
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL,
    leg TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'jupiter',
    input_mint TEXT NOT NULL,
    output_mint TEXT NOT NULL,
    in_amount TEXT NOT NULL,
    out_amount TEXT NOT NULL,
    other_amount_threshold TEXT NOT NULL,
    price_impact_pct TEXT NOT NULL,
    slippage_bps INTEGER NOT NULL,
    platform_fee_amount TEXT,
    platform_fee_bps REAL,
    route_labels TEXT NOT NULL DEFAULT '[]',
    raw_response TEXT NOT NULL,
    request_timestamp TEXT NOT NULL,
    response_timestamp TEXT NOT NULL,
    latency_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    label TEXT,
    input_mint TEXT,
    output_mint TEXT,
    in_amount TEXT,
    out_amount TEXT,
    fee_amount TEXT
  );

  CREATE TABLE IF NOT EXISTS opportunities (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    buy_quote_id TEXT NOT NULL,
    sell_quote_id TEXT NOT NULL,
    trade_size_usdc TEXT NOT NULL,
    expected_profit_usdc TEXT NOT NULL,
    estimated_slippage_usdc TEXT NOT NULL DEFAULT '0',
    conservative_profit_usdc TEXT NOT NULL,
    worst_case_profit_usdc TEXT NOT NULL,
    estimated_fees_usdc TEXT NOT NULL,
    confidence_score INTEGER NOT NULL,
    classification TEXT NOT NULL DEFAULT 'AGGREGATOR_ROUTE',
    category TEXT NOT NULL DEFAULT 'POTENTIAL',
    validation_tier TEXT NOT NULL DEFAULT 'OBSERVATION',
    opportunity_state TEXT NOT NULL DEFAULT 'OBSERVATION',
    identity_key TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '[]',
    initial_detected_at TEXT,
    confirmed_at TEXT,
    expired_at TEXT,
    opportunity_lifetime_ms INTEGER,
    quote_age_ms INTEGER,
    calculation_time_ms INTEGER,
    liquidity_overlap INTEGER,
    stale INTEGER NOT NULL DEFAULT 0,
    calc_version TEXT NOT NULL DEFAULT 'v1'
  );

  CREATE TABLE IF NOT EXISTS opportunity_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_id TEXT NOT NULL,
    scan_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    expected_profit_usdc TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS risk_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_id TEXT,
    scan_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    gate TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT
  );

  CREATE TABLE IF NOT EXISTS paper_trades (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    status TEXT NOT NULL,
    rejection_reason TEXT,
    trade_size_usdc TEXT NOT NULL,
    realized_pnl_usdc TEXT,
    fees_paid_usdc TEXT,
    final_buy_quote_id TEXT,
    final_sell_quote_id TEXT,
    confirmed_quote_profit_usdc TEXT,
    confirmation_latency_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS paper_trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    details TEXT
  );

  CREATE TABLE IF NOT EXISTS system_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    component TEXT NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    error_count INTEGER DEFAULT 0,
    rate_limit_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    component TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT
  );

  CREATE TABLE IF NOT EXISTS configuration_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    key TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT NOT NULL
  );

  -- Indexes (§16)
  CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
  CREATE INDEX IF NOT EXISTS idx_quotes_scan_id ON quotes(scan_id);
  CREATE INDEX IF NOT EXISTS idx_opportunities_scan_id ON opportunities(scan_id);
  CREATE INDEX IF NOT EXISTS idx_opportunities_timestamp ON opportunities(timestamp);
  CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
  CREATE INDEX IF NOT EXISTS idx_paper_trades_timestamp ON paper_trades(timestamp);
  CREATE INDEX IF NOT EXISTS idx_paper_trade_events_trade_id ON paper_trade_events(trade_id);
  CREATE INDEX IF NOT EXISTS idx_risk_rejections_scan_id ON risk_rejections(scan_id);
  CREATE INDEX IF NOT EXISTS idx_system_health_component ON system_health(component);
`);

// Forward-only, non-destructive migrations for databases created by older builds.
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('quotes', 'provider', "TEXT NOT NULL DEFAULT 'jupiter'");
ensureColumn('opportunities', 'estimated_slippage_usdc', "TEXT NOT NULL DEFAULT '0'");
ensureColumn('opportunities', 'classification', "TEXT NOT NULL DEFAULT 'AGGREGATOR_ROUTE'");
ensureColumn('opportunities', 'category', "TEXT NOT NULL DEFAULT 'POTENTIAL'");
ensureColumn('opportunities', 'validation_tier', "TEXT NOT NULL DEFAULT 'OBSERVATION'");
ensureColumn('opportunities', 'opportunity_state', "TEXT NOT NULL DEFAULT 'OBSERVATION'");
ensureColumn('opportunities', 'identity_key', "TEXT NOT NULL DEFAULT ''");
ensureColumn('opportunities', 'path', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('opportunities', 'initial_detected_at', 'TEXT');
ensureColumn('opportunities', 'confirmed_at', 'TEXT');
ensureColumn('opportunities', 'expired_at', 'TEXT');
ensureColumn('opportunities', 'opportunity_lifetime_ms', 'INTEGER');
ensureColumn('opportunities', 'quote_age_ms', 'INTEGER');
ensureColumn('opportunities', 'calculation_time_ms', 'INTEGER');
ensureColumn('opportunities', 'liquidity_overlap', 'INTEGER');
ensureColumn('opportunities', 'stale', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('paper_trades', 'confirmed_quote_profit_usdc', 'TEXT');
ensureColumn('paper_trades', 'confirmation_latency_ms', 'INTEGER');

// ---------------------------------------------------------------------------
// Typed insert helpers — NO `any` types (§35)
// ---------------------------------------------------------------------------

export interface ScanRow {
  id: string;
  timestamp: string;
  tradeSizeUsdc: string;
  scanMode: string;
  referencePrice: string;
}

const insertScanStmt = db.prepare(
  'INSERT INTO scans (id, timestamp, trade_size_usdc, scan_mode, reference_price) VALUES (?, ?, ?, ?, ?)'
);

export function insertScan(s: ScanRow): void {
  insertScanStmt.run(s.id, s.timestamp, s.tradeSizeUsdc, s.scanMode, s.referencePrice);
}

export interface QuoteRow {
  id: string;
  scanId: string;
  leg: string;
  provider: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  platformFeeAmount: string | null;
  platformFeeBps: number | null;
  routeLabels: string;
  rawResponse: string;
  requestTimestamp: string;
  responseTimestamp: string;
  latencyMs: number;
}

const insertQuoteStmt = db.prepare(`
  INSERT INTO quotes (
    id, scan_id, leg, provider, input_mint, output_mint, in_amount, out_amount,
    other_amount_threshold, price_impact_pct, slippage_bps,
    platform_fee_amount, platform_fee_bps, route_labels,
    raw_response, request_timestamp, response_timestamp, latency_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertQuote(q: QuoteRow): void {
  insertQuoteStmt.run(
    q.id, q.scanId, q.leg, q.provider, q.inputMint, q.outputMint,
    q.inAmount, q.outAmount, q.otherAmountThreshold, q.priceImpactPct,
    q.slippageBps, q.platformFeeAmount, q.platformFeeBps, q.routeLabels,
    q.rawResponse, q.requestTimestamp, q.responseTimestamp, q.latencyMs
  );
}

export interface OpportunityRow {
  id: string;
  scanId: string;
  timestamp: string;
  buyQuoteId: string;
  sellQuoteId: string;
  tradeSizeUsdc: string;
  expectedProfitUsdc: string;
  estimatedSlippageUsdc: string;
  conservativeProfitUsdc: string;
  worstCaseProfitUsdc: string;
  estimatedFeesUsdc: string;
  confidenceScore: number;
  classification: string;
  category: string;
  validationTier: string;
  opportunityState: string;
  identityKey: string;
  path: string;
  initialDetectedAt: string | null;
  confirmedAt: string | null;
  expiredAt: string | null;
  opportunityLifetimeMs: number | null;
  quoteAgeMs: number;
  calculationTimeMs: number;
  liquidityOverlap: boolean | null;
  stale: boolean;
}

const insertOppStmt = db.prepare(`
  INSERT INTO opportunities (
    id, scan_id, timestamp, buy_quote_id, sell_quote_id, trade_size_usdc,
    expected_profit_usdc, estimated_slippage_usdc, conservative_profit_usdc, worst_case_profit_usdc,
    estimated_fees_usdc, confidence_score, classification, category, validation_tier,
    opportunity_state, identity_key, path, initial_detected_at, confirmed_at, expired_at,
    opportunity_lifetime_ms, quote_age_ms, calculation_time_ms, liquidity_overlap, stale
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertOpportunity(o: OpportunityRow): void {
  insertOppStmt.run(
    o.id, o.scanId, o.timestamp, o.buyQuoteId, o.sellQuoteId,
    o.tradeSizeUsdc, o.expectedProfitUsdc, o.estimatedSlippageUsdc, o.conservativeProfitUsdc,
    o.worstCaseProfitUsdc, o.estimatedFeesUsdc, o.confidenceScore,
    o.classification, o.category, o.validationTier,
    o.opportunityState, o.identityKey, o.path, o.initialDetectedAt, o.confirmedAt,
    o.expiredAt, o.opportunityLifetimeMs, o.quoteAgeMs, o.calculationTimeMs,
    o.liquidityOverlap === null ? null : o.liquidityOverlap ? 1 : 0,
    o.stale ? 1 : 0
  );
}

export interface RiskRejectionRow {
  opportunityId: string | null;
  scanId: string;
  timestamp: string;
  gate: string;
  reason: string;
  details: string | null;
}

const insertRejStmt = db.prepare(
  'INSERT INTO risk_rejections (opportunity_id, scan_id, timestamp, gate, reason, details) VALUES (?, ?, ?, ?, ?, ?)'
);

export function insertRiskRejection(r: RiskRejectionRow): void {
  insertRejStmt.run(r.opportunityId, r.scanId, r.timestamp, r.gate, r.reason, r.details);
}

const insertPaperTradeStmt = db.prepare(
  'INSERT INTO paper_trades (id, opportunity_id, timestamp, status, trade_size_usdc) VALUES (?, ?, ?, ?, ?)'
);

export function insertPaperTrade(id: string, oppId: string, ts: string, status: string, size: string): void {
  insertPaperTradeStmt.run(id, oppId, ts, status, size);
}

const updatePaperTradeStmt = db.prepare(
  'UPDATE paper_trades SET status = ?, rejection_reason = ?, realized_pnl_usdc = ?, fees_paid_usdc = ?, final_buy_quote_id = ?, final_sell_quote_id = ? WHERE id = ?'
);

export function updatePaperTrade(
  id: string,
  status: string,
  rejectionReason: string | null,
  pnl: string | null,
  fees: string | null,
  buyQuoteId: string | null,
  sellQuoteId: string | null
): void {
  updatePaperTradeStmt.run(status, rejectionReason, pnl, fees, buyQuoteId, sellQuoteId, id);
}

const confirmQuoteStmt = db.prepare(`
  UPDATE paper_trades
  SET status = 'CONFIRMED_QUOTE', rejection_reason = NULL,
      confirmed_quote_profit_usdc = ?, confirmation_latency_ms = ?,
      final_buy_quote_id = ?, final_sell_quote_id = ?
  WHERE id = ?
`);

export function confirmPaperQuote(
  id: string,
  quotedProfitUsdc: string,
  confirmationLatencyMs: number,
  buyQuoteId: string,
  sellQuoteId: string,
): void {
  confirmQuoteStmt.run(quotedProfitUsdc, confirmationLatencyMs, buyQuoteId, sellQuoteId, id);
}

const updateOpportunityStateStmt = db.prepare(`
  UPDATE opportunities
  SET opportunity_state = ?, confirmed_at = ?, expired_at = ?, opportunity_lifetime_ms = ?
  WHERE id = ?
`);

export function updateOpportunityState(
  id: string,
  state: string,
  confirmedAt: string | null,
  expiredAt: string | null,
  lifetimeMs: number | null,
): void {
  updateOpportunityStateStmt.run(state, confirmedAt, expiredAt, lifetimeMs, id);
}

const expireOpportunitiesByIdentityStmt = db.prepare(`
  UPDATE opportunities
  SET opportunity_state = 'EXPIRED', expired_at = ?, opportunity_lifetime_ms = ?
  WHERE identity_key = ?
    AND opportunity_state IN (
      'CANDIDATE', 'LIVE_QUOTED', 'CONFIRMED_QUOTE',
      'RAW_MARKET_OPPORTUNITY', 'EXECUTABLE_CANDIDATE', 'DISCOVERY_ONLY_TOKEN_2022'
    )
`);

export function expireOpportunitiesByIdentity(
  identityKey: string,
  expiredAt: string,
  lifetimeMs: number | null,
): void {
  expireOpportunitiesByIdentityStmt.run(expiredAt, lifetimeMs, identityKey);
}

const insertTradeEventStmt = db.prepare(
  'INSERT INTO paper_trade_events (trade_id, timestamp, from_status, to_status, details) VALUES (?, ?, ?, ?, ?)'
);

export function insertTradeEvent(tradeId: string, ts: string, from: string | null, to: string, details: string | null): void {
  insertTradeEventStmt.run(tradeId, ts, from, to, details);
}

const insertHealthStmt = db.prepare(
  'INSERT INTO system_health (timestamp, component, status, latency_ms, error_count, rate_limit_count) VALUES (?, ?, ?, ?, ?, ?)'
);

export function insertHealth(ts: string, component: string, status: string, latencyMs: number | null, errors: number, rateLimits: number): void {
  insertHealthStmt.run(ts, component, status, latencyMs, errors, rateLimits);
}

const insertErrorStmt = db.prepare(
  'INSERT INTO errors (timestamp, component, message, stack) VALUES (?, ?, ?, ?)'
);

export function insertError(ts: string, component: string, message: string, stack: string | null): void {
  insertErrorStmt.run(ts, component, message, stack);
}

// ---------------------------------------------------------------------------
// Query helpers for API
// ---------------------------------------------------------------------------

export interface PaperTradeStats {
  totalOpps: number;
  confirmedQuotes: number;
  projectedQuoteProfit: number;
  completedTrades: number;
  rejectedTrades: number;
  expiredTrades: number;
  failedTrades: number;
  totalPnl: number;
  winCount: number;
  lossCount: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  startingBalance: number;
  currentBalance: number;
  allocatedBalance: number;
  totalVolume: number;
  largestWin: number;
  largestLoss: number;
  dailyLoss: number;
}

export function getPaperTradeStats(): PaperTradeStats {
  const totalOpps = (db.prepare('SELECT COUNT(*) as c FROM opportunities').get() as { c: number }).c;
  const confirmedQuotes = (db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status = 'CONFIRMED_QUOTE'").get() as { c: number }).c;
  const projectedQuoteRow = db.prepare("SELECT COALESCE(SUM(CAST(confirmed_quote_profit_usdc AS REAL)), 0) as s FROM paper_trades WHERE status = 'CONFIRMED_QUOTE'").get() as { s: number };
  const completed = (db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status = 'COMPLETED' AND realized_pnl_usdc IS NOT NULL").get() as { c: number }).c;
  const rejected = (db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status = 'RISK_REJECTED'").get() as { c: number }).c;
  const expired = (db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status = 'EXPIRED'").get() as { c: number }).c;
  const failed = (db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status = 'FAILED'").get() as { c: number }).c;
  
  const pnlRow = db.prepare("SELECT COALESCE(SUM(CAST(realized_pnl_usdc AS REAL)), 0) as s FROM paper_trades WHERE status = 'COMPLETED' AND realized_pnl_usdc IS NOT NULL").get() as { s: number };
  const wins = (db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status = 'COMPLETED' AND CAST(realized_pnl_usdc AS REAL) > 0").get() as { c: number }).c;
  const losses = (db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status = 'COMPLETED' AND CAST(realized_pnl_usdc AS REAL) <= 0").get() as { c: number }).c;
  
  const sumWinsRow = db.prepare("SELECT COALESCE(SUM(CAST(realized_pnl_usdc AS REAL)), 0) as s FROM paper_trades WHERE status = 'COMPLETED' AND CAST(realized_pnl_usdc AS REAL) > 0").get() as { s: number };
  const sumLossesRow = db.prepare("SELECT COALESCE(SUM(CAST(realized_pnl_usdc AS REAL)), 0) as s FROM paper_trades WHERE status = 'COMPLETED' AND CAST(realized_pnl_usdc AS REAL) <= 0").get() as { s: number };
  
  const sumWins = sumWinsRow.s;
  const sumLosses = Math.abs(sumLossesRow.s);
  
  const avgWin = wins > 0 ? sumWins / wins : 0;
  const avgLoss = losses > 0 ? sumLosses / losses : 0;
  
  const winRate = completed > 0 ? wins / completed : 0;
  const lossRate = 1 - winRate;
  
  const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? 999 : 0);

  // Calculate Max Drawdown
  const trades = db.prepare("SELECT CAST(realized_pnl_usdc AS REAL) as pnl, CAST(trade_size_usdc AS REAL) as size, timestamp FROM paper_trades WHERE status = 'COMPLETED' AND realized_pnl_usdc IS NOT NULL ORDER BY timestamp ASC").all() as {pnl: number, size: number, timestamp: string}[];
  let maxDrawdown = 0;
  let peak = CONFIG.paperStartingBalanceUsdc;
  let currentBalance = CONFIG.paperStartingBalanceUsdc;
  let totalVolume = 0;
  let largestWin = 0;
  let largestLoss = 0;
  
  // Calculate daily loss (since 00:00 UTC)
  const todayPrefix = new Date().toISOString().split('T')[0] ?? '';
  let dailyLoss = 0;

  for (const t of trades) {
    currentBalance += t.pnl;
    totalVolume += (t.size || 0);
    
    if (t.pnl > largestWin) largestWin = t.pnl;
    if (t.pnl < largestLoss) largestLoss = t.pnl;
    
    if (currentBalance > peak) peak = currentBalance;
    const drawdown = peak - currentBalance;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    
    if (t.timestamp && t.timestamp.startsWith(todayPrefix)) {
      dailyLoss += t.pnl;
    }
  }

  // Active allocated balance for in-flight trades
  const inFlightRow = db.prepare("SELECT COALESCE(SUM(CAST(trade_size_usdc AS REAL)), 0) as s FROM paper_trades WHERE status NOT IN ('COMPLETED', 'CONFIRMED_QUOTE', 'RISK_REJECTED', 'EXPIRED', 'FAILED')").get() as { s: number };
  const allocatedBalance = inFlightRow.s;

  return {
    totalOpps,
    confirmedQuotes,
    projectedQuoteProfit: projectedQuoteRow.s,
    completedTrades: completed,
    rejectedTrades: rejected,
    expiredTrades: expired,
    failedTrades: failed,
    totalPnl: pnlRow.s,
    winCount: wins,
    lossCount: losses,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    maxDrawdown,
    startingBalance: 0, // Injected by server
    currentBalance: 0, // Injected by server
    allocatedBalance,
    totalVolume,
    largestWin,
    largestLoss,
    dailyLoss: dailyLoss < 0 ? Math.abs(dailyLoss) : 0
  };
}

export function getRecentScans(limit: number = 50) {
  return db.prepare('SELECT * FROM scans ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function getRecentOpportunities(limit: number = 50) {
  return db.prepare(`
    SELECT
      o.*,
      buy.provider AS buy_provider,
      sell.provider AS sell_provider,
      pt.status AS decision_status,
      pt.rejection_reason
    FROM opportunities o
    LEFT JOIN quotes buy ON buy.id = o.buy_quote_id
    LEFT JOIN quotes sell ON sell.id = o.sell_quote_id
    LEFT JOIN paper_trades pt ON pt.opportunity_id = o.id
    ORDER BY o.timestamp DESC
    LIMIT ?
  `).all(limit);
}

export interface LiveScannerDecisionRow {
  id: string;
  timestamp: string;
  trade_size_usdc: string;
  expected_profit_usdc: string;
  worst_case_profit_usdc: string;
  category: string;
  validation_tier: string;
  opportunity_state: string;
  path: string;
  stale: number;
  liquidity_overlap: number | null;
  buy_provider: string | null;
  sell_provider: string | null;
}

/**
 * Read-only scanner decisions for the live decision journal. These are never
 * execution records and must never contribute to realized P&L or win rate.
 */
export function getRecentLiveScannerDecisions(limit: number = 100): LiveScannerDecisionRow[] {
  return db.prepare(`
    SELECT
      o.id, o.timestamp, o.trade_size_usdc, o.expected_profit_usdc,
      o.worst_case_profit_usdc, o.category, o.validation_tier,
      o.opportunity_state, o.path, o.stale, o.liquidity_overlap,
      buy.provider AS buy_provider,
      sell.provider AS sell_provider
    FROM opportunities o
    LEFT JOIN quotes buy ON buy.id = o.buy_quote_id
    LEFT JOIN quotes sell ON sell.id = o.sell_quote_id
    ORDER BY o.timestamp DESC
    LIMIT ?
  `).all(limit) as LiveScannerDecisionRow[];
}

export function getRecentTrades(limit: number = 50) {
  return db.prepare('SELECT * FROM paper_trades ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function getRecentRejections(limit: number = 50) {
  return db.prepare('SELECT * FROM risk_rejections ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function getTradeEvents(tradeId: string) {
  return db.prepare('SELECT * FROM paper_trade_events WHERE trade_id = ? ORDER BY timestamp ASC').all(tradeId);
}

export function getOpportunityDetail(oppId: string) {
  return db.prepare('SELECT * FROM opportunities WHERE id = ?').get(oppId);
}

export function getQuotesForScan(scanId: string) {
  return db.prepare('SELECT * FROM quotes WHERE scan_id = ? ORDER BY leg ASC').all(scanId);
}

export interface ObservedSolUsdPrice {
  /** USDC per SOL, derived only from an already-persisted live quote. */
  priceUsd: number;
  observedAt: number;
  provider: string;
}

/**
 * Reuses the scanner's most recent USDC -> WSOL quote for display only. This
 * function never creates a quote request, so the dashboard cannot add API
 * pressure merely to render a wallet balance.
 */
export function getRecentObservedSolUsdPrice(maxAgeMs: number = 60_000): ObservedSolUsdPrice | null {
  const row = db.prepare(`
    SELECT in_amount, out_amount, response_timestamp, provider
    FROM quotes
    WHERE input_mint = ? AND output_mint = ?
    ORDER BY CAST(response_timestamp AS INTEGER) DESC
    LIMIT 1
  `).get(MINTS.USDC, MINTS.SOL) as {
    in_amount: string;
    out_amount: string;
    response_timestamp: string;
    provider: string;
  } | undefined;
  if (!row) return null;
  const observedAt = Number(row.response_timestamp);
  if (!Number.isSafeInteger(observedAt) || Date.now() - observedAt > maxAgeMs) return null;
  const inputUsdc = fromAtomic(row.in_amount, DECIMALS.USDC);
  const outputSol = fromAtomic(row.out_amount, DECIMALS.SOL);
  if (!outputSol.gt(0) || !inputUsdc.gt(0)) return null;
  const priceUsd = inputUsdc.div(outputSol).toNumber();
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  return { priceUsd, observedAt, provider: row.provider };
}

export function getHealthHistory(component: string, limit: number = 100) {
  return db.prepare('SELECT * FROM system_health WHERE component = ? ORDER BY timestamp DESC LIMIT ?').all(component, limit);
}

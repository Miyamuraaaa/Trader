import 'dotenv/config';
import { parseTokenAllowlist } from './tokens.js';

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function num(name: string, fallback: number, maxLimit?: number): number {
  const raw = process.env[name];
  let n = fallback;
  if (raw !== undefined && raw !== '') {
    n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`Env var ${name} must be a number, got: ${raw}`);
    }
  }
  if (maxLimit !== undefined && n > maxLimit) {
      throw new Error(`Env var ${name} exceeds hard safety limit of ${maxLimit}`);
  }
  return n;
}

function list(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  throw new Error(`Env var ${name} must be true or false, got: ${raw}`);
}

function choice<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const value = str(name, fallback).toLowerCase() as T;
  if (!allowed.includes(value)) {
    throw new Error(`Env var ${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function profitMode(): 'quote' | 'conservative' {
  const value = str('PROFIT_MODE', 'expected').toLowerCase();
  if (value === 'expected' || value === 'quote') return 'quote';
  if (value === 'conservative') return 'conservative';
  throw new Error('Env var PROFIT_MODE must be expected, quote, or conservative');
}

function executionMode(): 'paper' | 'dry-run' | 'live' {
  const value = (process.env.EXECUTION_MODE || process.env.MODE || 'paper').trim().toLowerCase();
  if (value === 'paper' || value === 'dry-run' || value === 'live') return value;
  throw new Error('EXECUTION_MODE must be paper, dry-run, or live');
}

function numberList(primary: string, compatibilityAlias: string, fallback: number[]): number[] {
  const raw = process.env[primary] || process.env[compatibilityAlias];
  if (!raw) return fallback;
  const values = raw.split(',').map((value) => Number(value.trim()));
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${primary} must be a comma-separated list of positive numbers`);
  }
  return [...new Set(values)];
}

export const CONFIG = {
  // RPC_URL was used by the original project. Keep it as a compatibility alias
  // so an existing .env does not silently fall back to the public endpoint.
  rpcUrl: process.env.SOLANA_RPC_URL
    || process.env.RPC_URL
    || 'https://api.mainnet-beta.solana.com',
  rpcUrls: list('SOLANA_RPC_URLS').length > 0
    ? list('SOLANA_RPC_URLS')
    : [process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'],
  scannerWsUrl: process.env.SOLANA_WS_URL?.trim() || undefined,
  directMarketStreamMaxSubscriptions: num('DIRECT_MARKET_STREAM_MAX_SUBSCRIPTIONS', 64, 256),
  // Kept separate so scanner traffic cannot consume execution-critical RPC capacity.
  executionRpcUrl: process.env.EXECUTION_RPC_URL
    || process.env.SOLANA_RPC_URL
    || process.env.RPC_URL
    || 'https://api.mainnet-beta.solana.com',
  // Optional dedicated WebSocket endpoint for execution-state subscriptions.
  // web3.js derives it from EXECUTION_RPC_URL when omitted.
  executionWsUrl: process.env.EXECUTION_WS_URL?.trim() || undefined,
  // Execution calls must finish inside the immutable quote-freshness window.
  // Scanner RPC calls retain their own retry/timeout policy.
  // These are per-request fail-fast ceilings, not quote-age extensions. The
  // complete route still has to pass the unchanged 1200/1800ms evidence age.
  executionRpcTimeoutMs: num('EXECUTION_RPC_TIMEOUT_MS', 1_000),
  executionProviderTimeoutMs: num('EXECUTION_PROVIDER_TIMEOUT_MS', 1_200),
  executionWsMaxSilenceMs: num('EXECUTION_WS_MAX_SILENCE_MS', 4_000, 30_000),
  executionPoolRefreshDebounceMs: num('EXECUTION_POOL_REFRESH_DEBOUNCE_MS', 20, 250),
  executionSubmissionTransport: choice('EXECUTION_SUBMISSION_TRANSPORT', 'rpc', ['rpc', 'jito'] as const),
  jitoBlockEngineUrl: str('JITO_BLOCK_ENGINE_URL', 'https://singapore.mainnet.block-engine.jito.wtf'),
  jitoBenchmarkUrls: list('JITO_BENCHMARK_URLS').length > 0
    ? list('JITO_BENCHMARK_URLS')
    : [
      'https://singapore.mainnet.block-engine.jito.wtf',
      'https://tokyo.mainnet.block-engine.jito.wtf',
      'https://mainnet.block-engine.jito.wtf',
    ],
  jitoAuthKey: process.env.JITO_AUTH_KEY?.trim() || undefined,
  jitoSubmissionTimeoutMs: num('JITO_SUBMISSION_TIMEOUT_MS', 750, 2_000),
  // Jupiter API settings
  enableJupiter: bool('ENABLE_JUPITER', true),
  jupiterBaseUrl: str('JUPITER_BASE_URL', 'https://api.jup.ag/swap/v1'),
  jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
  jupiterPlan: str('JUPITER_PLAN', 'free').toLowerCase(),
  jupiterMaxRps: num('JUPITER_MAX_RPS', 1),
  jupiterSafetyIntervalMs: num('JUPITER_SAFETY_INTERVAL_MS', 1050),

  // Raptor quote-only API settings. The hosted public beta currently needs no key.
  enableRaptor: bool('ENABLE_RAPTOR', true),
  raptorBaseUrl: str('RAPTOR_BASE_URL', 'https://raptor-beta.solanatracker.io'),
  raptorSafetyIntervalMs: num('RAPTOR_SAFETY_INTERVAL_MS', 1000),
  raptorMaxHops: num('RAPTOR_MAX_HOPS', 4, 4),
  enableRaptorCircular: bool('ENABLE_RAPTOR_CIRCULAR', false),
  enableRaptorStream: bool('ENABLE_RAPTOR_STREAM', true),
  raptorStreamMaxSubscriptions: num('RAPTOR_STREAM_MAX_SUBSCRIPTIONS', 3, 12),
  marketEventDebounceMs: num('MARKET_EVENT_DEBOUNCE_MS', 1500),
  eventScanMinIntervalMs: num('EVENT_SCAN_MIN_INTERVAL_MS', 5000),

  // Raydium Trade API compute endpoint only. Transaction endpoints are never used.
  enableRaydium: bool('ENABLE_RAYDIUM', false),
  raydiumBaseUrl: str('RAYDIUM_BASE_URL', 'https://transaction-v1.raydium.io'),
  raydiumSafetyIntervalMs: num('RAYDIUM_SAFETY_INTERVAL_MS', 550),
  raydiumQuoteConcurrency: num('RAYDIUM_QUOTE_CONCURRENCY', 2, 4),

  // Orca's official data API is used only to discover direct Whirlpool pools.
  enableOrca: bool('ENABLE_ORCA', false),
  orcaApiBaseUrl: str('ORCA_API_BASE_URL', 'https://api.orca.so/v2/solana'),
  orcaSafetyIntervalMs: num('ORCA_SAFETY_INTERVAL_MS', 750),
  orcaQuoteConcurrency: num('ORCA_QUOTE_CONCURRENCY', 2, 4),
  // Cross-pool discovery needs more than the best single pool. Five remains a
  // deliberately small cap for Orca's public data API and Solana RPC usage.
  orcaMaxPoolsPerPair: num('ORCA_MAX_POOLS_PER_PAIR', 5, 5),
  enableOrcaCrossPool: bool('ENABLE_ORCA_CROSS_POOL', true),
  orcaCrossPoolAmountsUsdc: numberList('ORCA_CROSS_POOL_AMOUNTS_USDC', 'FIRST_LIVE_SCAN_AMOUNTS_USDC', [0.01, 0.02, 0.05]),
  orcaCrossPoolPrefilterBps: num('ORCA_CROSS_POOL_PREFILTER_BPS', 30, 500),
  directPoolMinTvlUsdc: num('DIRECT_POOL_MIN_TVL_USDC', 10_000),
  poolCacheTtlMs: num('POOL_CACHE_TTL_SECONDS', 300) * 1000,
  poolStateCacheTtlMs: num('POOL_STATE_CACHE_TTL_MS', 3000, 5000),
  orcaPoolStateTimeoutMs: num('ORCA_POOL_STATE_TIMEOUT_MS', 10_000, 30_000),

  // Meteora Data API discovery + official DLMM SDK state/quote reads only.
  enableMeteora: bool('ENABLE_METEORA', false),
  meteoraApiBaseUrl: str('METEORA_API_BASE_URL', 'https://dlmm.datapi.meteora.ag'),
  meteoraSafetyIntervalMs: num('METEORA_SAFETY_INTERVAL_MS', 750),
  meteoraQuoteConcurrency: num('METEORA_QUOTE_CONCURRENCY', 2, 4),
  // Bounds queued direct-RPC work so old background requests cannot make
  // current market quotes stale before they start.
  directQuoteQueueMax: num('DIRECT_QUOTE_QUEUE_MAX', 10, 40),
  meteoraMaxPoolsPerPair: num('METEORA_MAX_POOLS_PER_PAIR', 2, 5),
  
  // Scanner features
  referencePriceEnabled: process.env.REFERENCE_PRICE_ENABLED === 'true',
  scanTokens: parseTokenAllowlist(list('SCAN_TOKENS').length > 0
    ? list('SCAN_TOKENS')
    : ['USDC', 'SOL', 'USDT']),
  directDexOnly: bool('DIRECT_DEX_ONLY', false),
  minProfitBps: num('MIN_PROFIT_BPS', 1),
  profitMode: profitMode(),
  scanMode: choice('SCAN_MODE', 'core', ['core', 'expanded', 'hot'] as const),
  discoveryMode: choice('DISCOVERY_MODE', 'core', ['core', 'expanded'] as const),
  dynamicDiscoveryRefreshMs: num('DYNAMIC_DISCOVERY_REFRESH_SECONDS', 900, 3600) * 1000,
  dynamicDiscoveryLimit: num('DYNAMIC_DISCOVERY_LIMIT', 8, 30),
  dynamicDiscoverySourceLimit: num('DYNAMIC_DISCOVERY_SOURCE_LIMIT', 20, 50),
  orcaDynamicExecutionMaxTokens: num('ORCA_DYNAMIC_EXECUTION_MAX_TOKENS', 6, 20),
  minTokenLiquidityUsdc: num('MIN_TOKEN_LIQUIDITY_USD', 100_000),
  minTokenVolume24hUsdc: num('MIN_VOLUME_24H_USD', 100_000),
  tokenAllowlist: list('TOKEN_ALLOWLIST'),
  tokenDenylist: list('TOKEN_DENYLIST'),
  allowDynamicTokenExecution: bool('ALLOW_DYNAMIC_TOKEN_EXECUTION', true),
  prefilterSpreadBps: num('PREFILTER_SPREAD_BPS', 1),
  showNegativeRoutes: bool('SHOW_NEGATIVE_ROUTES', false),
  showBelowThreshold: bool('SHOW_BELOW_THRESHOLD', false),
  debug: bool('DEBUG', false),
  verboseScanOutput: bool('VERBOSE_SCAN_OUTPUT', false),
  opportunityExpiryMs: num('OPPORTUNITY_EXPIRY_MS', 15_000),
  opportunityUpdateBps: num('OPPORTUNITY_UPDATE_BPS', 0.25),

  // UI configurable settings
  tradeSizesUsdc: numberList('SCAN_AMOUNTS_USDC', 'TRADE_SIZES_USDC', [10, 25, 50, 100]),
  // Rotate through the configured sizes instead of bursting every size through
  // all provider combinations in one iteration. This is intentionally
  // conservative for public/free RPC endpoints.
  tradeSizesPerScan: num('TRADE_SIZES_PER_SCAN', 1, 10),
  // Bounded discovery parallelism. Each provider still owns its own pacing,
  // concurrency, cache, and cooldown, so this never turns into a global burst.
  scannerConcurrentCycles: num('SCANNER_CONCURRENT_CYCLES', 3, 5),
  hotCycleWeight: num('HOT_CYCLE_WEIGHT', 4, 10),
  warmCycleWeight: num('WARM_CYCLE_WEIGHT', 2, 10),
  coreCycleWeight: num('CORE_CYCLE_WEIGHT', 1, 10),
  discoveryCycleWeight: num('DISCOVERY_CYCLE_WEIGHT', 1, 10),
  orcaCrossPoolScanIntervalMs: num('ORCA_CROSS_POOL_SCAN_INTERVAL_MS', 3_000, 60_000),
  
  // HARD SAFETY LIMIT: 10,000 USDC max trade size
  maxTradeSizeUsdc: 10000, 
  
  // Max slippage bps to request in quote (0.05%)
  slippageBps: num('SLIPPAGE_BPS', 5), // HARD LIMIT: keep this very low for arbitrage

  minNetProfitUsdc: num('MIN_NET_PROFIT_USDC', 0.001),
  minConfidenceScore: num('MIN_CONFIDENCE_SCORE', 75), // User requested "high confidence"
  scanIntervalMs: num('SCAN_INTERVAL_MS', 1_000), // fallback when no market event arrives
  
  // Stale quote protection
  maxQuoteAgeMs: num('MAX_QUOTE_AGE_MS', 5000), // Hard limit to reject stale quotes

  buyDexes: list('BUY_DEXES'),
  sellDexes: list('SELL_DEXES'),

  fallbackPriorityFeeMicroLamports: num('FALLBACK_PRIORITY_FEE_MICROLAMPORTS', 20_000),
  executionPriorityFeeMinMicroLamports: num('EXECUTION_PRIORITY_FEE_MIN_MICROLAMPORTS', 1_000),
  executionPriorityFeeMaxMicroLamports: num('EXECUTION_PRIORITY_FEE_MAX_MICROLAMPORTS', 100_000, 1_000_000),
  executionPriorityFeePercentile: num('EXECUTION_PRIORITY_FEE_PERCENTILE', 75, 100),
  executionPriorityFeeRefreshMs: num('EXECUTION_PRIORITY_FEE_REFRESH_MS', 10_000, 60_000),
  assumedComputeUnits: num('ASSUMED_COMPUTE_UNITS', 200_000),

  httpTimeoutMs: num('HTTP_TIMEOUT_MS', 5000),
  httpMaxRetries: num('HTTP_MAX_RETRIES', 3),
  quoteCacheTtlMs: num('QUOTE_CACHE_TTL_MS', 1500),
  providerFailureThreshold: num('PROVIDER_FAILURE_THRESHOLD', 3),
  providerCooldownMs: num('PROVIDER_COOLDOWN_MS', 30_000),
  providerHealthIntervalMs: num('PROVIDER_HEALTH_INTERVAL_MS', 60_000),

  // Delay before a second independent quote confirmation.
  confirmationDelayMs: num(
    'CONFIRMATION_DELAY_MS',
    num('SIMULATE_LATENCY_MS', 500), // compatibility with older .env files
  ),
  executionMode: executionMode(),
  // Compatibility for the existing dashboard/database API.
  mode: executionMode().toUpperCase(),
  liveTradingEnabled: bool('LIVE_TRADING_ENABLED', false),
  // A separate acknowledgement is required before a live process may keep
  // evaluating candidates after its first loop iteration. It is false by
  // default even if LIVE_TRADING_ENABLED is accidentally set.
  liveContinuousEnabled: bool('LIVE_CONTINUOUS_ENABLED', false),
  realMoneyReadiness: str('REAL_MONEY_READINESS', 'NOT_READY').trim().toUpperCase(),
  // Continuous live mode remains bounded by an explicit session cap plus the loss
  // and consecutive-failure circuit breakers.
  liveMaxTransactions: num('LIVE_MAX_TRANSACTIONS', 1, 100),
  // Local DTO inbox polling performs no quote/RPC request until a new candidate
  // appears. Keep it well below the 1.2s quote-age ceiling for P0 handoffs.
  liveExecutionPollMs: num('LIVE_EXECUTION_POLL_MS', 100, 60_000),
  // Dedicated test-wallet ceiling. Default remains 0.05; an explicit local
  // opt-in may raise it to at most 1 USDC without changing source again.
  firstLiveMaxInputUsdc: num('FIRST_LIVE_MAX_INPUT_USDC', 0.05, 1),
  maxApprovedBlockhashAgeMs: num('MAX_APPROVED_BLOCKHASH_AGE_MS', 10_000, 30_000),
  // Local UI-only fixture for verifying the manual approval card. It never
  // enters the executor IPC channel and cannot reach the broadcaster.
  manualApprovalUiMock: bool('MANUAL_APPROVAL_UI_MOCK', false),
  executionConfirmationCommitment: choice(
    'EXECUTION_CONFIRMATION_COMMITMENT',
    'confirmed',
    ['confirmed', 'finalized'] as const,
  ),
  botWalletAddress: process.env.BOT_WALLET_ADDRESS?.trim() || undefined,
  botKeypairPath: process.env.BOT_KEYPAIR_PATH?.trim() || undefined,
  maxTradeUsdc: num('MAX_TRADE_USDC', 0.25),
  maxTradePercent: num('MAX_TRADE_PERCENT', 10),
  maxDailyLossUsdc: num('MAX_DAILY_LOSS_USDC', 0.25),
  maxSingleTradeLossUsdc: num('MAX_SINGLE_TRADE_LOSS_USDC', 0.05),
  maxTradesPerSession: num('MAX_TRADES_PER_SESSION', 1, 100),
  maxExecutionConsecutiveFailures: num('MAX_EXECUTION_CONSECUTIVE_FAILURES', 2, 10),
  maxSessionLossUsdc: num('MAX_SESSION_LOSS_USDC', 0.25),
  maxConcurrentExecutions: num('MAX_CONCURRENT_EXECUTIONS', 1, 1),
  // Scanner-only soft budget. Never used for executor freshness/approval.
  scannerDirectLaneDeadlineMs: num('SCANNER_DIRECT_LANE_DEADLINE_MS', 1000, 10_000),
  minSolFeeReserve: num('MIN_SOL_FEE_RESERVE', 0.002),
  maxExecutionQuoteAgeMs: num('MAX_EXECUTION_QUOTE_AGE_MS', 1200),
  raptorExecutionQuoteAgeMs: num('RAPTOR_EXECUTION_QUOTE_AGE_MS', 1800, 1800),
  // Conservative conversion used only for SOL-denominated transaction costs
  // when the arbitrage intermediate is not WSOL.
  executionSolPriceCeilingUsdc: num('EXECUTION_SOL_PRICE_CEILING_USDC', 250, 10_000),
  maxSlotDifference: num('MAX_SLOT_DIFFERENCE', 8),
  executionValidationAmountUsdc: num('EXECUTION_VALIDATION_AMOUNT_USDC', 0.05),
  executionValidationIntermediateMint: str(
    'EXECUTION_VALIDATION_INTERMEDIATE_MINT',
    'So11111111111111111111111111111111111111112',
  ),
  paperStartingBalanceUsdc: num('PAPER_STARTING_BALANCE_USDC', 100),
  paperMaxDailyLossUsdc: num('PAPER_MAX_DAILY_LOSS_USDC', 2),
} as const;

export { MINTS, DECIMALS } from './tokens.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const BASE_SIGNATURE_FEE_LAMPORTS = 5_000;

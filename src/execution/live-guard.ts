import { CONFIG } from '../config.js';

export interface LiveSubmissionGuardConfig {
  executionMode: 'paper' | 'dry-run' | 'live';
  liveTradingEnabled: boolean;
  liveContinuousEnabled: boolean;
  realMoneyReadiness: string;
  liveMaxTransactions: number;
  maxConcurrentExecutions: number;
  maxTradesPerSession: number;
}

export function assertLiveSubmissionAllowed(
  readinessReady: boolean,
  config: LiveSubmissionGuardConfig = CONFIG,
): void {
  if (config.executionMode !== 'live') throw new Error('Broadcast blocked: EXECUTION_MODE is not live');
  if (!config.liveTradingEnabled) throw new Error('Broadcast blocked: LIVE_TRADING_ENABLED is false');
  if (!config.liveContinuousEnabled) throw new Error('Broadcast blocked: LIVE_CONTINUOUS_ENABLED is false');
  if (config.realMoneyReadiness !== 'READY') throw new Error('Broadcast blocked: REAL_MONEY_READINESS is not READY');
  if (!Number.isInteger(config.liveMaxTransactions) || config.liveMaxTransactions < 1 || config.liveMaxTransactions > 100) {
    throw new Error('Broadcast blocked: LIVE_MAX_TRANSACTIONS must be an integer from 1 through 100');
  }
  if (config.maxConcurrentExecutions !== 1) throw new Error('Broadcast blocked: MAX_CONCURRENT_EXECUTIONS must equal 1');
  if (!Number.isInteger(config.maxTradesPerSession) || config.maxTradesPerSession < 1) {
    throw new Error('Broadcast blocked: MAX_TRADES_PER_SESSION must be a positive integer');
  }
  if (config.maxTradesPerSession !== config.liveMaxTransactions) {
    throw new Error('Broadcast blocked: MAX_TRADES_PER_SESSION must equal LIVE_MAX_TRANSACTIONS');
  }
  if (!readinessReady) throw new Error('Broadcast blocked: REAL_MONEY_READINESS is NOT READY');
}

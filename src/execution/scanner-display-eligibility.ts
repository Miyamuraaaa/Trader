import { exact } from '../math.js';
import { isExecutableProviderPair } from './executable-route-policy.js';
import type { QuoteProviderName } from '../aggregators/types.js';
export function scannerDisplayEligibility(row: Record<string, unknown>, liveCapUsdc: number): string {
  try {
    if (exact(String(row.trade_size_usdc)).gt(liveCapUsdc)) return 'ABOVE_LIVE_CAP';
    if (row.opportunity_state === 'DISCOVERY_ONLY_TOKEN_2022') return 'TOKEN_2022_DISCOVERY_ONLY';
    if (!exact(String(row.expected_profit_usdc)).gt(0)) return 'NEGATIVE';
    if (!isExecutableProviderPair(row.buy_provider as QuoteProviderName, row.sell_provider as QuoteProviderName)
      && !(row.buy_provider === 'orca' && row.sell_provider === 'orca')) return 'UNSUPPORTED_PROVIDER_PAIR';
    if (row.opportunity_state === 'EXECUTABLE_CANDIDATE' && row.stale !== 1) return 'EXECUTION_ELIGIBLE';
    if (row.opportunity_state === 'ROUTE_POLICY_REJECTED') return 'ROUTE_POLICY_BLOCKED';
  } catch { /* Missing/malformed historical evidence has no execution authority. */ }
  return 'RAW_ONLY';
}

import { MINTS } from '../config.js';
import type { RoundTripResult } from '../routes.js';
import {
  isExecutableProviderPair,
  quoteMatchesExecutableProviderPolicy,
} from './executable-route-policy.js';

function isExecutorConstrainedRoute(route: RoundTripResult): boolean {
  const { buyQuote, sellQuote } = route;
  return route.opportunityScope === 'EXECUTABLE_CANDIDATE'
    && isExecutableProviderPair(buyQuote.provider, sellQuote.provider)
    && quoteMatchesExecutableProviderPolicy(buyQuote)
    && quoteMatchesExecutableProviderPolicy(sellQuote)
    && sellQuote.inAmount === buyQuote.otherAmountThreshold;
}

/**
 * Scanner-side shape check only. This never authorizes execution: a matching
 * route is merely promoted to the independent executor without waiting for
 * slower discovery matrices. The executor requotes and revalidates everything.
 */
export function isAuditedAggregatorHandoffRoute(route: RoundTripResult): boolean {
  const { buyQuote, sellQuote } = route;
  const supportedOrder = (buyQuote.provider === 'raptor' && sellQuote.provider === 'jupiter')
    || (buyQuote.provider === 'jupiter' && sellQuote.provider === 'raptor');
  return supportedOrder
    && isExecutorConstrainedRoute(route)
    && buyQuote.inputMint === MINTS.USDC && buyQuote.outputMint !== MINTS.USDC
    && sellQuote.inputMint === buyQuote.outputMint && sellQuote.outputMint === MINTS.USDC
    && route.liquidityOverlap === false
    && route.validationTier === 'CONSERVATIVE_CANDIDATE'
    && !route.stale;
}

/**
 * Mixed route classes whose current executor uses independently constructed,
 * protocol-specific instructions. Raydium's Trade API wrapper and Meteora's
 * SDK Transaction are intentionally excluded until their setup/cleanup and
 * instruction data have equally strict protocol decoders.
 */
const MIXED_PROVIDER_PAIRS: ReadonlySet<string> = new Set([
  // Jupiter <-> Orca
  'jupiter:orca', 'orca:jupiter',
  // Raptor <-> Orca
  'raptor:orca', 'orca:raptor',
]);

/**
 * Recognizes all valid two-provider cycle shapes for mixed execution.
 * Same scanner-side shape check: never authorizes execution.
 */
export function isAuditedMixedHandoffRoute(route: RoundTripResult): boolean {
  const { buyQuote, sellQuote } = route;
  const providerKey = `${buyQuote.provider}:${sellQuote.provider}`;
  return MIXED_PROVIDER_PAIRS.has(providerKey)
    && isExecutorConstrainedRoute(route)
    && buyQuote.inputMint === MINTS.USDC && buyQuote.outputMint !== MINTS.USDC
    && sellQuote.inputMint === buyQuote.outputMint && sellQuote.outputMint === MINTS.USDC
    && route.liquidityOverlap === false
    && route.validationTier === 'CONSERVATIVE_CANDIDATE'
    && !route.stale;
}

/**
 * Live promotion is deliberately narrower than discovery but independent from
 * the scanner's paper-oriented confidence/risk presentation gates. The
 * executor always reconstructs the route, requotes it and requires a positive
 * conservative result after simulation, so this function cannot authorize a
 * transaction by itself.
 */
export function isFreshPositiveAuditedExecutionSignal(route: RoundTripResult): boolean {
  const { buyQuote, sellQuote, profit } = route;
  const providerKey = `${buyQuote.provider}:${sellQuote.provider}`;
  const supported = isExecutableProviderPair(buyQuote.provider, sellQuote.provider);
  return supported
    && isExecutorConstrainedRoute(route)
    && buyQuote.inputMint === MINTS.USDC
    && buyQuote.outputMint !== MINTS.USDC
    && sellQuote.inputMint === buyQuote.outputMint
    && sellQuote.outputMint === MINTS.USDC
    && route.liquidityOverlap === false
    && !route.stale
    && profit.estimatedNetProfitUsdc.gt(0)
    && profit.worstCaseNetProfitUsdc.gt(0);
}

import { CONFIG } from '../config.js';
import { exact } from '../math.js';
import type { RoundTripResult } from '../routes.js';
import type { EstimatedCostInput } from '../profit.js';
import { economicBreakdown } from './economic-breakdown.js';
import type { SourceLane } from '../execution/source-lane.js';
import { isExecutableProviderPair, quoteMatchesExecutableProviderPolicy } from '../execution/executable-route-policy.js';

/** Consumes existing quote/cost results only; no provider or RPC operations. */
export function scannerBreakdown(route: RoundTripResult, costs: EstimatedCostInput, sourceLane: SourceLane, candidateId?: string, constrained = true) {
  const { buyQuote: buy, sellQuote: sell } = route;
  const atomic = (value: string | number) => exact(value).mul(1000000).toFixed();
  const breakdown = economicBreakdown({ candidateId, sourceLane, amountChainModel: constrained ? 'ENFORCEABLE_MINIMUM' : 'EXPECTED_OUTPUT', modelAuthority: 'SCANNER_ADVISORY', modelVersion: constrained ? 'scanner-conservative-v1' : 'scanner-broad-expected-chain-v1',
    providerPair: `${buy.provider}->${sell.provider}`, sizeAtomic: buy.inAmount, baseMint: buy.inputMint, intermediateMint: buy.outputMint,
    leg1ExpectedOutAtomic: buy.outAmount, leg1MinOutAtomic: buy.otherAmountThreshold, leg2InputAtomic: sell.inAmount,
    leg2ExpectedOutAtomic: sell.outAmount, leg2MinOutAtomic: sell.otherAmountThreshold,
    baseCostAtomic: atomic(costs.baseNetworkFeeUsdc), priorityCostAtomic: atomic(costs.priorityFeeUsdc),
    ataCostAtomic: atomic(costs.ataRentUsdc ?? 0), otherCostAtomic: atomic(costs.otherKnownCostsUsdc ?? 0),
    minNetThresholdAtomic: atomic(CONFIG.minNetProfitUsdc), minRoiThresholdBps: CONFIG.minProfitBps,
    freshCompatible: !route.stale && Math.max(Date.now()-buy.responseTimestamp,Date.now()-sell.responseTimestamp) <= CONFIG.maxQuoteAgeMs && (constrained ? sell.inAmount === buy.otherAmountThreshold : sell.inAmount === buy.outAmount),
    routePolicyCompatible: isExecutableProviderPair(buy.provider,sell.provider) && quoteMatchesExecutableProviderPolicy(buy) && quoteMatchesExecutableProviderPolicy(sell) && buy.poolIds.length === 1 && sell.poolIds.length === 1 && route.liquidityOverlap === false,
    withinLiveCap: exact(buy.inAmount).lte(exact(CONFIG.firstLiveMaxInputUsdc).mul(1000000)),
    baseFeeLamports: costs.diagnosticSource?.baseFeeLamports, priorityFeeLamports: costs.diagnosticSource?.priorityFeeLamports, ataRentLamports: costs.diagnosticSource?.ataRentLamports,
    solToUsdcPriceMicrounits: costs.diagnosticSource?.solPriceMicrounits, costSourceAgeMs: costs.diagnosticSource ? Math.max(0, Date.now() - costs.diagnosticSource.capturedAtWallMs) : undefined,
    leg1EvidenceAgeMs: Math.max(0, Date.now() - buy.responseTimestamp), leg2EvidenceAgeMs: Math.max(0, Date.now() - sell.responseTimestamp),
    pairSkewMs: Math.abs(buy.responseTimestamp - sell.responseTimestamp),
    routeShapeEvidenceComplete: [buy,sell].every(q=>q.routePlan.length > 0 && q.routePlan.every(s=>!!s.swapInfo.programId)),
    routeShape: [buy, sell].map(q => [q.provider, q.inputMint, q.outputMint, [...new Set(q.routePlan.flatMap(s => s.swapInfo.programId ? [s.swapInfo.programId] : []))].sort()]),
    pools: [buy.poolIds, sell.poolIds] });
  // Numeric diagnostics cannot promote an observation rejected by the existing
  // scanner decision (for example, unknown pool independence). Report disagreement.
  if (constrained && breakdown.economicOutcome === 'EXEC_SURFACE_POSITIVE' && route.validationTier !== 'CONSERVATIVE_CANDIDATE') {
    return Object.freeze({ ...breakdown, economicOutcome: 'UNATTRIBUTED_ECONOMICS' as const, unattributedReason: 'SCANNER_DECISION_MISMATCH' });
  }
  return breakdown;
}

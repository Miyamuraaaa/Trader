import { CONFIG, DECIMALS, MINTS } from './config.js';
import { getDynamicTokens, refreshDynamicTokenUniverse } from './dynamic-token-universe.js';
import type { OrcaAtomicHandoff } from './execution/handoff-dto.js';
import { toAtomic } from './math.js';
import { orcaCrossPoolStats, scanOrcaCrossPoolCycles } from './orca-cross-pool.js';
import { checkRpc, estimateNetworkFeeBreakdown, lamportsToSol } from './solana.js';

export interface LiveOrcaCandidateScan {
  candidates: OrcaAtomicHandoff[];
  feeEstimateFallback: boolean;
}

/** Public market discovery only; this grants no authority to the executor. */
export async function discoverCurrentOrcaExecutionCandidates(): Promise<LiveOrcaCandidateScan> {
  // Dynamic discovery is an additive source. A Jupiter/discovery outage must
  // not prevent the core SOL/USDT Orca strategy from scanning current pools.
  if (CONFIG.allowDynamicTokenExecution) {
    try {
      await refreshDynamicTokenUniverse();
    } catch (error) {
      console.warn(`Dynamic token refresh unavailable; continuing with core and cached mints: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const dynamic = CONFIG.allowDynamicTokenExecution
    ? getDynamicTokens()
      .filter((token) => token.executionPrecheck === 'PASS')
      .filter((token) => token.tier === 'HOT' || token.tier === 'WARM')
      .slice(0, CONFIG.orcaDynamicExecutionMaxTokens)
      .map((token) => token.mint)
    : [];
  const intermediates = [...new Set([MINTS.SOL, MINTS.USDT, ...dynamic])];
  const [slotResult, feeResult] = await Promise.allSettled([checkRpc(), estimateNetworkFeeBreakdown()]);
  const slot = slotResult.status === 'fulfilled' ? slotResult.value : undefined;
  const feeLamports = feeResult.status === 'fulfilled'
    && Number.isFinite(feeResult.value.totalLamports)
    && feeResult.value.totalLamports >= 0
    ? Math.ceil(feeResult.value.totalLamports)
    : 10_000;
  const networkCost = BigInt(toAtomic(
    lamportsToSol(feeLamports) * CONFIG.executionSolPriceCeilingUsdc,
    DECIMALS.USDC,
  ));
  const observations = await scanOrcaCrossPoolCycles({
    currentSlot: slot,
    networkCostUsdcAtomic: networkCost,
    intermediates,
    executionIntermediates: intermediates,
  });
  const candidates = observations.flatMap((observation) => observation.dto ? [observation.dto] : []);
  candidates.sort((a, b) => BigInt(a.scannerObservation.projectedNetAmount) > BigInt(b.scannerObservation.projectedNetAmount) ? -1 : 1);
  return { candidates, feeEstimateFallback: feeResult.status !== 'fulfilled' };
}

export function formatLiveOrcaCoverage(): string[] {
  const lines = [
    `Orca intermediates: ${orcaCrossPoolStats.intermediatesTracked}; pools tracked: ${orcaCrossPoolStats.poolsTracked}; USDC/WSOL pools: ${orcaCrossPoolStats.eligibleUsdcWsolPools}; dynamic/core non-WSOL pools: ${orcaCrossPoolStats.eligibleUsdcDynamicPools}; ordered combinations: ${orcaCrossPoolStats.orderedCombinations}; state prefilters: ${orcaCrossPoolStats.prefilterEvaluations}; exact evaluations: ${orcaCrossPoolStats.evaluated}; state failures: ${orcaCrossPoolStats.poolStateFailures}; quote skips: ${orcaCrossPoolStats.skippedQuotes}`,
    `Cross-pool rate: prefilter=${orcaCrossPoolStats.prefilterEvaluationsPerMinute}/min; exact=${orcaCrossPoolStats.evaluationsPerMinute}/min`,
    `Scan sizes: ${orcaCrossPoolStats.scanSizesUsdc.join(', ')} USDC; scanner candidates: ${orcaCrossPoolStats.candidates}; handoffs: ${orcaCrossPoolStats.handoffs}`,
    `Intermediate mints: ${orcaCrossPoolStats.intermediateMints.join(', ') || 'none'}`,
  ];
  if (orcaCrossPoolStats.poolStateFailureReasons.length > 0) {
    lines.push(`Pool-state errors: ${orcaCrossPoolStats.poolStateFailureReasons.join(' | ')}`);
  }
  return lines;
}

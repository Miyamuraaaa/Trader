import { CONFIG, MINTS } from '../config.js';
import { toAtomic } from '../math.js';
import type { AtomicExecutionPlan } from '../execution/types.js';
import type { ExecutorEconomics } from '../execution/handoff-validator.js';
import { economicBreakdown } from './economic-breakdown.js';
import { emitExecutorEconomicBreakdown, emitFunnelExecutionStage } from '../execution/execution-funnel.js';

export function observeExecutorEconomics(plan: AtomicExecutionPlan, economics: ExecutorEconomics, candidateId: string, detectedAt: number): void {
  try { emitExecutorEconomicBreakdown(candidateId, detectedAt, executorBreakdown(plan, economics, candidateId)); }
  catch { emitFunnelExecutionStage(candidateId, 'UNATTRIBUTED_ECONOMICS', detectedAt, 'DIAGNOSTIC_INPUT_UNAVAILABLE'); }
}

/** Called only with independently computed executor facts. Accepts no scanner input. */
export function executorBreakdown(plan: AtomicExecutionPlan, economics: ExecutorEconomics, candidateId: string) {
  const legs = plan.aggregatorEvidence?.legs;
  const total = economics.networkCostUsdcAtomic;
  const costLamports = economics.totalNetworkCostLamports;
  // Allocate the already-rounded authoritative total; never round each component up again.
  const priority = costLamports ? total * economics.priorityFeeLamports / costLamports : 0n;
  const rent = costLamports ? total * economics.ataRentLamports / costLamports : 0n;
  // Keep the single conversion-rounding remainder in network costs, not ATA rent:
  // a route requiring no account creation must have exactly zero modeled rent.
  const base = total - priority - rent;
  return economicBreakdown({ candidateId, sourceLane: legs ? 'BROAD_MATRIX' : 'ORCA_CROSS_POOL', amountChainModel: legs ? 'ENFORCEABLE_MINIMUM' : 'ATOMIC_TWO_HOP', modelAuthority: 'EXECUTOR_AUTHORITATIVE', modelVersion: 'executor-final-plan-simulation-v1',
    providerPair: plan.aggregatorEvidence?.providers.join('->') ?? 'orca->orca', sizeAtomic: plan.inputAmount.toString(), baseMint: plan.inputMint, intermediateMint: plan.intermediateMint,
    leg1ExpectedOutAtomic: plan.expectedIntermediateAmount.toString(), leg1MinOutAtomic: legs?.[0].minimumOutputAmount.toString() ?? '',
    leg2InputAtomic: legs?.[1].inputAmount.toString() ?? '', leg2ExpectedOutAtomic: plan.expectedOutputAmount.toString(), leg2MinOutAtomic: plan.minimumOutputAmount.toString(),
    baseCostAtomic: base.toString(), priorityCostAtomic: priority.toString(), ataCostAtomic: rent.toString(), otherCostAtomic: '0',
    baseFeeLamports: economics.baseFeeLamports.toString(), priorityFeeLamports: economics.priorityFeeLamports.toString(), ataRentLamports: economics.ataRentLamports.toString(), otherCostLamports: '0',
    solToUsdcPriceMicrounits: plan.intermediateMint === MINTS.SOL ? (plan.inputAmount * 1000000000n / plan.expectedIntermediateAmount).toString() : toAtomic(CONFIG.executionSolPriceCeilingUsdc, 6),
    minNetThresholdAtomic: toAtomic(CONFIG.minNetProfitUsdc, 6), minRoiThresholdBps: CONFIG.minProfitBps,
    // The plan owns one conservative timestamp, not two independently timed quotes.
    // Leave individual ages/skew unknown instead of reporting an invented zero skew.
    planEvidenceAgeMs: Math.max(0, Date.now() - plan.quoteReceivedAt),
    routeShapeEvidenceComplete: legs?.every(l=>!!l.downstreamProgramId) ?? false,
    routeShape: legs?.map(l => [l.provider, l.inputMint, l.outputMint, l.downstreamProgramId ? [l.downstreamProgramId] : []]) ?? [plan.type], pools: plan.pools.map(p => [p]) });
}

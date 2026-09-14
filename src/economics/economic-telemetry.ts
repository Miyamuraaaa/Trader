import { z } from 'zod';
import type { EconomicBreakdownV1 } from './economic-breakdown.js';

const atomic = z.string().regex(/^-?\d+(\.\d+)?$/).max(120);
// Explicit scalar whitelist for executor IPC. Never forwards a plan, instructions or RPC payload.
export const EconomicTelemetry = z.object({ schemaVersion: z.literal(1), breakdownId: z.string().max(100),
  routeShapeEvidenceComplete: z.boolean().optional(),
  candidateId: z.string().max(200).optional(), modelAuthority: z.enum(['SCANNER_ADVISORY', 'EXECUTOR_AUTHORITATIVE']),
  economicOutcome: z.string().max(80), unattributedReason: z.string().max(100).optional(),
  leg2ExpectedOutAtomic: atomic, leg2MinOutAtomic: atomic,
  baseCostAtomic: atomic, priorityCostAtomic: atomic, ataCostAtomic: atomic, otherCostAtomic: atomic,
  totalCostUsdcAtomic: atomic.optional(), postCostConservativeNetAtomic: atomic.optional(), conservativeRoiBps: z.number().finite().optional(),
  leg1EvidenceAgeMs: z.number().finite().optional(), leg2EvidenceAgeMs: z.number().finite().optional(), pairSkewMs: z.number().finite().optional(), planEvidenceAgeMs: z.number().finite().optional(),
  routeShapeHash: z.string().regex(/^[a-f0-9]{64}$/), poolSetHash: z.string().regex(/^[a-f0-9]{64}$/), executablePolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
  baseFeeLamports: atomic.optional(), priorityFeeLamports: atomic.optional(), ataRentLamports: atomic.optional(), solToUsdcPriceMicrounits: atomic.optional() });
export type EconomicTelemetryValue = z.infer<typeof EconomicTelemetry>;
export function economicComparison(scanner: EconomicBreakdownV1, executor: EconomicTelemetryValue) {
  const difference = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && /^-?\d+$/.test(a) && /^-?\d+$/.test(b) ? (BigInt(b) - BigInt(a)).toString() : null;
  return { executionId: executor.candidateId, scannerBreakdownId: scanner.breakdownId, executorBreakdownId: executor.breakdownId, schemaVersion: 1,
    expectedFinalDelta: difference(scanner.leg2ExpectedOutAtomic, executor.leg2ExpectedOutAtomic), minimumFinalDelta: difference(scanner.leg2MinOutAtomic, executor.leg2MinOutAtomic),
    baseFeeDelta: difference(scanner.baseFeeLamports, executor.baseFeeLamports), priorityFeeDelta: difference(scanner.priorityFeeLamports, executor.priorityFeeLamports), ataRentDelta: difference(scanner.ataRentLamports, executor.ataRentLamports),
    totalCostDelta: difference(scanner.totalCostUsdcAtomic, executor.totalCostUsdcAtomic), conservativeNetDelta: difference(scanner.postCostConservativeNetAtomic, executor.postCostConservativeNetAtomic),
    roiDelta: scanner.conservativeRoiBps === undefined || executor.conservativeRoiBps === undefined ? null : executor.conservativeRoiBps - scanner.conservativeRoiBps,
    solPriceDelta: difference(scanner.solToUsdcPriceMicrounits, executor.solToUsdcPriceMicrounits),
    evidenceAgeDelta: executor.leg1EvidenceAgeMs === undefined || scanner.leg1EvidenceAgeMs === undefined ? null : executor.leg1EvidenceAgeMs - scanner.leg1EvidenceAgeMs,
    planVsScannerOldestEvidenceAgeDelta: executor.planEvidenceAgeMs === undefined || scanner.leg1EvidenceAgeMs === undefined || scanner.leg2EvidenceAgeMs === undefined ? null : executor.planEvidenceAgeMs - Math.max(scanner.leg1EvidenceAgeMs, scanner.leg2EvidenceAgeMs),
    routeShapeChanged: scanner.routeShapeEvidenceComplete && executor.routeShapeEvidenceComplete ? scanner.routeShapeHash !== executor.routeShapeHash : null, poolSetChanged: scanner.poolSetHash !== executor.poolSetHash,
    marketMovementComparable: !!scanner.routeShapeEvidenceComplete && !!executor.routeShapeEvidenceComplete && scanner.routeShapeHash === executor.routeShapeHash && scanner.poolSetHash === executor.poolSetHash,
    executorEconomicOutcome: executor.economicOutcome };
}

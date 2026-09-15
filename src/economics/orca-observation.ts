import { randomUUID } from 'node:crypto';
import type { OrcaCrossPoolEvaluation } from '../orca-cross-pool.js';
import { MINTS } from '../config.js';
import { EXECUTABLE_POLICY_HASH } from '../execution/executable-route-policy.js';

/** A copy of existing computed evidence, not another quote or execution model. */
export function orcaObservation(e: OrcaCrossPoolEvaluation) {
  const expectedCost=e.expectedOutputAmount-e.inputAmount-e.projectedNetAmount;
  const minimumCost=e.minimumOutputAmount-e.inputAmount-e.conservativeNetAmount;
  const consistent=expectedCost>=0n&&expectedCost===minimumCost;
  return Object.freeze({ schemaVersion:1 as const, breakdownId:randomUUID(), sourceLane:'ORCA_CROSS_POOL' as const,
    modelAuthority:'SCANNER_ADVISORY' as const, modelVersion:'orca-existing-cross-pool-observation-v1', executablePolicyHash:EXECUTABLE_POLICY_HASH,
    breakdownCompleteness:'PARTIAL' as const,
    missingFields:Object.freeze(['leg1ExpectedOutAtomic','leg1MinOutAtomic','leg2InputAtomic','leg1EvidenceAgeMs','leg2EvidenceAgeMs','pairSkewMs','baseFeeLamports','priorityFeeLamports','ataRentLamports','solToUsdcPriceMicrounits','costSourceAgeMs']),
    providerPair:'orca->orca', baseMint:MINTS.USDC, intermediateMint:e.intermediateMint,sizeAtomic:e.inputAmount.toString(),
    leg2ExpectedOutAtomic:e.expectedOutputAmount.toString(),leg2MinOutAtomic:e.minimumOutputAmount.toString(),
    postCostExpectedNetAtomic:e.projectedNetAmount.toString(),postCostConservativeNetAtomic:e.conservativeNetAmount.toString(),
    observedTotalCostUsdcAtomic:consistent?expectedCost.toString():null,
    observedEvidenceAt:e.detectedAt, pools:Object.freeze([e.firstPool,e.secondPool]), existingExecutionEligible:e.executionEligible,
    economicOutcome:'UNATTRIBUTED_ECONOMICS' as const, unattributedReason:consistent?'INCOMPLETE_ORCA_COST_AND_CHAIN_EVIDENCE':'ORCA_COST_INVARIANT',
    observationPositive:e.projectedNetAmount>0n&&e.conservativeNetAmount>0n });
}

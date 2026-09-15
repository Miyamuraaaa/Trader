import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { SourceLane } from '../execution/source-lane.js';
import { EXECUTABLE_POLICY_HASH } from '../execution/executable-route-policy.js';

export const ECONOMIC_OUTCOMES = ['EXEC_SURFACE_EXPECTED_NONPOSITIVE', 'MIN_OUTPUT_PROPAGATION_LOSS', 'NETWORK_COST_DOMINATED', 'ATA_RENT_DOMINATED', 'MIN_NET_THRESHOLD_SHORTFALL', 'MIN_ROI_THRESHOLD_SHORTFALL', 'UNATTRIBUTED_ECONOMICS', 'EXEC_SURFACE_POSITIVE', 'BROAD_ROUND_TRIP_POSITIVE'] as const;
export type EconomicOutcome = typeof ECONOMIC_OUTCOMES[number];
export interface BreakdownInput {
  amountChainModel?: 'EXPECTED_OUTPUT' | 'ENFORCEABLE_MINIMUM' | 'ATOMIC_TWO_HOP';
  routeShapeEvidenceComplete?: boolean;
  freshCompatible?: boolean;
  routePolicyCompatible?: boolean;
  withinLiveCap?: boolean;
  candidateId?: string; sourceLane: SourceLane; modelAuthority: 'SCANNER_ADVISORY' | 'EXECUTOR_AUTHORITATIVE'; modelVersion: string;
  providerPair: string; sizeAtomic: string; baseMint: string; intermediateMint: string;
  leg1ExpectedOutAtomic: string; leg1MinOutAtomic: string; leg2InputAtomic: string;
  leg2ExpectedOutAtomic: string; leg2MinOutAtomic: string;
  // Decimal atomic costs retain the existing model's sub-micro-USDC precision.
  // They are converted to an integer numerator/common denominator below, not rounded before classification.
  baseCostAtomic: string; priorityCostAtomic: string; ataCostAtomic: string; otherCostAtomic: string;
  minNetThresholdAtomic: string; minRoiThresholdBps: number;
  baseFeeLamports?: string; priorityFeeLamports?: string; ataRentLamports?: string; otherCostLamports?: string;
  solToUsdcPriceMicrounits?: string; costSourceAgeMs?: number;
  leg1EvidenceAgeMs?: number; leg2EvidenceAgeMs?: number; pairSkewMs?: number;
  planEvidenceAgeMs?: number;
  routeShape: readonly unknown[]; pools: readonly (readonly string[])[];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function integer(value: string): bigint { if (!/^\d+$/.test(value)) throw new Error('MALFORMED_ATOMIC_AMOUNT'); return BigInt(value); }
const floor = (n: bigint, d: bigint) => n >= 0n ? n / d : -((-n + d - 1n) / d);

/** Diagnostic only. No caller can use this object to authorize execution. */
export function economicBreakdown(input: BreakdownInput) {
  const { routeShape, pools, ...fields } = input;
  const missingFields = (['baseFeeLamports','priorityFeeLamports','ataRentLamports','solToUsdcPriceMicrounits','costSourceAgeMs','leg1EvidenceAgeMs','leg2EvidenceAgeMs','pairSkewMs'] as const).filter(key=>input[key]===undefined);
  const base = { ...fields, schemaVersion: 1 as const, breakdownId: randomUUID(), executablePolicyHash: EXECUTABLE_POLICY_HASH,
    breakdownCompleteness: missingFields.length ? 'PARTIAL' as const : 'FULL' as const, missingFields:Object.freeze(missingFields),
    calculatedAtMonoMs: performance.now(), recordedAtWallMs: Date.now(), routeShapeHash: hash(routeShape), poolSetHash: hash(pools.map(p => [...new Set(p)].sort())) };
  try {
    const size = integer(input.sizeAtomic), expected = integer(input.leg2ExpectedOutAtomic), minimum = integer(input.leg2MinOutAtomic);
    if (size <= 0n || minimum > expected) throw new Error('AMOUNT_CHAIN_INVARIANT');
    if (input.amountChainModel !== 'ATOMIC_TWO_HOP' && (integer(input.leg1MinOutAtomic) > integer(input.leg1ExpectedOutAtomic)
      || input.leg2InputAtomic !== (input.amountChainModel === 'EXPECTED_OUTPUT' ? input.leg1ExpectedOutAtomic : input.leg1MinOutAtomic))) throw new Error('AMOUNT_CHAIN_INVARIANT');
    const decimals = [input.baseCostAtomic, input.priorityCostAtomic, input.ataCostAtomic, input.otherCostAtomic, input.minNetThresholdAtomic];
    if (decimals.some(v => !/^\d+(\.\d{1,50})?$/.test(v))) throw new Error('MISSING_OR_INVALID_COST');
    const places = Math.max(...decimals.map(v => v.split('.')[1]?.length ?? 0));
    const scale = 10n ** BigInt(places);
    const units = (v: string) => { const [a, b = ''] = v.split('.'); return BigInt(a!) * scale + BigInt(b.padEnd(places, '0') || '0'); };
    const [baseCost, priority, rent, other, minNet] = decimals.map(units) as [bigint,bigint,bigint,bigint,bigint];
    if (!Number.isSafeInteger(input.minRoiThresholdBps) || input.minRoiThresholdBps < 0) throw new Error('INVALID_ROI_THRESHOLD');
    const preExpected = expected - size, preMinimum = minimum - size;
    const afterNetwork = preMinimum * scale - baseCost - priority, afterRent = afterNetwork - rent, net = afterRent - other;
    const roiFailed = net * 10000n < BigInt(input.minRoiThresholdBps) * size * scale;
    const flags = Object.freeze([...(net < minNet ? ['MIN_NET_SHORTFALL'] : []), ...(roiFailed ? ['MIN_ROI_SHORTFALL'] : []), 'VENUE_FEES_EMBEDDED', 'MIN_OUTPUT_APPLIED_ONCE']);
    let economicOutcome: EconomicOutcome;
    let unattributedReason: string | undefined;
    if (preExpected <= 0n) economicOutcome = 'EXEC_SURFACE_EXPECTED_NONPOSITIVE';
    else if (preMinimum <= 0n) economicOutcome = 'MIN_OUTPUT_PROPAGATION_LOSS';
    else if (afterNetwork <= 0n) economicOutcome = 'NETWORK_COST_DOMINATED';
    else if (afterRent <= 0n) economicOutcome = 'ATA_RENT_DOMINATED';
    else if (net <= 0n) { economicOutcome = 'UNATTRIBUTED_ECONOMICS'; unattributedReason = 'OTHER_COST_DOMINATED'; }
    else if (net < minNet) economicOutcome = 'MIN_NET_THRESHOLD_SHORTFALL';
    else if (roiFailed) economicOutcome = 'MIN_ROI_THRESHOLD_SHORTFALL';
    else economicOutcome = 'EXEC_SURFACE_POSITIVE';
    if (input.amountChainModel === 'EXPECTED_OUTPUT' && net > 0n) economicOutcome = 'BROAD_ROUND_TRIP_POSITIVE';
    return Object.freeze({ ...base, economicOutcome, unattributedReason, secondaryFlags: flags,
      costAtomicScale: scale.toString(), totalCostScaledAtomic: (baseCost + priority + rent + other).toString(),
      totalCostUsdcAtomic: ((baseCost + priority + rent + other + scale - 1n) / scale).toString(),
      preCostExpectedFinalAtomic: expected.toString(), preCostEnforceableFinalAtomic: minimum.toString(),
      preCostExpectedNetAtomic: preExpected.toString(), preCostEnforceableNetAtomic: preMinimum.toString(),
      postCostExpectedNetAtomic: floor(preExpected * scale - baseCost - priority - rent - other, scale).toString(),
      postCostConservativeNetAtomic: floor(net, scale).toString(), postCostConservativeNetScaledAtomic: net.toString(),
      conservativeRoiBps: Number(net * 10000n / (size * scale)) });
  } catch (error) {
    return Object.freeze({ ...base, economicOutcome: 'UNATTRIBUTED_ECONOMICS' as EconomicOutcome,
      totalCostUsdcAtomic: undefined, postCostConservativeNetAtomic: undefined, conservativeRoiBps: undefined,
      preCostExpectedNetAtomic: undefined, preCostEnforceableNetAtomic: undefined, postCostExpectedNetAtomic: undefined,
      unattributedReason: error instanceof Error ? error.message : 'INVALID_NUMERIC_EVIDENCE', secondaryFlags: Object.freeze([] as string[]) });
  }
}
export type EconomicBreakdownV1 = ReturnType<typeof economicBreakdown>;

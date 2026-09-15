import { SOURCE_LANES, type SourceLane } from '../execution/source-lane.js';
import { EXECUTABLE_PROVIDER_PAIRS } from '../execution/executable-route-policy.js';

export type CoverageState = 'FULL' | 'PARTIAL' | 'UNAVAILABLE' | 'NOT_OBSERVED';
export type DispatchCoverage = 'EXACT_NETWORK_DISPATCH' | 'LOGICAL_PROVIDER_CALL_ONLY' | 'EVALUATION_ONLY' | 'UNAVAILABLE';
export function routeSurface(pair: string) {
  const providers = pair.split('->');
  if (pair === 'orca->orca') return 'ORCA_CROSS_POOL';
  const aggregators = providers.filter(p => p === 'jupiter' || p === 'raptor').length;
  return aggregators === 2 ? 'AGGREGATOR' : aggregators === 1 ? 'MIXED' : 'DIRECT';
}
interface Cycle { sourceLane: SourceLane; providerPair: string; fresh?: boolean; policyCompatible?: boolean; positive?: boolean; outcome: string; missingFields: readonly string[] }
interface Row { cycles: number; freshKnown: number; fresh: number; policyKnown: number; policy: number; positiveKnown: number; positives: number; outcomes: Record<string,number>; missing: Set<string> }
/** Reads local observations only. It cannot request or schedule any market work. */
export class MeasurementCoverage {
  private rows = new Map<string, Row>();
  cycle(c: Cycle) {
    const key = `${c.sourceLane}:${c.providerPair}`;
    const row = this.rows.get(key) ?? { cycles:0, freshKnown:0, fresh:0, policyKnown:0, policy:0, positiveKnown:0, positives:0, outcomes:{}, missing:new Set<string>() };
    row.cycles++;
    if (c.fresh !== undefined) { row.freshKnown++; row.fresh += Number(c.fresh); }
    if (c.policyCompatible !== undefined) { row.policyKnown++; row.policy += Number(c.policyCompatible); }
    if (c.positive !== undefined) { row.positiveKnown++; row.positives += Number(c.positive); }
    row.outcomes[c.outcome]=(row.outcomes[c.outcome]??0)+1;
    for (const field of c.missingFields) row.missing.add(field);
    this.rows.set(key,row);
  }
  snapshot() {
    const keys = new Set([...this.rows.keys(), ...SOURCE_LANES.map(lane=>`${lane}:UNOBSERVED`),
      ...[...EXECUTABLE_PROVIDER_PAIRS,'orca->orca'].map(pair=>`BROAD_MATRIX:${pair.replace(/:/g,'->')}`)]);
    const surfaces = [...keys].filter(key => !key.endsWith(':UNOBSERVED') || ![...this.rows.keys()].some(k=>k.startsWith(key.split(':')[0]+':'))).map(key => {
      const [sourceLane, providerPair] = key.split(':') as [SourceLane,string];
      const row=this.rows.get(key);
      const missingFields=[...(row?.missing??[])];
      if (!row || row.freshKnown !== row.cycles) missingFields.push('freshCycles');
      if (!row || row.policyKnown !== row.cycles) missingFields.push('policyCompatibleCycles');
      // Requests may be shared across cycles; never attribute a shared first leg twice.
      missingFields.push('cycleAttributedLogicalCalls','cycleAttributedNetworkDispatches');
      return { sourceLane, providerPair, surface: providerPair==='UNOBSERVED'?null:routeSurface(providerPair),
        coverageState: (row ? 'PARTIAL' : 'NOT_OBSERVED') as CoverageState,
        dispatchCoverage: (row ? 'EVALUATION_ONLY' : 'UNAVAILABLE') as DispatchCoverage,
        logicalCalls:null, networkDispatches:null, legalSends:null, successfulResponses:null,
        completedTwoLegCycles:row?.cycles??null, freshCycles:row&&row.freshKnown===row.cycles?row.fresh:null,
        policyCompatibleCycles:row&&row.policyKnown===row.cycles?row.policy:null,
        positives:row&&row.positiveKnown===row.cycles?row.positives:null, terminalOutcomes:row?{...row.outcomes}:null,
        missingFields, denominatorUsed:row?'COMPLETED_TWO_LEG_CYCLES':null,
        comparisonEligible:!!row&&missingFields.length===2,
        comparisonIneligibleReason:!row?'NOT_OBSERVED':missingFields.length>2?'INCOMPLETE_ECONOMIC_OR_FRESHNESS_EVIDENCE':null };
    });
    const reasons=surfaces.filter(s=>s.coverageState!=='FULL').map(s=>`${s.sourceLane}:${s.providerPair}:${s.coverageState}`);
    return { surfaces, wholeBotConclusionEligible:reasons.length===0, wholeBotConclusionIneligibleReasons:reasons };
  }
}
export function compatibleDenominators(a:{denominatorUsed:string|null;comparisonEligible:boolean},b:{denominatorUsed:string|null;comparisonEligible:boolean}) {
  return a.comparisonEligible && b.comparisonEligible && a.denominatorUsed!==null && a.denominatorUsed===b.denominatorUsed;
}

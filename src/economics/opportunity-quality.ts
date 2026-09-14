import { AsyncLocalStorage } from 'node:async_hooks';
import { SOURCE_LANES, telemetryRun, type SourceLane } from '../execution/source-lane.js';
import type { EconomicBreakdownV1 } from './economic-breakdown.js';
import { economicComparison, type EconomicTelemetryValue } from './economic-telemetry.js';
import { economicDiagnosticBuffer } from '../diagnostics/economic-diagnostics.js';

export const sourceLaneContext = new AsyncLocalStorage<SourceLane>();
export class OpportunityQuality {
  constructor(private readonly persist: (record: unknown, critical: boolean) => void = (record, critical) => economicDiagnosticBuffer.enqueue(record, critical)) {}
  private counts = new Map<string, Record<string, number>>();
  private seen = new Set<string>();
  private samples: EconomicBreakdownV1[] = [];
  private outcomes: Record<string, number> = {};
  private byCandidate = new Map<string, EconomicBreakdownV1>();
  private criticalCandidates = new Set<string>();
  private executorResults = new Map<string,string>();
  private comparisons: ReturnType<typeof economicComparison>[] = [];
  private latencies = new Map<string, number[]>();
  timing(lane: SourceLane, provider: string, ms: number) {
    const key=`${lane}:${provider}`, values=this.latencies.get(key)??[];
    values.push(ms);this.latencies.set(key,values.slice(-2000));
  }
  count(lane: SourceLane, provider: string, name: string) {
    const key = `${lane}:${provider}`, row = this.counts.get(key) ?? {};
    row[name] = (row[name] ?? 0) + 1; this.counts.set(key, row);
  }
  record(b: EconomicBreakdownV1) {
    const key = `${b.candidateId ?? b.breakdownId}:${b.modelVersion}`;
    if (this.seen.has(key)) return;
    this.seen.add(key); while (this.seen.size > 100000) this.seen.delete(this.seen.values().next().value!);
    const shadow = b.sourceLane === 'ABOVE_CAP_SHADOW';
    const constrained = b.amountChainModel !== 'EXPECTED_OUTPUT' && !shadow;
    if (constrained) this.outcomes[b.economicOutcome] = (this.outcomes[b.economicOutcome] ?? 0) + 1;
    this.count(b.sourceLane, b.providerPair, shadow ? 'shadowEconomicClassifications' : constrained ? 'economicClassifications' : 'broadEconomicClassifications');
    const numericEvidenceValid = b.preCostEnforceableNetAtomic !== undefined;
    if (numericEvidenceValid) this.count(b.sourceLane,b.providerPair,'completedCompatibleCycles');
    if(numericEvidenceValid && b.freshCompatible)this.count(b.sourceLane,b.providerPair,'freshCompatibleCycles');
    if(numericEvidenceValid && b.routePolicyCompatible)this.count(b.sourceLane,b.providerPair,'policyCompatibleCycles');
    if (shadow && b.economicOutcome === 'EXEC_SURFACE_POSITIVE') this.count(b.sourceLane, b.providerPair, 'shadowConstrainedPositives');
    if (constrained && b.economicOutcome === 'EXEC_SURFACE_POSITIVE') this.count(b.sourceLane, b.providerPair, 'executablePositives');
    this.samples.push(b); this.samples = this.samples.slice(-2000);
    if (b.candidateId) this.byCandidate.set(b.candidateId, b);
    while (this.byCandidate.size > 10000) this.byCandidate.delete(this.byCandidate.keys().next().value!);
    const critical = b.economicOutcome === 'EXEC_SURFACE_POSITIVE' || b.economicOutcome === 'UNATTRIBUTED_ECONOMICS' || b.economicOutcome === 'BROAD_ROUND_TRIP_POSITIVE';
    if(critical&&b.candidateId){this.criticalCandidates.add(b.candidateId);while(this.criticalCandidates.size>10000)this.criticalCandidates.delete(this.criticalCandidates.values().next().value!);}
    if (critical || this.seen.size % 10 === 0 || b.sourceLane === 'UNRESTRICTED_CONTROL') this.persist(b, critical);
  }
  bind(candidateId: string, executionId: string) {
    const b = this.byCandidate.get(candidateId); if (b) this.byCandidate.set(executionId, b);
  }
  executor(executionId: string, b: EconomicTelemetryValue) {
    const scanner = this.byCandidate.get(executionId);
    if (!scanner) { this.persist({ kind: 'UNMATCHED_EXECUTOR_BREAKDOWN', executionId, breakdown: b }, true); return; }
    const comparison = economicComparison(scanner, b);
    this.comparisons.push(comparison); this.comparisons = this.comparisons.slice(-1000);
    this.persist(comparison, true);
  }
  stage(executionId: string, stage: string) {
    const b = this.byCandidate.get(executionId); if (!b) return;
    this.count(b.sourceLane, b.providerPair, stage);
    this.executorResults.set(executionId,stage);while(this.executorResults.size>1000)this.executorResults.delete(this.executorResults.keys().next().value!);
    if (stage === 'P0_HANDOFF' || stage === 'READY_TO_EXECUTE') this.persist({ stage, executionId, breakdownId: b.breakdownId }, true);
  }
  terminal(candidateId: string, outcome: string, reason: string | undefined, trace: unknown, comparison?: unknown) {
    const prior=this.byCandidate.get(candidateId);
    this.persist({kind:'OBSERVATION_TERMINAL',candidateId,outcome,reason,trace,comparison,breakdownId:prior?.breakdownId},this.criticalCandidates.has(candidateId));
  }
  snapshot() {
    const total = Object.values(this.outcomes).reduce((a,b) => a+b, 0);
    const lanes = SOURCE_LANES.map(lane => {
      const providers = Object.fromEntries([...this.counts].filter(([k]) => k.startsWith(lane + ':')).map(([k,v]) => [k.slice(lane.length+1), {...v}]));
      const sum = (name: string) => Object.values(providers).reduce((a,b) => a+(b[name] ?? 0),0);
      const calls=sum('providerCalls'), sends=sum('legalSends'), cycles=sum('economicClassifications'), positives=sum('executablePositives'),freshCycles=sum('freshCompatibleCycles');
      const samples=this.samples.filter(b=>b.sourceLane===lane);
      const stats=(values:number[])=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return {count:sorted.length,max:sorted.at(-1)??null,p50:sorted.length>=20?sorted[Math.ceil(sorted.length*.5)-1]:null,p90:sorted.length>=20?sorted[Math.ceil(sorted.length*.9)-1]:null,p99:sorted.length>=100?sorted[Math.ceil(sorted.length*.99)-1]:null};};
      const atomicStats=(values:Array<string|undefined>)=>{const sorted=values.filter((v):v is string=>v!==undefined&&/^-?\d+$/.test(v)).map(BigInt).sort((a,b)=>a<b?-1:a>b?1:0);return {count:sorted.length,max:sorted.at(-1)?.toString()??null,p50:sorted.length>=20?sorted[Math.ceil(sorted.length*.5)-1]!.toString():null,p90:sorted.length>=20?sorted[Math.ceil(sorted.length*.9)-1]!.toString():null,p99:sorted.length>=100?sorted[Math.ceil(sorted.length*.99)-1]!.toString():null};};
      return { lane, providers, providerCalls:calls, legalSends:sends, completedEconomicEvaluations:cycles, executablePositives:positives,
        plannedTurns:sum('plannedTurns'),completedTurns:sum('completedTurns'),completedCompatibleCycles:sum('completedCompatibleCycles'),freshCompatibleCycles:freshCycles,policyCompatibleCycles:sum('policyCompatibleCycles'),
        deadlineDropsPer1000Calls:calls?1000*sum('deadlineDrops')/calls:null,http429Per1000Calls:calls?1000*sum('http429')/calls:null,
        p0PerExecutablePositive:positives?sum('P0_HANDOFF')/positives:null,
        evidenceAgeMs:stats(samples.flatMap(b=>b.leg1EvidenceAgeMs === undefined || b.leg2EvidenceAgeMs === undefined ? [] : [Math.max(b.leg1EvidenceAgeMs,b.leg2EvidenceAgeMs)])),pairSkewMs:stats(samples.flatMap(b=>b.pairSkewMs === undefined ? [] : [b.pairSkewMs])),
        providerTimeMs:stats([...this.latencies].filter(([k])=>k.startsWith(lane+':')).flatMap(([,values])=>values)),
        sampleCoverage: [...new Set(samples.map(b=>`${b.providerPair}:${b.intermediateMint}:${b.sizeAtomic}`))],
        economicDistributions: Object.fromEntries((['preCostExpectedNetAtomic','preCostEnforceableNetAtomic','baseFeeLamports','priorityFeeLamports','ataRentLamports','totalCostUsdcAtomic','postCostConservativeNetAtomic'] as const).map(key=>[key,atomicStats(samples.map(b=>b[key]))])),
        roiBps:stats(samples.flatMap(b=>b.conservativeRoiBps===undefined?[]:[b.conservativeRoiBps])),
        positivesPer1000Calls:calls?1000*positives/calls:null, positivesPer1000Sends:sends?1000*positives/sends:null,
        freshCyclesPer1000Calls:calls?1000*freshCycles/calls:null, positivesPer1000Cycles:freshCycles?1000*positives/freshCycles:null };
    });
    return { ...telemetryRun, lanes, completedEconomics: total,
      accountingCoverage: { providerCalls: 'logical quote calls through labeled scanner/prefilter/refresh wrappers; coalesced callers remain separate',
        legalSends: 'labeled Jupiter/Raptor quote dispatch only; direct RPC and unlabeled background calls are not included',
        providerTimeMs: 'logical call end-to-end, including queue residence; not HTTP service latency',
        directEconomicDetail: 'Orca cross-pool currently exposes cycle counts only; no full per-cycle breakdown' },
      blockers: Object.entries(this.outcomes).map(([outcome,count]) => ({outcome,count,percent:total>=20?count*100/total:null})),
      nearest: [...this.samples].filter(b=>b.postCostConservativeNetAtomic!==undefined).sort((a,b)=>BigInt(a.postCostConservativeNetAtomic!)>BigInt(b.postCostConservativeNetAtomic!)?-1:1).slice(0,10),
      distributionRetention:'most recent 2000 economic observations, split by source; totals are cumulative', comparisons:[...this.comparisons], executorResults:Object.fromEntries(this.executorResults), diagnostics:economicDiagnosticBuffer.snapshot() };
  }
}
export const opportunityQuality = new OpportunityQuality();
/** Exact lane tagging only; no queue, retry, limiter, route selection or extra quote. */
export async function measuredProviderCall<T>(lane: SourceLane, provider: string, work: () => Promise<T>): Promise<T> {
  opportunityQuality.count(lane, provider, 'providerCalls');
  const started=performance.now();
  return sourceLaneContext.run(lane, async () => {
    try { const result=await work(); opportunityQuality.count(lane,provider,'quoteSuccesses'); return result; }
    catch (error) { opportunityQuality.count(lane,provider,'quoteFailures'); throw error; }
    finally { opportunityQuality.timing(lane,provider,performance.now()-started); }
  });
}

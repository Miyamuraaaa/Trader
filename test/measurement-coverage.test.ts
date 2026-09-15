import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { MeasurementCoverage, compatibleDenominators, routeSurface } from '../src/economics/measurement-coverage.js';
import { orcaObservation } from '../src/economics/orca-observation.js';
import { EconomicDiagnosticBuffer } from '../src/diagnostics/economic-diagnostics.js';
import type { OrcaCrossPoolEvaluation } from '../src/orca-cross-pool.js';

it.each([['jupiter->raptor','AGGREGATOR'],['jupiter->orca','MIXED'],['orca->jupiter','MIXED'],['raydium->meteora','DIRECT'],['orca->orca','ORCA_CROSS_POOL']])('labels %s without network work',(pair,surface)=>expect(routeSurface(pair!)).toBe(surface));
it('covers every source and keeps unavailable dispatch counts null',()=>{
  const c=new MeasurementCoverage();c.cycle({sourceLane:'BROAD_MATRIX',providerPair:'jupiter->orca',fresh:true,policyCompatible:true,positive:false,outcome:'NETWORK_COST_DOMINATED',missingFields:[]});
  const s=c.snapshot();expect(new Set(s.surfaces.map(r=>r.sourceLane)).size).toBe(6);
  const mixed=s.surfaces.find(r=>r.providerPair==='jupiter->orca');
  expect(mixed).toMatchObject({coverageState:'PARTIAL',dispatchCoverage:'EVALUATION_ONLY',networkDispatches:null,legalSends:null,completedTwoLegCycles:1,positives:0});
  expect(s.wholeBotConclusionEligible).toBe(false);expect(s.wholeBotConclusionIneligibleReasons.length).toBeGreaterThan(0);
});
it('never compares different denominator kinds or incomplete evidence',()=>{
  expect(compatibleDenominators({denominatorUsed:'LOGICAL_PROVIDER_CALLS',comparisonEligible:true},{denominatorUsed:'LEGAL_SENDS',comparisonEligible:true})).toBe(false);
  expect(compatibleDenominators({denominatorUsed:'COMPLETED_TWO_LEG_CYCLES',comparisonEligible:false},{denominatorUsed:'COMPLETED_TWO_LEG_CYCLES',comparisonEligible:true})).toBe(false);
});
it('copies partial Orca economics without inventing component costs or timestamps',()=>{
  const e={firstPool:'a',secondPool:'b',intermediateMint:'token',inputAmount:100000n,expectedOutputAmount:102000n,minimumOutputAmount:101000n,projectedNetAmount:1500n,conservativeNetAmount:500n,detectedAt:100,executionEligible:false} as OrcaCrossPoolEvaluation;
  const b=orcaObservation(e);expect(b).toMatchObject({breakdownCompleteness:'PARTIAL',observedTotalCostUsdcAtomic:'500',economicOutcome:'UNATTRIBUTED_ECONOMICS'});
  expect(b).not.toHaveProperty('baseFeeLamports');expect(b).not.toHaveProperty('leg1MinOutAtomic');expect(b).not.toHaveProperty('pairSkewMs');expect(b.missingFields).toContain('ataRentLamports');
  expect(orcaObservation({...e,conservativeNetAmount:501n}).observedTotalCostUsdcAtomic).toBeNull();
});
it('ordinary loss alone is valid; critical loss and writes failing invalidate only evidence',async()=>{
  const write=vi.fn(async()=>{});const q=new EconomicDiagnosticBuffer(write,1,1);
  q.enqueue('ordinary',false);q.enqueue('ordinary-drop',false);expect(write).not.toHaveBeenCalled();
  await q.flush();expect(q.snapshot(true)).toMatchObject({diagnosticEvidenceValid:true,ordinaryDropCount:1,pendingCriticalAtFinalize:0});
  q.enqueue('critical',true);q.enqueue('critical-overflow',true);expect(q.snapshot().invalidReasons).toContain('CRITICAL_DIAGNOSTIC_OVERFLOW');await q.flush();
  const failed=new EconomicDiagnosticBuffer(async()=>{throw new Error('fixture');});failed.enqueue('critical',true);await failed.flush();
  expect(failed.snapshot(true)).toMatchObject({diagnosticEvidenceValid:false,writeFailureCount:1,pendingCriticalAtFinalize:1,lastSuccessfulDiagnosticWriteAt:null});
});
it('passive helpers import no quote/RPC scheduler and production authority remains unchanged',async()=>{
  for(const name of ['measurement-coverage','orca-observation']){
    const source=await readFile(`src/economics/${name}.ts`,'utf8');
    expect(source).not.toMatch(/\b(fetch|setInterval|setTimeout|getQuote|getAccountInfo|sendTransaction)\s*\(/);
  }
  expect(await readFile('src/scanner.ts','utf8')).toContain('executableSurfaceTurn++ % 10 !== 9');
  expect(await readFile('src/live-execution-worker.ts','utf8')).toContain('await autoExecute(prepared)');
});

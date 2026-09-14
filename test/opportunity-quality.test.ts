import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { economicBreakdown, type BreakdownInput } from '../src/economics/economic-breakdown.js';
import { ExecutionFunnel } from '../src/execution/execution-funnel.js';
import { EconomicDiagnosticBuffer } from '../src/diagnostics/economic-diagnostics.js';
import { telemetryRun, LEGACY_COHORT_WARNING } from '../src/execution/source-lane.js';
import { parseSoakArguments } from '../src/soak-controls.js';
import { calculateExecutorEconomics } from '../src/execution/handoff-validator.js';
import { executorBreakdown } from '../src/economics/executor-breakdown.js';
import { scannerBreakdown } from '../src/economics/scanner-breakdown.js';
import type { RoundTripResult } from '../src/routes.js';
import { OpportunityQuality } from '../src/economics/opportunity-quality.js';
import { EconomicTelemetry, economicComparison } from '../src/economics/economic-telemetry.js';
import type { AtomicExecutionPlan, SimulationResult } from '../src/execution/types.js';

const input: BreakdownInput = { sourceLane:'EXECUTABLE_FAST_LANE', modelAuthority:'SCANNER_ADVISORY', modelVersion:'TEST',
  providerPair:'jupiter->raptor', sizeAtomic:'100000', baseMint:'TEST_BASE', intermediateMint:'TEST_TOKEN',
  leg1ExpectedOutAtomic:'1000',leg1MinOutAtomic:'990',leg2InputAtomic:'990',leg2ExpectedOutAtomic:'110000',leg2MinOutAtomic:'109000',
  baseCostAtomic:'100',priorityCostAtomic:'100',ataCostAtomic:'0',otherCostAtomic:'0',minNetThresholdAtomic:'100',minRoiThresholdBps:10,
  leg1EvidenceAgeMs:100,leg2EvidenceAgeMs:0,pairSkewMs:100,routeShape:['jupiter','raptor'],pools:[['a'],['b']] };
describe('diagnostic economic waterfall, never execution authority',()=>{
  it.each([
    [{leg2ExpectedOutAtomic:'100000',leg2MinOutAtomic:'99000'},'EXEC_SURFACE_EXPECTED_NONPOSITIVE'],
    [{leg2MinOutAtomic:'100000'},'MIN_OUTPUT_PROPAGATION_LOSS'],
    [{baseCostAtomic:'8900'},'NETWORK_COST_DOMINATED'],
    [{ataCostAtomic:'8800'},'ATA_RENT_DOMINATED'],
    [{minNetThresholdAtomic:'8801'},'MIN_NET_THRESHOLD_SHORTFALL'],
    [{minRoiThresholdBps:881},'MIN_ROI_THRESHOLD_SHORTFALL'],
    [{minNetThresholdAtomic:'8801',minRoiThresholdBps:881},'MIN_NET_THRESHOLD_SHORTFALL'],
    [{minNetThresholdAtomic:'8800',minRoiThresholdBps:880},'EXEC_SURFACE_POSITIVE'],
    [{leg2InputAtomic:'1000'},'UNATTRIBUTED_ECONOMICS'],
    [{baseCostAtomic:'NaN'},'UNATTRIBUTED_ECONOMICS'],
  ] as const)('classifies %j as %s',(patch,outcome)=>expect(economicBreakdown({...input,...patch}).economicOutcome).toBe(outcome));
  it('retains fractional atomic costs for exact equality tests',()=>{
    expect(economicBreakdown({...input,baseCostAtomic:'100.1',minNetThresholdAtomic:'8800',minRoiThresholdBps:0}).economicOutcome).toBe('MIN_NET_THRESHOLD_SHORTFALL');
    expect(economicBreakdown({...input,baseCostAtomic:'100.1',minNetThresholdAtomic:'8799.9',minRoiThresholdBps:0}).economicOutcome).toBe('EXEC_SURFACE_POSITIVE');
  });
  it('does not subtract embedded venue fees or slippage twice',()=>{
    const result=economicBreakdown(input);
    expect(result.postCostConservativeNetAtomic).toBe('8800');
    expect(result.postCostExpectedNetAtomic).toBe('9800');
    expect(result.secondaryFlags).toContain('MIN_OUTPUT_APPLIED_ONCE');
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('keeps ROI shortfall secondary when minimum net fails first',()=>expect(economicBreakdown({...input,minNetThresholdAtomic:'9000',minRoiThresholdBps:1000}).secondaryFlags).toContain('MIN_ROI_SHORTFALL'));
  it('distinguishes broad expected-output propagation without relaxing constrained propagation',()=>{
    expect(economicBreakdown({...input,amountChainModel:'EXPECTED_OUTPUT',leg2InputAtomic:'1000'}).economicOutcome).toBe('BROAD_ROUND_TRIP_POSITIVE');
    expect(economicBreakdown({...input,leg2InputAtomic:'1000'}).economicOutcome).toBe('UNATTRIBUTED_ECONOMICS');
  });
});
const trace={rawPositiveDetectedAt:1000,rawQuoteEvidenceAt:999,rawQuoteAgeAtDetectionMs:1,executablePrefilterQueuedAt:1000,executablePrefilterStartedAt:1000,prefilterFinishedAt:1100};
describe('truthful independent cohorts',()=>{
  it('reconciles broad-to-constrained positive once, not once per cohort',()=>{
    const f=new ExecutionFunnel(()=>1100);f.raw.register('shared',trace);f.raw.finish('shared','EXECUTABLE_CANDIDATE',trace);
    f.startExecutableObservation('shared',trace);f.finishExecutableObservation('shared','EXECUTABLE_CANDIDATE',trace);
    f.record({identity:'shared',stage:'EXECUTABLE_CANDIDATE',at:1100,detectedAt:1000});
    expect(f.snapshot().session.EXEC_SURFACE_POSITIVE).toBe(1);
    expect(f.snapshot().executableObservations.session).not.toHaveProperty('RAW_POSITIVE');
  });
  it.each(['ROUTE_POLICY_REJECTED','PREFILTER_QUEUE_DEADLINE_EXCEEDED','EXEC_SURFACE_EXPECTED_NONPOSITIVE'])('one-leg attempt and %s never count as broad positive',result=>{
    const funnel=new ExecutionFunnel(()=>1100);funnel.startExecutableObservation('one-leg',trace);funnel.finishExecutableObservation('one-leg',result,trace);
    const s=funnel.snapshot();expect(s.session.RAW_POSITIVE??0).toBe(0);expect(s.session.BROAD_ROUND_TRIP_POSITIVE??0).toBe(0);
    expect(s.executableObservations.observations).toBe(1);expect(s.executableObservations.buckets[result]).toBe(1);expect(s.executableObservations.unreconciled).toBe(0);
  });
  it('counts true broad positives once and cannot overwrite fast positives with raw cohort counts',()=>{
    const f=new ExecutionFunnel(()=>1100);
    f.record({identity:'b',stage:'RAW_POSITIVE',at:1000,detectedAt:1000});f.record({identity:'b',stage:'RAW_POSITIVE',at:1000,detectedAt:1000});
    f.raw.register('b',trace);f.raw.finish('b','ECONOMICS_DIVERGED',trace);
    f.startExecutableObservation('e',trace);f.finishExecutableObservation('e','EXECUTABLE_CANDIDATE',trace);
    expect(f.snapshot().session).toMatchObject({RAW_POSITIVE:1,BROAD_ROUND_TRIP_POSITIVE:1,EXEC_SURFACE_POSITIVE:1,EXECUTOR_CONSTRAINED_POSITIVE:1});
    expect(f.snapshot().last15m.EXECUTOR_CONSTRAINED_POSITIVE).toBe(1);
  });
  it('surfaces duplicate and missing terminals',()=>{
    const f=new ExecutionFunnel(()=>1100);f.startExecutableObservation('x',trace);f.finishExecutableObservation('x','QUOTE_FAILED',trace);f.finishExecutableObservation('x','QUOTE_FAILED',trace);
    f.startExecutableObservation('y',trace);f.executable.shutdown();
    expect(f.snapshot().executableObservations).toMatchObject({duplicateTerminalCount:1,missingTerminalCount:1});
  });
  it('versions corrected cohorts and warns about historical interpretation',()=>{
    const s=new ExecutionFunnel().snapshot();expect(s.telemetrySchemaVersion).toBe(2);expect(s.runId).toBe(telemetryRun.runId);expect(s.legacyWarning).toBe(LEGACY_COHORT_WARNING);
  });
});
describe('source-lane accounting and comparison',()=>{
  it('numeric diagnostics cannot label a rejected scanner observation executable-positive',()=>{
    const buy={provider:'jupiter',inputMint:'BASE',outputMint:'TOKEN',inAmount:'100000',outAmount:'1000',otherAmountThreshold:'990',responseTimestamp:Date.now(),poolIds:[],routePlan:[]};
    const sell={...buy,provider:'raptor',inputMint:'TOKEN',outputMint:'BASE',inAmount:'990',outAmount:'120000',otherAmountThreshold:'119000'};
    const route={buyQuote:buy,sellQuote:sell,stale:false,liquidityOverlap:null,validationTier:'OBSERVATION'} as unknown as RoundTripResult;
    const b=scannerBreakdown(route,{baseNetworkFeeUsdc:0,priorityFeeUsdc:0},'EXECUTABLE_FAST_LANE');
    expect(b.economicOutcome).toBe('UNATTRIBUTED_ECONOMICS');expect(b.unattributedReason).toBe('SCANNER_DECISION_MISMATCH');
    const q=new OpportunityQuality(()=>{});q.record(b);expect(q.snapshot().lanes.find(l=>l.lane==='EXECUTABLE_FAST_LANE')?.executablePositives).toBe(0);
  });
  it('separates broad/control, shadow and constrained positives without double-counting models',()=>{
    const persist=vi.fn();const q=new OpportunityQuality(persist);
    const broad=economicBreakdown({...input,candidateId:'x',sourceLane:'UNRESTRICTED_CONTROL',amountChainModel:'EXPECTED_OUTPUT',leg2InputAtomic:'1000',modelVersion:'broad'});
    const constrained=economicBreakdown({...input,candidateId:'x',sourceLane:'UNRESTRICTED_CONTROL',modelVersion:'constrained'});
    q.record(broad);q.record(constrained);q.record(constrained);
    q.record(economicBreakdown({...input,candidateId:'shadow',sourceLane:'ABOVE_CAP_SHADOW'}));
    const s=q.snapshot();expect(s.completedEconomics).toBe(1);
    expect(s.lanes.find(l=>l.lane==='UNRESTRICTED_CONTROL')?.executablePositives).toBe(1);
    expect(s.lanes.find(l=>l.lane==='ABOVE_CAP_SHADOW')?.executablePositives).toBe(0);
    expect(persist).toHaveBeenCalledTimes(3);
  });
  it('same normalized complete shape compares equal, missing shape compares unknown',()=>{
    const a=economicBreakdown({...input,routeShapeEvidenceComplete:true});
    const b=EconomicTelemetry.parse(economicBreakdown({...input,modelAuthority:'EXECUTOR_AUTHORITATIVE',routeShapeEvidenceComplete:true}));
    expect(economicComparison(a,b)).toMatchObject({routeShapeChanged:false,poolSetChanged:false,conservativeNetDelta:'0',marketMovementComparable:true});
    expect(economicComparison(a,{...b,routeShapeEvidenceComplete:false}).routeShapeChanged).toBeNull();
  });
  it('unknown scanner components stay null and never become invented executor deltas',()=>{
    const a=economicBreakdown(input),b=EconomicTelemetry.parse(economicBreakdown({...input,modelAuthority:'EXECUTOR_AUTHORITATIVE',baseFeeLamports:'5000'}));
    expect(economicComparison(a,b).baseFeeDelta).toBeNull();
  });
  it('Orca combined atomic minimum needs no invented independently enforced leg1 minimum',()=>{
    const b=economicBreakdown({...input,amountChainModel:'ATOMIC_TWO_HOP',leg1MinOutAtomic:'',leg2InputAtomic:''});
    expect(b.economicOutcome).toBe('EXEC_SURFACE_POSITIVE');expect(b.leg1MinOutAtomic).toBe('');
  });
});
describe('bounded diagnostic persistence',()=>{
  it('never invokes disk work inline, prioritizes critical detail over ordinary samples',async()=>{
    const seen:unknown[]=[];const writer=vi.fn(async(r:unknown)=>{seen.push(r);});const q=new EconomicDiagnosticBuffer(writer,1,3);
    q.enqueue('ordinary',false);q.enqueue('ordinary-drop',false);q.enqueue('P0',true);expect(writer).not.toHaveBeenCalled();
    await q.flush();expect(seen).toEqual(['P0','ordinary']);expect(q.snapshot()).toMatchObject({ordinaryDropped:1,criticalOverflow:0,valid:true});
  });
  it('retains failed critical write and invalidates evidence without affecting execution stores',async()=>{
    const q=new EconomicDiagnosticBuffer(async()=>{throw new Error('TEST_DISK_FAILURE');});q.enqueue('critical',true);await q.flush();
    expect(q.snapshot()).toMatchObject({valid:false,pendingCritical:1,writeFailures:1});
  });
  it('reports exhausted critical capacity as invalid evidence, never as lossless success',async()=>{
    const q=new EconomicDiagnosticBuffer(async()=>{},1,1);
    q.enqueue('P0',true);q.enqueue('READY-overflow',true);
    expect(q.snapshot()).toMatchObject({valid:false,criticalOverflow:1,pendingCritical:1});
    await q.flush();expect(q.snapshot().valid).toBe(false);
  });
});
it('scanner optimism is not an input to executor economics',()=>{
  const plan={inputAmount:100000n,expectedIntermediateAmount:1000000n,expectedOutputAmount:110000n,minimumOutputAmount:109000n,intermediateMint:'TEST',
    baseAta:{exists:true},intermediateAta:{exists:true},computeUnitLimit:100000,computeUnitPriceMicroLamports:0} as AtomicExecutionPlan;
  const simulation={estimatedBaseFeeLamports:5000} as SimulationResult;
  const before=calculateExecutorEconomics(plan,simulation);
  Object.assign(plan,{scannerBreakdown:{conservativeNetAtomic:'999999999999999999999',passed:true}});
  expect(calculateExecutorEconomics(plan,simulation)).toEqual(before);
});
it('executor diagnostic conversion rounding cannot invent ATA rent',()=>{
  const plan={inputAmount:100000n,expectedIntermediateAmount:1000000n,expectedOutputAmount:110000n,minimumOutputAmount:109000n,intermediateMint:'TEST',inputMint:'BASE',
    baseAta:{exists:true},intermediateAta:{exists:true},computeUnitLimit:100000,computeUnitPriceMicroLamports:12345,quoteReceivedAt:Date.now(),pools:['a','b'],type:'ATOMIC'} as unknown as AtomicExecutionPlan;
  const economics=calculateExecutorEconomics(plan,{estimatedBaseFeeLamports:6235} as SimulationResult);
  const breakdown=executorBreakdown(plan,economics,'rounding');
  expect(breakdown.ataCostAtomic).toBe('0');expect(breakdown.ataRentLamports).toBe('0');
  expect(breakdown.pairSkewMs).toBeUndefined();expect(breakdown.leg1EvidenceAgeMs).toBeUndefined();expect(breakdown.planEvidenceAgeMs).toBeGreaterThanOrEqual(0);
  expect(BigInt(breakdown.baseCostAtomic)+BigInt(breakdown.priorityCostAtomic)+BigInt(breakdown.ataCostAtomic)).toBe(economics.networkCostUsdcAtomic);
  expect(breakdown.postCostConservativeNetAtomic).toBe(economics.conservativeNetAtomic.toString());
});
it('leaves the existing 9:1 and automatic authority path intact',async()=>{
  const scanner=await readFile('src/scanner.ts','utf8'),worker=await readFile('src/live-execution-worker.ts','utf8');
  expect(scanner).toContain('executableSurfaceTurn++ % 10 !== 9');expect(worker).toContain('await autoExecute(prepared)');
  const fast=scanner.slice(scanner.indexOf('const signalId = crypto.randomUUID();'),scanner.indexOf('fastLaneRoutes.push(result.route)'));
  expect(fast).not.toContain("stage: 'RAW_POSITIVE'");expect(fast).not.toContain("rawNet: '0.000000'");
  expect(fast).toContain("result.status === 'EXECUTABLE_CANDIDATE'");expect(fast).toContain('await publishSupportedAggregatorHandoff');
});
it.each([15,30,60])('explicit comparison accepts %i minutes without weakening production-soak range',minutes=>{
  expect(parseSoakArguments(['--opportunity-quality-comparison',`--duration-minutes=${minutes}`])).toMatchObject({comparison:true,durationMs:minutes*60000});
  expect(()=>parseSoakArguments(['--duration-minutes=15'])).toThrow();
});

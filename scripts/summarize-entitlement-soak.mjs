// Offline, payload-free reporting of existing no-broadcast artifacts. No runtime/config imports.
import { readFileSync } from 'node:fs';
function percentiles(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  const at=p=>sorted[Math.ceil(sorted.length*p)-1]??null;
  return {count:sorted.length,p50:at(.5),p90:at(.9),p99:at(.99),max:sorted.at(-1)??null};
}
function summarize(path) {
  const report=JSON.parse(readFileSync(path,'utf8'));
  if(report.kind!=='PRODUCTION_SCANNER_ISOLATED_EXECUTOR_NO_BROADCAST')throw new Error('Expected completed production soak artifact');
  const samples=[...report.samples,report.snapshot],last=report.snapshot;
  const signals=[...new Map(samples.flatMap(s=>s.funnel.lastPositiveSignals).map(s=>[s.id,s])).values()];
  const providers={};
  for(const provider of ['jupiter','raptor']) {
    const requests=[...new Map(samples.flatMap(s=>s[provider].admission.requestTraces??[]).map(r=>[`${r.dispatchMono}:${r.traceId}:${r.requestClass}`,r])).values()];
    providers[provider]={final60s:last[provider].work,fullRunRequests:requests.length,
      fullRunQueueAndPacingMs:percentiles(requests.map(r=>r.queueAndPacingMs)),fullRunHttpAndParseMs:percentiles(requests.map(r=>r.httpAndParseMs)),
      constrainedRequests:requests.filter(r=>r.requestClass==='EXECUTION_PREFILTER'),entitlements:last[provider].admission.entitlements??null};
  }
  return {path,durationMs:report.durationMs,continuity:report.continuity,executorReady:last.executorReady,scannerFailed:last.scannerFailed,broadcasts:report.broadcasts,
    rawEvidenceAgeMs:percentiles(signals.map(s=>s.prefilterTrace?.rawQuoteAgeAtDetectionMs)),quoteSkewMs:'not recorded',
    funnel:last.funnel.session,reconciliation:last.funnel.rawPrefilter.last15m,providers,rpc:{http429:last.rpc.rateLimits429,cooldowns:last.rpc.totalCooldowns,skips:last.rpc.skippedDuringCooldown,failed:last.rpc.failedTasks,classes:last.rpc.classes??null},
    history:{maxSampledWriteMs:Math.max(...samples.map(s=>s.scannerHistory.writeMs.max??0)),maxSampledPersistDelayMs:Math.max(...samples.map(s=>s.scannerHistory.persistDelayMs.max??0)),final:last.scannerHistory},
    dispatch:{maxSampledP99Ms:Math.max(...samples.map(s=>s.dispatch.dispatchDrift60s.p99Ms??0)),final:last.dispatch},
    evaluationRateSampled:percentiles(samples.map(s=>s.scanner.totalRouteEvals60s)),sizes:last.sizes,pairs:last.pairs??null,
    signals:signals.map(s=>({id:s.id,providers:s.providers,inputAmount:s.inputAmount,rawNet:s.rawNet,rawWorst:s.rawWorstCase,evidenceAgeMs:s.prefilterTrace?.rawQuoteAgeAtDetectionMs,
      policyMs:s.prefilterTrace?.tokenPolicyMs,leg1Ms:s.prefilterTrace?.constrainedLeg1Ms,leg2Ms:s.prefilterTrace?.constrainedLeg2Ms,result:s.prefilterResult,reason:s.prefilterReason??'NOT_RECORDED',p0:s.p0Handoff}))};
}
if(process.argv.length<3)throw new Error('Pass explicit completed soak artifact paths');
console.log(JSON.stringify(process.argv.slice(2).map(summarize),null,2));

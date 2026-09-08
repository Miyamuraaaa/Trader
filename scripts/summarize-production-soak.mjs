// Read only diagnostic artifacts. Never loads runtime configuration or signer code.
import { readFile } from 'node:fs/promises';
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const allSamples = report.samples ?? [];
let previous = 0;
const gapIndex = allSamples.findIndex((sample) => { const gap = sample.elapsedMs - previous; previous = sample.elapsedMs; return gap > 90000 || gap < 0; });
const samples = gapIndex < 0 ? allSamples : allSamples.slice(0, gapIndex);
const last = gapIndex < 0 ? report.snapshot ?? samples.at(-1) : samples.at(-1);
if (!last) throw new Error('No diagnostic samples');
const range = (values) => {
  values = values.filter(Number.isFinite);
  return { windows: values.length, min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    mean: values.length ? values.reduce((a,b)=>a+b,0)/values.length : null };
};
const providers = Object.fromEntries(['jupiter','raptor'].map((provider) => [provider, {
  finalRolling60s: last[provider].work,
  rollingQueueP90Range: range(samples.map((s)=>s[provider].work.queueWaitP90)),
  rollingServiceP90Range: range(samples.map((s)=>s[provider].work.requestLatencyP90)),
  admission: last[provider].admission,
}]));
const signals = new Map();
for (const s of [...samples,last]) for (const signal of s.funnel.lastPositiveSignals) signals.set(signal.id, signal);
const sizes = last.sizes.map((size) => ({ ...size,
  // Cumulative snapshots must not be summed; retain each rolling-window maximum.
  maxObservedRollingCounts: Object.fromEntries([...new Set(samples.flatMap((s)=>Object.keys(s.sizes.find((x)=>x.size===size.size)?.counts??{})))].map((event)=>[
    event, Math.max(0,...samples.map((s)=>s.sizes.find((x)=>x.size===size.size)?.counts[event]??0))])),
}));
console.log(JSON.stringify({ partial: report.partial === true || gapIndex >= 0, durationMs: report.durationMs ?? report.elapsedMs,
  continuousPrefixMs:last.elapsedMs, measurementGapDetected:gapIndex >= 0,
  samples: samples.length, executorReady: last.executorReady, executorExit: last.executorExit, scannerFailed:last.scannerFailed,
  throughputRolling60s: Object.fromEntries(['totalRouteEvals60s','aggregatorFastLaneEvals60s','directLaneEvals60s','mixedLaneEvals60s'].map((key)=>[key,range(samples.map((s)=>s.scanner[key]))])),
  providers, funnel:last.funnel.session, reconciliation:last.funnel.rawPrefilter.last15m,
  rpc:last.rpc, eventLoop:last.dispatch, history:last.scannerHistory, sizes,
  uniqueSignalsCaptured:signals.size, representativeSignals:[...signals.values()].slice(0,5),
  workflows:last.workflows, broadcasts:report.broadcasts ?? 'RUNNING_NO_BROADCAST_MODE',
},null,2));

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
const samples: Array<{ provider: string; at: number; drift: number }> = [];
export function dispatchDrift(provider: string, expectedMono: number): void {
  samples.push({ provider, at: performance.now(), drift: Math.max(0, performance.now() - expectedMono) });
  while (samples.length > 2048 || (samples[0] && performance.now() - samples[0].at > 60000)) samples.shift();
}
export function dispatchDiagnostics() {
  const values = samples.filter((s) => performance.now() - s.at <= 60000).map((s) => s.drift).sort((a, b) => a - b);
  return { eventLoop: { count: Number(eventLoop.count), p50Ms: eventLoop.percentile(50) / 1e6, p90Ms: eventLoop.percentile(90) / 1e6, p99Ms: eventLoop.percentile(99) / 1e6, window: 'process lifetime' },
    dispatchDrift60s: { count: values.length, p50Ms: values[Math.ceil(values.length * .5) - 1] ?? null, p90Ms: values[Math.ceil(values.length * .9) - 1] ?? null, p99Ms: values[Math.ceil(values.length * .99) - 1] ?? null } };
}

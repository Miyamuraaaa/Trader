import { RollingWorkMetrics } from './work-metrics.js';
const stages = new Map<string, RollingWorkMetrics>();
/** Fixed internal labels only; no tokens, endpoints, secrets or request payloads. */
export function startScannerStage(label: string): () => void {
  let metric = stages.get(label);
  if (!metric) { metric = new RollingWorkMetrics(); stages.set(label, metric); }
  const finish = metric.start(Date.now());
  return () => finish(true);
}
export async function profileScannerStage<T>(label: string, work: () => Promise<T>): Promise<T> {
  const finish = startScannerStage(label); try { return await work(); } finally { finish(); }
}
export function scannerStageProfile() { return Object.fromEntries([...stages].map(([label, metric]) => [label, metric.snapshot()])); }

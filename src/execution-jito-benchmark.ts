import { performance } from 'node:perf_hooks';
import { CONFIG } from './config.js';
import { assertJitoEndpoint } from './execution/jito-submission-transport.js';

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}

async function probe(rawEndpoint: string): Promise<number> {
  const endpoint = assertJitoEndpoint(rawEndpoint);
  endpoint.pathname = '/api/v1/bundles';
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    signal: AbortSignal.timeout(CONFIG.jitoSubmissionTimeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown };
  if (!Array.isArray(body.result)) throw new Error('invalid getTipAccounts response');
  return Number((performance.now() - started).toFixed(1));
}

async function main(): Promise<void> {
  console.log('JITO READ-ONLY REGIONAL LATENCY BENCHMARK');
  console.log('No transaction bytes are constructed, signed, or submitted.');
  for (const endpoint of CONFIG.jitoBenchmarkUrls) {
    const timings: number[] = [];
    let error: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { timings.push(await probe(endpoint)); } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        break;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_050));
    }
    console.log(JSON.stringify({
      endpoint: new URL(endpoint).hostname,
      samples: timings.length,
      p50Ms: timings.length ? percentile(timings, 0.5) : null,
      p90Ms: timings.length ? percentile(timings, 0.9) : null,
      worstMs: timings.length ? Math.max(...timings) : null,
      error,
    }));
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

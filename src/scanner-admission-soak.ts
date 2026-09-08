/** Quote-only infrastructure probe: no scanner engine, IPC, signer, journal, or submission imports. */
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Set before dynamic imports. Never read the user's .env, even when run directly.
process.env.DOTENV_CONFIG_PATH = join(tmpdir(), `trader-absent-${randomUUID()}`);
process.env.EXECUTION_MODE = 'paper'; process.env.LIVE_TRADING_ENABLED = 'false';
process.env.MODE = 'PAPER';
const durationMs = Number(process.argv.find((arg) => arg.startsWith('--duration-ms='))?.split('=')[1] ?? 180000);
if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 900000) throw new Error('Probe duration must be 1000..900000 ms');
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
if (output && !/^data[\\/]admission-soak-[a-z0-9-]+\.json$/.test(output)) throw new Error('Invalid probe artifact path');
console.log = console.warn = console.error = () => {}; // Only whitelisted structured report leaves this probe.
const actualFetch = globalThis.fetch;
const readMethods = new Set(['getAccountInfo','getMultipleAccounts','getProgramAccounts','getSlot','getBlockHeight','getLatestBlockhash','getRecentPrioritizationFees','getBalance','getTokenAccountBalance','getTokenAccountsByOwner','getMinimumBalanceForRentExemption','getEpochInfo']);
let blockedRequests = 0;
globalThis.fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    let allowed = false;
    try { const body = JSON.parse(String(init?.body)); allowed = method === 'POST' && (Array.isArray(body) ? body : [body]).every((item) => readMethods.has(item.method)); } catch { /* fail closed */ }
    if (!allowed) { blockedRequests++; throw new Error('NO_BROADCAST_PROBE_BLOCKED_REQUEST'); }
  }
  return actualFetch(input, init);
};
const { CONFIG, MINTS } = await import('./config.js');
const { getEnabledProviders } = await import('./aggregators/index.js');
const { jupiterAdmission, jupiterWorkMetrics } = await import('./jupiter.js');
const { raptorAdmission, raptorWorkMetrics } = await import('./raptor.js');
const { dispatchDiagnostics } = await import('./dispatch-diagnostics.js');
const { LiveSizeCadence } = await import('./scanner-service-policy.js');
const { toAtomic } = await import('./math.js');
const started = performance.now(); const ends = started + durationMs;
const providers = getEnabledProviders();
const samples: Record<string, { attempts: number; successes: number; failures: number; e2e: number[]; sizes: Record<string, number>; reasons: Record<string, number> }> = {};
const workers = providers.map(async (provider) => {
  const stats: typeof samples[string] = { attempts: 0, successes: 0, failures: 0, e2e: [], sizes: {}, reasons: {} };
  samples[provider.name] = stats;
  const cadence = new LiveSizeCadence();
  while (performance.now() < ends) {
    const size = cadence.next(CONFIG.tradeSizesUsdc, CONFIG.firstLiveMaxInputUsdc)!;
    const at = performance.now(); stats.attempts++; stats.sizes[String(size)] = (stats.sizes[String(size)] ?? 0) + 1;
    try {
      if (provider.isRateLimited()) throw new Error('COOLDOWN');
      await provider.getQuote({ inputMint: MINTS.USDC, outputMint: MINTS.SOL, amountAtomic: toAtomic(size, 6), slippageBps: CONFIG.slippageBps,
        priority: size <= CONFIG.firstLiveMaxInputUsdc ? 'DISCOVERY_HIGH' : 'DISCOVERY_LOW' });
      stats.successes++;
    } catch (error) {
      stats.failures++;
      const message = String(error);
      const reason = /429|rate.limit|cooldown|backpressure/i.test(message) ? 'RATE_LIMIT_OR_COOLDOWN' : /401|403|unauthor/i.test(message) ? 'AUTHORIZATION' : /DEADLINE|timeout|timed out/i.test(message) ? 'DEADLINE_OR_TIMEOUT' : /NO_BROADCAST/.test(message) ? 'PROBE_READ_ALLOWLIST' : 'PROVIDER_FAILURE';
      stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
    }
    stats.e2e.push(performance.now() - at);
    // Error/cached-result pacing; provider's own unchanged limiter remains the authority.
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, ends - performance.now()))));
  }
});
await Promise.allSettled(workers);
const percentiles = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { count: sorted.length, p50: sorted[Math.ceil(sorted.length*.5)-1] ?? null, p90: sorted[Math.ceil(sorted.length*.9)-1] ?? null, p99: sorted[Math.ceil(sorted.length*.99)-1] ?? null }; };
const report = { kind: 'LIVE_INFRASTRUCTURE_QUOTE_ONLY_NOT_FULL_SCANNER_OR_EXECUTOR', durationMs: performance.now() - started,
  providers: Object.fromEntries(Object.entries(samples).map(([name, stats]) => [name, { ...stats, e2e: percentiles(stats.e2e) }])),
  jupiter: { work: jupiterWorkMetrics.snapshot(), admission: jupiterAdmission.snapshot() },
  raptor: { work: raptorWorkMetrics.snapshot(), admission: raptorAdmission.snapshot() }, dispatch: dispatchDiagnostics(),
  freshnessMs: { normal: CONFIG.maxExecutionQuoteAgeMs, raptor: CONFIG.raptorExecutionQuoteAgeMs }, liveCap: CONFIG.firstLiveMaxInputUsdc,
  routeEvaluations: 0, rawPositives: 0, p0: 0, executor: 0, ready: 0, blockedRequests, broadcasts: 0,
  limitation: 'One-leg quotes only; no API keys loaded from .env. Not a market-profitability or candidate conversion measurement.' };
if (output) await writeFile(output, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exit(0);

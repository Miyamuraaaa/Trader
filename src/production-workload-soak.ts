import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { soakContinuity } from './soak-continuity.js';

// Actual scanner + isolated executor, no HTTP server and no approval bridge.
console.log = console.warn = console.error = () => {};
const workspace = fileURLToPath(new URL('../', import.meta.url));
const durationMs = Number(process.argv.find((arg) => arg.startsWith('--duration-ms='))?.split('=')[1] ?? 1800000);
if (!Number.isInteger(durationMs) || durationMs < 1800000 || durationMs > 3600000) throw new Error('Production soak must run 30..60 minutes');
const { config } = await import('dotenv');
config({ path: join(workspace, '.env') }); // Normal runtime loading; contents never printed or copied.
process.env.EXECUTION_MODE = 'live';
process.env.LIVE_TRADING_ENABLED = 'false';
process.env.TRADER_PRODUCTION_SOAK = '1';
const { acquireScannerRuntimeLock } = await import('./scanner-runtime-lock.js');
const lock = await acquireScannerRuntimeLock(join(workspace, 'data/scanner-runtime.lock'));
const sandbox = await mkdtemp(join(tmpdir(), 'trader-production-soak-'));
await mkdir(join(sandbox, 'data'));
// Preserve existing risk/ambiguity state in the diagnostic sandbox; never reset production state.
for (const name of ['execution-risk.json','execution-journal.json']) {
  try { await copyFile(join(workspace, 'data', name), join(sandbox, 'data', name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
process.chdir(sandbox);
const { CONFIG, DECIMALS } = await import('./config.js');
const scanner = await import('./scanner.js');
const { executionFunnel, FunnelTelemetry } = await import('./execution/execution-funnel.js');
const { scannerStageProfile } = await import('./scanner-stage-profile.js');
const { workflowProjectionSnapshot } = await import('./execution/prefilter-workflow.js');
const { jupiterAdmission, jupiterWorkMetrics } = await import('./jupiter.js');
const { raptorAdmission, raptorWorkMetrics } = await import('./raptor.js');
const { scannerSizeDiagnostics } = await import('./scanner-size-diagnostics.js');
const { scannerRpcLimiter } = await import('./scanner-rpc-limiter.js');
const { dispatchDiagnostics } = await import('./dispatch-diagnostics.js');
const dynamic = await import('./dynamic-token-universe.js');
const direct = await import('./direct-market-stream.js');
const { RaptorQuoteStream } = await import('./raptor-stream.js');
const { getScanCycles } = await import('./token-universe.js');
const { toAtomic } = await import('./math.js');
const { db } = await import('./db.js');
const { scannerHistoryBuffer } = await import('./scanner-history-buffer.js');
const { writeAtomicJson } = await import('./persistence/atomic-json-file.js');
const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./production-soak-child.ts', import.meta.url))],
  { cwd: sandbox, env: process.env, stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true });
let executorReady = false, executorExit: number | null = null, p0Deliveries = 0;
child.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const value = message as { type?: string; event?: unknown };
  if (value.type === 'LIVE_EXECUTOR_READY') executorReady = true;
  if (value.type === 'EXECUTION_FUNNEL_EVENT') { const event = FunnelTelemetry.safeParse(value.event); if (event.success) executionFunnel.record(event.data); }
  // LIVE_APPROVAL_UPDATE is intentionally ignored. No acceptance can be sent.
});
child.on('exit', (code) => { executorExit = code; });
const unsubscribe = scanner.subscribeLiveExecutionHandoffs((candidate) => {
  if (child.connected && executorReady) { p0Deliveries++; child.send({ type: 'LIVE_EXECUTOR_HANDOFF', candidate }); }
});
direct.setDirectMarketChangeListener(scanner.notifyMarketChange);
void dynamic.refreshDynamicTokenUniverse(); dynamic.startDynamicTokenDiscovery();
const stream = CONFIG.enableRaptor && CONFIG.enableRaptorStream ? new RaptorQuoteStream(
  CONFIG.tradeSizesUsdc.flatMap((size) => getScanCycles().map((cycle) => ({ inputMint: cycle.inputMint, outputMint: cycle.intermediateMint,
    amountAtomic: toAtomic(size, DECIMALS.USDC), slippageBps: CONFIG.slippageBps }))).slice(0, CONFIG.raptorStreamMaxSubscriptions),
  ({ quote }) => scanner.notifyMarketChange(quote.inputMint, quote.outputMint)) : null;
stream?.start();
const start = performance.now();
let scannerFailed = false;
void scanner.scanLoop().catch(() => { scannerFailed = true; });
const samples: Array<ReturnType<typeof snapshot>> = [];
const snapshot = () => ({ elapsedMs: performance.now() - start, executorReady, executorExit, scannerFailed, p0Deliveries,
  scanner: scanner.scannerOperationalMetrics(), stages: scannerStageProfile(), funnel: executionFunnel.snapshot(), workflows: workflowProjectionSnapshot(),
  jupiter: { work: jupiterWorkMetrics.snapshot(), admission: jupiterAdmission.snapshot() }, raptor: { work: raptorWorkMetrics.snapshot(), admission: raptorAdmission.snapshot() },
  rpc: scannerRpcLimiter.snapshot(), dispatch: dispatchDiagnostics(), scannerHistory: scannerHistoryBuffer.snapshot(), sizes: scannerSizeDiagnostics.snapshot(CONFIG.tradeSizesUsdc, CONFIG.firstLiveMaxInputUsdc, CONFIG.minNetProfitUsdc, CONFIG.minProfitBps) });
const outputPath = join(workspace, 'data', `production-soak-${Date.now()}.json`);
const safeJson = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' && /https?:\/\/|api[_-]?key=|bearer\s/i.test(item) ? '[REDACTED_ENDPOINT_OR_CREDENTIAL]' : item, 2);
let stopping = false;
let checkpointPending = false;
let checkpointFailures = 0;
const finish = async () => {
  if (stopping) return; stopping = true; clearInterval(timer);
  scanner.stopScanner(); dynamic.stopDynamicTokenDiscovery(); stream?.stop(); unsubscribe();
  child.kill('SIGTERM');
  const report = { kind: 'PRODUCTION_SCANNER_ISOLATED_EXECUTOR_NO_BROADCAST', requestedDurationMs: durationMs, durationMs: performance.now() - start,
    manualApprovalAvailable: false, broadcasts: 0, checkpointFailures,
    continuity: soakContinuity(samples.map((sample) => sample.elapsedMs), durationMs), snapshot: snapshot(), samples };
  await writeFile(outputPath, safeJson(report), { flag: 'wx' });
  // Evidence must be durable before potentially hanging WebSocket unsubscribe.
  void direct.stopDirectMarketStream().catch(() => {});
  try { db.close(); } catch { /* independent asynchronous scanner drain */ }
  await lock.release();
  process.stdout.write(JSON.stringify({ finished: true, outputPath, durationMs: report.durationMs, executorReady, executorExit, scannerFailed, broadcasts: 0 }) + '\n');
  process.exit(report.continuity.validProductionSoak ? 0 : 2);
};
const timer = setInterval(() => {
  samples.push(snapshot());
  if (!checkpointPending) {
    checkpointPending = true;
    void writeAtomicJson(outputPath + '.checkpoint.json', JSON.parse(safeJson({ partial: true, elapsedMs: performance.now() - start, samples })))
      .catch(() => { checkpointFailures++; })
      .finally(() => { checkpointPending = false; });
  }
  process.stdout.write(JSON.stringify({ elapsedSeconds: Math.round((performance.now() - start) / 1000), executorReady, executorExit,
    scannerFailed, evals60s: scanner.scannerOperationalMetrics().totalRouteEvals60s, raw: executionFunnel.snapshot().session.RAW_POSITIVE ?? 0 }) + '\n');
  if (performance.now() - start >= durationMs) void finish();
}, 30000);
process.on('SIGINT', () => void finish()); process.on('SIGTERM', () => void finish());
process.stdout.write(JSON.stringify({ started: true, outputPath, durationMs, broadcastsDisabled: true }) + '\n');

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { soakContinuity } from './soak-continuity.js';
import { parseSoakArguments,safetyFingerprint,constrainedStop,validLongSoak,type ConstrainedEvidence } from './soak-controls.js';
import { summarizeRpcTraces } from './rpc-soak-report.js';

// Actual scanner + isolated executor, no HTTP server and no approval bridge.
console.log = console.warn = console.error = () => {};
const workspace = fileURLToPath(new URL('../', import.meta.url));
const {durationMs,earlyStop}=parseSoakArguments(process.argv.slice(2));
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
const { CONFIG, DECIMALS,SCANNER_RPC_CONFIG } = await import('./config.js');
const {EXECUTABLE_POLICY_HASH}=await import('./execution/executable-route-policy.js');
const fingerprint=()=>safetyFingerprint({...CONFIG,scannerRpc:SCANNER_RPC_CONFIG,routePolicyHash:EXECUTABLE_POLICY_HASH});
const safetyStart=fingerprint();
const {scannerRpcTransportSnapshot}=await import('./scanner-rpc-transport.js');
const {executableCoverage}=await import('./executable-coverage.js');
const scanner = await import('./scanner.js');
const { executionFunnel, FunnelTelemetry } = await import('./execution/execution-funnel.js');
const { scannerStageProfile } = await import('./scanner-stage-profile.js');
const { workflowProjectionSnapshot } = await import('./execution/prefilter-workflow.js');
const { jupiterAdmission, jupiterWorkMetrics } = await import('./jupiter.js');
const { raptorAdmission, raptorWorkMetrics,raptorLegalSendSnapshot } = await import('./raptor.js');
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
const { executablePairCoordinator } = await import('./executable-pair-coordinator.js');
const { writeAtomicJson } = await import('./persistence/atomic-json-file.js');
const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./production-soak-child.ts', import.meta.url))],
  { cwd: sandbox, env: process.env, stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true });
let executorReady = false, executorExit: number | null = null, p0Deliveries = 0;
let executorExited=false;
let submissionCounts:Record<string,number>|undefined;
let countersAt=0;
let executorHealth:unknown;
let finalCounterAck:(()=>void)|undefined;
child.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const value = message as { type?: string; event?: unknown; counters?:Record<string,number>; state?:string; reconciliation?:unknown; final?:boolean };
  if(value.type==='SUBMISSION_COUNTERS'&&value.counters){submissionCounts=value.counters;countersAt=performance.now();if(value.final)finalCounterAck?.();}
  if(value.type==='LIVE_EXECUTOR_HEALTH')executorHealth={state:value.state,reconciliation:value.reconciliation};
  if (value.type === 'LIVE_EXECUTOR_READY') executorReady = true;
  if (value.type === 'EXECUTION_FUNNEL_EVENT') { const event = FunnelTelemetry.safeParse(value.event); if (event.success) executionFunnel.record(event.data); }
  // LIVE_APPROVAL_UPDATE is intentionally ignored. No acceptance can be sent.
});
child.on('exit', (code) => { executorExit = code;executorExited=true; });
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
const wallStart=Date.now();
let constrainedEvidence:ConstrainedEvidence|undefined;
if(earlyStop)constrainedStop.configure(process.env.LIVE_TRADING_ENABLED==='false'&&process.env.TRADER_PRODUCTION_SOAK==='1',async evidence=>{constrainedEvidence=evidence;queueMicrotask(()=>void finish());});
let scannerFailed = false;
void scanner.scanLoop().catch(() => { scannerFailed = true; });
const samples: Array<ReturnType<typeof snapshot>> = [];
const rpcTraceCursor=new Map<string,number>();
const snapshot = () => ({ elapsedMs: performance.now() - start,wallElapsedMs:Date.now()-wallStart, executorReady, executorExit,executorExited, scannerFailed, p0Deliveries,
  submissionCounts,submissionCounterAgeMs:countersAt?performance.now()-countersAt:null,executorHealth,
  rpcTransport:scannerRpcTransportSnapshot(rpcTraceCursor),coverage:executableCoverage.snapshot(),
  scanner: scanner.scannerOperationalMetrics(), stages: scannerStageProfile(), funnel: executionFunnel.snapshot(), workflows: workflowProjectionSnapshot(),
  jupiter: { work: jupiterWorkMetrics.snapshot(), admission: jupiterAdmission.snapshot() }, raptor: { work: raptorWorkMetrics.snapshot(), admission: raptorAdmission.snapshot() },
  raptorLegal:raptorLegalSendSnapshot(),pairs:executablePairCoordinator.snapshot(), rpc: scannerRpcLimiter.snapshot(), dispatch: dispatchDiagnostics(), scannerHistory: scannerHistoryBuffer.snapshot(), sizes: scannerSizeDiagnostics.snapshot(CONFIG.tradeSizesUsdc, CONFIG.firstLiveMaxInputUsdc, CONFIG.minNetProfitUsdc, CONFIG.minProfitBps) });
const outputPath = join(workspace, 'data', `production-soak-${Date.now()}.json`);
const safeJson = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' && /https?:\/\/|api[_-]?key=|bearer\s/i.test(item) ? '[REDACTED_ENDPOINT_OR_CREDENTIAL]' : item, 2);
let stopping = false;
let checkpointPending = false;
let checkpointFailures = 0;
const finish = async () => {
  if (stopping) return; stopping = true; clearInterval(timer);
  scanner.stopScanner(); dynamic.stopDynamicTokenDiscovery(); stream?.stop(); unsubscribe();
  let finalCountersReceived=false;
  await new Promise<void>(resolve=>{
    const timeout=setTimeout(resolve,2000);
    finalCounterAck=()=>{finalCountersReceived=true;clearTimeout(timeout);resolve();};
    if(child.connected)child.send({type:'SUBMISSION_COUNTERS_REQUEST'});
  });
  const zeroBroadcastVerified=finalCountersReceived&&submissionCounts!==undefined&&['broadcasterFactory','transportConstruction','broadcasterSubmit','transportSend','submittedSignatures'].every(k=>submissionCounts![k]===0);
  child.kill('SIGTERM');
  const report = { kind: 'PRODUCTION_SCANNER_ISOLATED_EXECUTOR_NO_BROADCAST', requestedDurationMs: durationMs, durationMs: performance.now() - start,
    manualApprovalAvailable: false, approvals:0,submissions:submissionCounts?.broadcasterSubmit??null,submittedSignatures:submissionCounts?.submittedSignatures??null,broadcasts:submissionCounts?.transportSend??null,submissionCounts,zeroBroadcastVerified,finalCountersReceived,checkpointFailures,
    earlyStop,constrainedEvidence,safetyStart,safetyEnd:fingerprint(),safetyUnchanged:safetyStart===fingerprint(),
    healthySamples:samples.length>0&&samples.every(s=>s.executorReady&&!s.scannerFailed&&!s.executorExited),
    wallClockDriftMaxMs:Math.max(0,...samples.map(s=>Math.abs(s.wallElapsedMs-s.elapsedMs))),
    continuity: soakContinuity(samples.map((sample) => sample.elapsedMs), durationMs), snapshot: snapshot(), samples };
  const rpcSummary=summarizeRpcTraces([...samples,report.snapshot].flatMap(s=>s.rpcTransport.endpoints.flatMap(e=>e.traces)),report.durationMs);
  const validProductionSoak=zeroBroadcastVerified&&validLongSoak({continuity:report.continuity.validProductionSoak,healthySamples:report.healthySamples,safetyUnchanged:report.safetyUnchanged,checkpointFailures,wallClockDriftMaxMs:report.wallClockDriftMaxMs,executorReady,executorExited,scannerFailed});
  await writeFile(outputPath, safeJson({...report,validProductionSoak,rpcSummary}), { flag: 'wx' });
  // Evidence must be durable before potentially hanging WebSocket unsubscribe.
  void direct.stopDirectMarketStream().catch(() => {});
  try { db.close(); } catch { /* independent asynchronous scanner drain */ }
  await lock.release();
  const earlyStopValid=zeroBroadcastVerified&&earlyStop&&!!constrainedEvidence&&p0Deliveries===0&&report.safetyUnchanged;
  process.stdout.write(JSON.stringify({ finished: true, outputPath, durationMs: report.durationMs,executorReady,executorExit,scannerFailed,validProductionSoak,earlyStopValid,safetyUnchanged:report.safetyUnchanged,zeroBroadcastVerified,submissionCounts,broadcasts:report.broadcasts })+'\n');
  process.exit((validProductionSoak||earlyStopValid)&&report.safetyUnchanged&&!scannerFailed ? 0 : 2);
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

import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const installEnvironment = vi.hoisted(() => {
  const install = () => {
    vi.stubEnv('EXECUTION_MODE', 'paper');
    vi.stubEnv('LIVE_TRADING_ENABLED', 'false');
  };
  install(); // Bootstrap tests must not inherit the operator's live configuration.
  return install;
});
vi.mock('dotenv/config', () => ({}));
beforeEach(installEnvironment);
afterEach(() => vi.unstubAllEnvs());
import { readFile,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrapExecutor } from '../src/execution/executor-bootstrap.js';
import { PersistentExecutionJournal } from '../src/execution/execution-journal.js';
import { PersistentRiskManager } from '../src/execution/risk-manager.js';
import { CONFIG } from '../src/config.js';
import { validateLiveCriticalConfig } from '../src/execution/live-config-validation.js';
import { createSubmissionCapability,createSubmissionBroadcaster,submissionCounters } from '../src/execution/submission-capability.js';
import { recoveryReadiness,setRecoveryReadiness } from '../src/execution/runtime-readiness.js';
const dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function stores(){const dir=await mkdtemp(path.join(tmpdir(),'trader-bootstrap-'));dirs.push(dir);return {dir,journal:new PersistentExecutionJournal(path.join(dir,'journal.json')),risk:new PersistentRiskManager({maxTrades:1,maxConsecutiveFailures:1,maxSessionLossAtomic:100n},path.join(dir,'risk.json'))};}
it('validates public stores before declaring READY_FOR_SIGNER',async()=>{
  const s=await stores();expect((await bootstrapExecutor(true,s.journal,s.risk)).state).toBe('READY_FOR_SIGNER');
  expect(JSON.parse(await readFile(path.join(s.dir,'journal.json'),'utf8')).version).toBe(2);
});
it('legacy unresolved store never becomes ready for a signer',async()=>{
  const s=await stores();await writeFile(path.join(s.dir,'journal.json'),JSON.stringify({records:[{id:'old',state:'SUBMITTED',createdAt:1,updatedAt:1,signature:'legacy'}]}));
  expect((await bootstrapExecutor(true,s.journal,s.risk)).state).toBe('LEGACY_UNRESOLVED_BLOCKED');
});
it('malformed risk and unwritable journal fail before signer readiness',async()=>{
  const s=await stores();await writeFile(path.join(s.dir,'risk.json'),'{}');await expect(bootstrapExecutor(true,s.journal,s.risk)).rejects.toThrow();
  vi.spyOn(s.journal,'checkpoint').mockRejectedValueOnce(new Error('unwritable journal'));await expect(bootstrapExecutor(true,s.journal,s.risk)).rejects.toThrow('unwritable journal');
});
it.each(['maxTradeUsdc','maxDailyLossUsdc','maxSingleTradeLossUsdc','maxSessionLossUsdc','maxExecutionQuoteAgeMs','raptorExecutionQuoteAgeMs','executionRpcTimeoutMs','liveExecutionPollMs'])('rejects invalid %s before a signer can be loaded',key=>{
  for(const value of [-1,0,NaN,Infinity])expect(()=>validateLiveCriticalConfig({...CONFIG,[key]:value})).toThrow();
});
it('rejects invalid ranges and cross-field configuration without echoing values',()=>{
  for(const patch of [{maxTradePercent:101},{slippageBps:-1},{minNetProfitUsdc:-1},{executionPriorityFeePercentile:-1},{maxTradesPerSession:1.5},{maxConcurrentExecutions:2},{executionPriorityFeeMinMicroLamports:200000,executionPriorityFeeMaxMicroLamports:100000},{executionMode:'live',maxTradesPerSession:2,liveMaxTransactions:1},{executionMode:'live',liveExecutionPollMs:1200,maxExecutionQuoteAgeMs:1200}])expect(()=>validateLiveCriticalConfig({...CONFIG,...patch})).toThrow();
});
it('NO_BROADCAST denies factory before transport construction and all counters stay zero',()=>{
  const cap=createSubmissionCapability(true,{...CONFIG,liveTradingEnabled:false},true),factory=vi.fn(()=>{throw new Error('must not construct');});
  expect(()=>createSubmissionBroadcaster(cap,factory,{} as never,{} as never,{readinessReady:true})).toThrow('NO_BROADCAST');
  expect(factory).not.toHaveBeenCalled();expect(Object.values(submissionCounters())).toEqual([0,0,0,0,0]);
  expect(()=>createSubmissionCapability(true,{...CONFIG,liveTradingEnabled:true},true)).toThrow();
  expect(()=>createSubmissionBroadcaster({kind:'LIVE_SUBMISSION_ALLOWED'},factory,{} as never,{} as never,{readinessReady:true})).toThrow();
});
it('distinguishes reconciliation health from new-submission readiness',()=>{
  setRecoveryReadiness('RECONCILIATION_ONLY');expect(recoveryReadiness()).toMatchObject({healthyForReconciliation:true,readyForNewSubmissions:false});
  setRecoveryReadiness('NO_BROADCAST');expect(recoveryReadiness().readyForNewSubmissions).toBe(false);setRecoveryReadiness('UNVERIFIED');
});
it('preserves automatic authority and puts public recovery before signer access',async()=>{
  const process=await readFile('src/live-execution-process.ts','utf8'),worker=await readFile('src/live-execution-worker.ts','utf8');
  expect(process.indexOf('await bootstrapExecutor')).toBeLessThan(process.indexOf("await loadDedicatedSigner('dry-run')"));
  expect(process.indexOf('await reconciler.tick()')).toBeLessThan(process.indexOf("await loadDedicatedSigner('dry-run')"));
  expect(worker).toContain('await autoExecute(prepared)');
  const tick=worker.slice(worker.indexOf('const tick = async'));
  expect(tick.indexOf('await reconciler.tick()')).toBeLessThan(tick.indexOf('if(pending)'));
  const auto=worker.slice(worker.indexOf('const autoExecute = async'));
  expect(auto.indexOf('if (noBroadcast)')).toBeLessThan(auto.indexOf('createSubmissionBroadcaster'));
});

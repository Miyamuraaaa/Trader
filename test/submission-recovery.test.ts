import { afterEach,expect,it,vi } from 'vitest';
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises';
import * as persistence from '../src/persistence/atomic-json-file.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentExecutionJournal,type ExecutionState } from '../src/execution/execution-journal.js';
import { PersistentRiskManager } from '../src/execution/risk-manager.js';
import { SubmissionReconciler,chainRecoveryObserver,type RecoveryObservation } from '../src/execution/submission-reconciler.js';
const dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(state:ExecutionState='SUBMISSION_UNKNOWN'){
  const dir=await mkdtemp(path.join(tmpdir(),'trader-recovery-'));dirs.push(dir);
  const file=path.join(dir,'journal.json');
  await writeFile(file,JSON.stringify({version:2,records:[{id:'e',state,createdAt:1,updatedAt:1,signature:'signature',serializedTransactionHash:'hash',wallet:'wallet',baseMint:'base',intermediateMint:'token',inputAmount:'1',recentBlockhash:'blockhash',lastValidBlockHeight:100,transportKind:'rpc',sendAttemptId:'attempt',sendBoundaryAt:1,recoveryVersion:1}]}));
  const journal=new PersistentExecutionJournal(file);await journal.load();
  const risk=new PersistentRiskManager({maxTrades:100,maxConsecutiveFailures:2,maxSessionLossAtomic:100n},path.join(dir,'risk.json'));await risk.load();
  let now=1000,height=101;let result:RecoveryObservation={landed:false};
  const observe=vi.fn(async(signature:string)=>{expect(signature).toBe('signature');return result;});
  const coordinator=new SubmissionReconciler({journal,risk,observe,height:async()=>height,now:()=>now,pollMs:100,maxObservationAgeMs:200,endpoint:'fixture',commitment:'confirmed',solPriceAtomic:1000000n});
  return {journal,risk,coordinator,observe,file,advance:(ms=100)=>{now+=ms;},height:(n:number)=>{height=n;},result:(r:RecoveryObservation)=>{result=r;}};
}
it.each(['SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED','CONFIRMING'] as const)('reconciles %s without a sender and expires only after two heights plus final lookup',async state=>{
  const f=await fixture(state);expect(await f.coordinator.tick()).toBe('RECONCILIATION_ONLY');f.advance();expect(await f.coordinator.tick()).toBe('SETTLED');
  expect(f.journal.get('e')?.state).toBe('EXPIRED_UNLANDED');expect(f.risk.snapshot().settled.e?.pnl).toBe('0');expect(f.risk.snapshot().tradeCount).toBe(1);expect(f.observe).toHaveBeenCalledTimes(3);
  await f.coordinator.tick();expect(f.risk.snapshot().tradeCount).toBe(1);
});
const accounting={signature:'signature',actualFeeLamports:5000n,before:{capturedAt:1,baseAmount:100n,intermediateAmount:0n,solLamports:10000n},after:{capturedAt:2,baseAmount:100n,intermediateAmount:0n,solLamports:5000n},realizedBasePnlAtomic:0n,intermediateDustAtomic:0n,hasUnexpectedIntermediateDust:false,observedCommitment:'confirmed' as const};
it.each([false,true])('settles landed accounting exactly once (failed=%s) using actual fee',async failed=>{
  const f=await fixture();f.result({landed:true,accounting,failed});await f.coordinator.tick();await f.coordinator.tick();
  expect(f.risk.snapshot().realizedPnlAtomic).toBe('-5');expect(f.risk.snapshot().settled.e?.signature).toBe('signature');expect(f.journal.get('e')?.state).toBe(failed?'TRANSACTION_FAILED':'CONFIRMED');
});
it('landing later wins and duplicate observations do not debit twice',async()=>{
  const f=await fixture();await f.coordinator.tick();f.result({landed:true,accounting});f.advance();await f.coordinator.tick();await f.coordinator.tick();expect(f.risk.snapshot().tradeCount).toBe(1);
});
it('risk failure after landed observation leaves journal unresolved',async()=>{
  const f=await fixture();f.result({landed:true,accounting});const fail=vi.spyOn(f.risk,'recordConfirmed').mockRejectedValueOnce(new Error('risk persistence failed'));
  await expect(f.coordinator.tick()).rejects.toThrow('risk persistence');expect(f.journal.unresolved()).toHaveLength(1);fail.mockRestore();await f.coordinator.tick();expect(f.risk.snapshot().realizedPnlAtomic).toBe('-5');
});
it('risk settlement before failed terminal journal write replays identically',async()=>{
  const f=await fixture();f.result({landed:true,accounting});const fail=vi.spyOn(f.journal,'recordAccounting').mockRejectedValueOnce(new Error('journal boundary'));
  await expect(f.coordinator.tick()).rejects.toThrow('journal boundary');fail.mockRestore();await f.coordinator.tick();expect(f.risk.snapshot().realizedPnlAtomic).toBe('-5');expect(f.risk.snapshot().tradeCount).toBe(1);
});
it('terminal journal persistence before cleanup cannot trigger another settlement',async()=>{
  const f=await fixture();f.result({landed:true,accounting});const original=f.journal.recordAccounting.bind(f.journal);
  vi.spyOn(f.journal,'recordAccounting').mockImplementationOnce(async(...args)=>{await original(...args);throw new Error('post-terminal crash');});
  await expect(f.coordinator.tick()).rejects.toThrow('post-terminal');expect(await f.coordinator.tick()).toBe('CLEAR');expect(f.risk.snapshot().realizedPnlAtomic).toBe('-5');
});
it('repairs missing risk for a terminal journal only from identical chain accounting',async()=>{
  const f=await fixture();await f.journal.recordAccounting('e',accounting,false);f.result({landed:true,accounting});
  await f.coordinator.tick();await f.coordinator.tick();expect(f.risk.snapshot().tradeCount).toBe(1);expect(f.risk.snapshot().realizedPnlAtomic).toBe('-5');
});
it('conflicting terminal journal accounting cannot debit or settle risk',async()=>{
  const f=await fixture();await f.journal.recordAccounting('e',accounting,false);f.result({landed:true,accounting:{...accounting,actualFeeLamports:6000n}});
  await expect(f.coordinator.tick()).rejects.toThrow('CONFLICTING_TERMINAL');expect(f.risk.snapshot().tradeCount).toBe(0);
});
it('conflicting settlement signature or accounting halts',async()=>{
  const f=await fixture();await f.risk.recordConfirmed('e',0n,false,'different');f.result({landed:true,accounting});await expect(f.coordinator.tick()).rejects.toThrow('Conflicting');expect(f.journal.unresolved()).toHaveLength(1);
});
it('equal height and non-monotonic heights cannot expire',async()=>{
  const f=await fixture();f.height(100);await f.coordinator.tick();f.advance();await f.coordinator.tick();expect(f.journal.get('e')?.state).toBe('SUBMISSION_UNKNOWN');
  f.height(102);f.advance();await f.coordinator.tick();f.height(101);f.advance();await expect(f.coordinator.tick()).rejects.toThrow('NON_MONOTONIC');
  f.advance();await expect(f.coordinator.tick()).rejects.toThrow('NON_MONOTONIC');
});
it('stale height evidence cannot expire',async()=>{
  const f=await fixture();await f.coordinator.tick();f.advance(201);await f.coordinator.tick();expect(f.journal.get('e')?.state).toBe('SUBMISSION_UNKNOWN');
});
it('final landed lookup beats qualifying expiry and blocks until accounting available',async()=>{
  const f=await fixture();await f.coordinator.tick();f.advance();f.observe.mockResolvedValueOnce({landed:false}).mockResolvedValueOnce({landed:true});
  await f.coordinator.tick();expect(f.journal.get('e')?.state).toBe('SUBMISSION_UNKNOWN');expect(f.journal.get('e')?.observedLanded).toBe(true);
});
it('legacy and multiple unresolved records block instead of choosing or expiring',async()=>{
  const f=await fixture();await writeFile(f.file,JSON.stringify({records:[{id:'legacy',state:'SUBMITTING',createdAt:1,updatedAt:1}]}));
  const journal=new PersistentExecutionJournal(f.file);await journal.load();expect(journal.unresolved()[0]?.recoveryBlockedReason).toBe('INSUFFICIENT_LEGACY_METADATA');
  const record=f.journal.get('e')!;await writeFile(f.file,JSON.stringify({version:2,records:[record,{...record,id:'other'}]}));await f.journal.load();await expect(f.coordinator.tick()).rejects.toThrow('MULTIPLE_UNRESOLVED');
});
it('risk-persisted expiry resumes terminal journal settlement exactly once',async()=>{
  const f=await fixture();await f.coordinator.tick();f.advance();const fail=vi.spyOn(f.journal,'recordUnlanded').mockRejectedValueOnce(new Error('injected journal failure'));
  await expect(f.coordinator.tick()).rejects.toThrow('injected');expect(f.risk.snapshot().tradeCount).toBe(1);fail.mockRestore();f.advance();await f.coordinator.tick();f.advance();await f.coordinator.tick();expect(f.risk.snapshot().tradeCount).toBe(1);expect(f.journal.get('e')?.state).toBe('EXPIRED_UNLANDED');
});
it('actual journal write failure latches the gate, including reload in the same process',async()=>{
  const f=await fixture();f.result({landed:true,accounting});vi.spyOn(persistence,'writeAtomicJson').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(f.coordinator.tick()).rejects.toThrow('disk unavailable');await expect(f.coordinator.tick()).rejects.toThrow('persistence failed');await expect(f.journal.load()).rejects.toThrow('persistence failed');
});
it('actual risk write failure cannot produce terminal journal or clear by retry',async()=>{
  const f=await fixture();f.result({landed:true,accounting});const write=persistence.writeAtomicJson;
  vi.spyOn(persistence,'writeAtomicJson').mockImplementation(async(file,value)=>{if(file.endsWith('risk.json'))throw new Error('risk disk failure');await write(file,value);});
  await expect(f.coordinator.tick()).rejects.toThrow('risk disk failure');await expect(f.coordinator.tick()).rejects.toThrow('Risk persistence failed');expect(f.journal.unresolved()).toHaveLength(1);
});
it('legacy migration preserves unresolved records and is idempotent',async()=>{
  const f=await fixture();await writeFile(f.file,JSON.stringify({records:[{id:'legacy',state:'SUBMITTED',createdAt:1,updatedAt:2,signature:'old-signature'}]}));
  const journal=new PersistentExecutionJournal(f.file);await journal.load();await journal.checkpoint();const first=await readFile(f.file,'utf8');await journal.load();await journal.checkpoint();expect(await readFile(f.file,'utf8')).toBe(first);expect(JSON.parse(first).version).toBe(2);expect(journal.unresolved()[0]?.signature).toBe('old-signature');
});
it('dashboard-style journal loads are read-only, including legacy schemas',async()=>{
  const f=await fixture();const original=JSON.stringify({records:[{id:'legacy-reader',state:'SUBMITTING',createdAt:1,updatedAt:1}]});await writeFile(f.file,original);
  const reader=new PersistentExecutionJournal(f.file);const writer=vi.spyOn(persistence,'writeAtomicJson');await reader.load();expect(writer).not.toHaveBeenCalled();expect(await readFile(f.file,'utf8')).toBe(original);expect(reader.unresolved()[0]?.recoveryBlockedReason).toBe('INSUFFICIENT_LEGACY_METADATA');
});
it('chain observer treats contradictory status/transaction responses as landed, not absent',async()=>{
  const f=await fixture();const observer=chainRecoveryObserver({getSignatureStatuses:async()=>({context:{slot:1},value:[null]}),getTransaction:async()=>({meta:{}})} as never,'confirmed');
  expect(await observer('signature',f.journal.get('e')!)).toEqual({landed:true});
});
it('malformed or regressing chain context cannot establish absent signature',async()=>{
  const f=await fixture();let slot=2;const observer=chainRecoveryObserver({getSignatureStatuses:async()=>({context:{slot},value:[null]}),getTransaction:async()=>null} as never,'confirmed');
  await observer('signature',f.journal.get('e')!);slot=1;await expect(observer('signature',f.journal.get('e')!)).rejects.toThrow('NON_MONOTONIC');
});

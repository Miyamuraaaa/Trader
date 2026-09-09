import { expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ConstrainedStop,parseSoakArguments,safetyFingerprint,validLongSoak } from '../src/soak-controls.js';
it('does not certify elapsed time alone when readiness, telemetry or continuity failed',()=>{
  const good={continuity:true,healthySamples:true,safetyUnchanged:true,checkpointFailures:0,wallClockDriftMaxMs:0,executorReady:true,executorExited:false,scannerFailed:false};
  expect(validLongSoak(good)).toBe(true);
  for(const change of [{continuity:false},{healthySamples:false},{safetyUnchanged:false},{checkpointFailures:1},{wallClockDriftMaxMs:1001},{executorReady:false},{executorExited:true},{scannerFailed:true}])expect(validLongSoak({...good,...change})).toBe(false);
});
it('enforces CLI 60..120 minutes without changing environment',()=>{
  expect(parseSoakArguments([]).durationMs).toBe(5400000);expect(parseSoakArguments(['--duration-minutes=60']).durationMs).toBe(3600000);
  for(const n of [30,59,121,NaN])expect(()=>parseSoakArguments([`--duration-minutes=${n}`])).toThrow();
});
it('hashes safety changes but excludes credentials',()=>{
  const a={maxExecutionQuoteAgeMs:1200,rpcUrl:'TEST_ONLY_A',apiKey:'TEST_ONLY'};
  expect(safetyFingerprint(a)).toBe(safetyFingerprint({...a,rpcUrl:'TEST_ONLY_B'}));expect(safetyFingerprint(a)).not.toBe(safetyFingerprint({...a,maxExecutionQuoteAgeMs:1800}));
});
it('requires consumed owned reservation and stops once without P0/approval/send',async()=>{
  const controller=new ConstrainedStop();let persisted=0;expect(()=>controller.configure(false,async()=>{})).toThrow();
  controller.configure(true,async()=>{persisted++;});expect(controller.blocksP0).toBe(true);
  const evidence={candidateId:'TEST',status:'ECONOMICS_DIVERGED',leg1Completed:true,leg2Completed:true,reservationRequired:true,reservationConsumed:false,expectedNet:'-.001',conservativeNet:'-.002',input:'50000',providers:['jupiter','raptor']};
  expect(await controller.consider(evidence)).toBe(false);expect(await controller.consider({...evidence,reservationConsumed:true})).toBe(true);await controller.consider({...evidence,reservationConsumed:true});expect(persisted).toBe(1);
});
it('guards all scanner P0 before publication and keeps existing manual no-broadcast rejection',async()=>{
  const scanner=await readFile('src/scanner.ts','utf8'),worker=await readFile('src/live-execution-worker.ts','utf8');
  expect(scanner.indexOf('if(constrainedStop.blocksP0)return;')).toBeLessThan(scanner.indexOf("logExecutionStage(identity, 'P0_HANDOFF'"));
  expect(worker).toContain("if (noBroadcast) return response(false, null, 'NO_BROADCAST_VALIDATION: manual acceptance unavailable')");
});

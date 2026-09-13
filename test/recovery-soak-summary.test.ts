import { expect,it } from 'vitest';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
it.each([
  {valid:true,verified:true,sends:0,received:0,gap:false,want:'INSUFFICIENT_DATA'},
  {valid:true,verified:true,sends:0,received:1,gap:false,want:'VALID_NO_BROADCAST_OBSERVATION'},
  {valid:true,verified:true,sends:1,received:1,gap:false,want:'FAIL'},
  {valid:true,verified:false,sends:0,received:1,gap:false,want:'INVALID'},
  {valid:true,verified:true,sends:0,received:1,gap:true,want:'INVALID'},
])('summarizes safe fixture as $want',async input=>{
  const dir=await mkdtemp(path.join(tmpdir(),'trader-summary-'));
  try{
    const sample={elapsedMs:30000,jupiter:{work:{},admission:{}},raptor:{work:{},admission:{}},funnel:{lastPositiveSignals:[],session:{EXECUTOR_RECEIVED:input.received},rawPrefilter:{last15m:{}}},sizes:[],scanner:{},executorReady:true,executorExit:null,scannerFailed:false};
    const file=path.join(dir,'report.json');
    await writeFile(file,JSON.stringify({validProductionSoak:input.valid,zeroBroadcastVerified:input.verified,submissionCounts:{broadcasterFactory:0,transportConstruction:0,broadcasterSubmit:0,transportSend:input.sends,submittedSignatures:0},samples:[sample,...(input.gap?[{...sample,elapsedMs:200000}]:[])],snapshot:sample,broadcasts:input.sends}));
    const result=spawnSync(process.execPath,['scripts/summarize-production-soak.mjs',file],{encoding:'utf8',windowsHide:true});expect(result.status).toBe(0);expect(JSON.parse(result.stdout).verdict).toBe(input.want);
  }finally{await rm(dir,{recursive:true,force:true});}
});

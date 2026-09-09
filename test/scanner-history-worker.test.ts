import { expect,it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
it('writes only diagnostic history off-thread and rejects unknown kinds',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'trader-history-test-')),path=join(directory,'history.db');
  const database=new Database(path);database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE scans(id TEXT,timestamp TEXT,trade_size_usdc TEXT,scan_mode TEXT,reference_price TEXT)');
  database.exec('CREATE TABLE quotes('+['id','scan_id','leg','provider','input_mint','output_mint','in_amount','out_amount','other_amount_threshold','price_impact_pct','slippage_bps','platform_fee_amount','platform_fee_bps','route_labels','raw_response','request_timestamp','response_timestamp','latency_ms'].map(c=>c+' TEXT').join(',')+')');
  const worker=new Worker(new URL('../scripts/scanner-history-worker.mjs',import.meta.url),{workerData:{path},execArgv:[]});
  const send=(kind:string,values:string[])=>new Promise<{ok:boolean;writeMs:number}>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.postMessage({kind,values});});
  try{
    expect(await send('scan',['fixture','now','.05','live','150'])).toMatchObject({ok:true});
    expect(database.prepare('SELECT COUNT(*) AS count FROM scans').get()).toEqual({count:1});
    expect(await send('submission',[])).toMatchObject({ok:false});
  }finally{await worker.terminate();database.close();await rm(directory,{recursive:true,force:true});}
});

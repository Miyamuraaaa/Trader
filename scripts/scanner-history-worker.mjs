import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
// Only non-authoritative scans/quotes. No config, signer, journal or risk imports.
const database=new Database(workerData.path,{timeout:50});
const statements={scan:database.prepare('INSERT INTO scans (id,timestamp,trade_size_usdc,scan_mode,reference_price) VALUES (?,?,?,?,?)'),
  quote:database.prepare('INSERT INTO quotes (id,scan_id,leg,provider,input_mint,output_mint,in_amount,out_amount,other_amount_threshold,price_impact_pct,slippage_bps,platform_fee_amount,platform_fee_bps,route_labels,raw_response,request_timestamp,response_timestamp,latency_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')};
parentPort.on('message',({kind,values})=>{
  const started=performance.now();let ok=false;
  try {if(kind!=='scan'&&kind!=='quote')throw new Error('INVALID_HISTORY_KIND');statements[kind].run(...values);ok=true;}catch{}
  parentPort.postMessage({ok,writeMs:performance.now()-started});
});

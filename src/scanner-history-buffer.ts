import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { ScanRow, QuoteRow } from './db.js';
/** Only lossy scanner history; NEVER journal, risk, raw-terminal outcomes or submission state. */
export class ScannerHistoryBuffer {
  private worker?:Worker;
  private workerQueue: Array<{kind:'scan'|'quote';values:Array<string|number|null>;at:number}> = [];
  private workerBusy=false;
  private workerFailed=false;
  enqueueScan(row:ScanRow) { return this.enqueueWorker('scan',[row.id,row.timestamp,row.tradeSizeUsdc,row.scanMode,row.referencePrice]); }
  enqueueQuote(q:QuoteRow) { return this.enqueueWorker('quote',[q.id,q.scanId,q.leg,q.provider,q.inputMint,q.outputMint,q.inAmount,q.outAmount,q.otherAmountThreshold,q.priceImpactPct,q.slippageBps,q.platformFeeAmount,q.platformFeeBps,q.routeLabels,q.rawResponse,q.requestTimestamp,q.responseTimestamp,q.latencyMs]); }
  private enqueueWorker(kind:'scan'|'quote',values:Array<string|number|null>):boolean {
    if(this.workerFailed||this.workerQueue.length>=this.capacity||values.some((value)=>typeof value==='string'&&value.length>1048576)){this.dropped++;return false;}
    this.workerQueue.push({kind,values,at:this.now()});
    if(!this.worker){
      this.worker=new Worker(new URL('../scripts/scanner-history-worker.mjs',import.meta.url),{workerData:{path:join(process.cwd(),'data','terminal.db')},execArgv:[]});this.worker.unref();
      this.worker.on('message',(result:{ok:boolean;writeMs:number})=>{
        if(result.ok)this.completed++;else this.failed++;
        this.durations.push(result.writeMs);this.durations=this.durations.slice(-256);this.workerBusy=false;this.pumpWorker();
      });
      this.worker.on('error',()=>{this.workerFailed=true;this.failed++;this.dropped+=this.workerQueue.length;this.workerQueue=[];this.workerBusy=false;});
      this.worker.unref();
    }
    this.pumpWorker();return true;
  }
  private pumpWorker(){if(this.workerBusy||!this.worker||this.workerFailed)return;const job=this.workerQueue.shift();if(!job)return;
    this.delays.push(this.now()-job.at);this.delays=this.delays.slice(-256);this.workerBusy=true;this.worker.postMessage({kind:job.kind,values:job.values});}
  private queue: Array<{ at: number; write: () => void }> = [];
  private scheduled = false;
  private dropped = 0; private failed = 0; private completed = 0;
  private delays: number[] = []; private durations: number[] = [];
  constructor(private readonly capacity = 256, private readonly defer: (work: () => void) => void = (work) => { setImmediate(work); }, private readonly now = () => performance.now()) {}
  enqueue(write: () => void): boolean {
    if (this.queue.length >= this.capacity) { this.dropped++; return false; }
    this.queue.push({ at: this.now(), write });
    if (!this.scheduled) { this.scheduled = true; this.defer(() => this.drain()); }
    return true;
  }
  private drain(): void {
    // One small write per event-loop turn; provider timers/IO get a service opportunity between writes.
    const job = this.queue.shift();
    if (job) {
      const at = this.now(); this.delays.push(at - job.at);
      try { job.write(); this.completed++; } catch { this.failed++; }
      this.durations.push(this.now() - at); this.delays = this.delays.slice(-256); this.durations = this.durations.slice(-256);
    }
    if (this.queue.length) this.defer(() => this.drain()); else this.scheduled = false;
  }
  snapshot() {
    const metrics = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { count: sorted.length, p50: sorted[Math.ceil(sorted.length*.5)-1] ?? null, p90: sorted[Math.ceil(sorted.length*.9)-1] ?? null, p99: sorted[Math.ceil(sorted.length*.99)-1] ?? null, max: sorted.at(-1) ?? null }; };
    return { queued: this.queue.length+this.workerQueue.length, workerActive:this.workerBusy,workerFailed:this.workerFailed, capacity: this.capacity, dropped: this.dropped, failed: this.failed, completed: this.completed, persistDelayMs: metrics(this.delays), writeMs: metrics(this.durations) };
  }
}
export const scannerHistoryBuffer = new ScannerHistoryBuffer();

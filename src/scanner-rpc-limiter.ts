import { log } from './logger.js';
import { RollingWorkMetrics } from './work-metrics.js';
import { SCANNER_RPC_CONFIG } from './config.js';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RpcTaskContext { label:string; priority:ScannerRpcPriority; deadlineMono?:number; traceId?:string; liveDependency?:boolean }
export const scannerRpcContext=new AsyncLocalStorage<RpcTaskContext>();
export interface RpcAdmissionOptions { deadlineMono?:number; serviceMs?:number; liveDependency?:boolean; signal?:AbortSignal; onDispatch?:(timing:Record<string,number>)=>void }

export type ScannerRpcPriority = 'HIGH' | 'LOW' | 'RPC_P0_EXECUTION_CRITICAL' | 'RPC_P1_EXECUTABLE_DISCOVERY_SUPPORT' | 'RPC_P2_BROAD_DISCOVERY';
const rpcClass = (priority:ScannerRpcPriority) => priority === 'RPC_P0_EXECUTION_CRITICAL' ? 'P0' : priority === 'HIGH' || priority === 'RPC_P1_EXECUTABLE_DISCOVERY_SUPPORT' ? 'P1' : 'P2';

export class ScannerRpcBackpressureError extends Error {
  readonly code = 'SCANNER_RPC_BACKPRESSURE';

  constructor(readonly cooldownRemainingMs: number) {
    super(`Scanner RPC backpressure active for ${Math.max(0, Math.ceil(cooldownRemainingMs))}ms`);
    this.name = 'ScannerRpcBackpressureError';
  }
}

export function isScannerRpcBackpressureError(error: unknown): error is ScannerRpcBackpressureError {
  return error instanceof ScannerRpcBackpressureError
    || (error instanceof Error && error.name === 'ScannerRpcBackpressureError');
}

export interface ScannerRpcLimiterOptions {
  maxConcurrency: number;
  minIntervalMs: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
  recoverySuccesses: number;
}

export interface ScannerRpcLimiterSnapshot {
  classes: Record<string,Record<string,number>>;
  sources: Record<string, ReturnType<RollingWorkMetrics['snapshot']>>;
  work: ReturnType<RollingWorkMetrics['snapshot']>;
  rejectedQueuedByBackpressure: number;
  skippedDuringCooldown: number;
  totalCooldowns: number;
  queued: number;
  active: number;
  effectiveConcurrency: number;
  maxConcurrency: number;
  rateLimits429: number;
  successfulTasks: number;
  failedTasks: number;
  cooldownRemainingMs: number;
  last429At: number | null;
}

interface QueueEntry<T> {
  options:RpcAdmissionOptions;
  waitSince:number;
  waitKind:string;
  waits:Record<string,number>;
  queuedAt: number;
  label: string;
  priority: ScannerRpcPriority;
  sequence: number;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (error as {status?:number})?.status===429 || /\b429\b|too many requests/i.test(message);
}

/**
 * Shared scanner-side RPC admission control.
 *
 * Orca/Meteora quote work, wallet/discovery reads, fee sampling, and scanner
 * policy reads all compete for the same public scanner RPC capacity. Keeping
 * one limiter here prevents independent provider schedulers from creating a
 * retry storm. The isolated live executor never imports or uses this limiter.
 *
 * A scanner quote that waits through a multi-second RPC cooldown is stale by
 * definition and can stall every concurrent scan cycle. Therefore cooldown is
 * fail-fast: work already queued when a 429 arrives is rejected immediately,
 * and new work is rejected until the cooldown expires. Healthy work then
 * restores shared concurrency gradually.
 */
export class ScannerRpcLimiter {
  private classCounts: Record<string,Record<string,number>> = {};
  private countClass(priority:ScannerRpcPriority,event:string) { const counts=this.classCounts[rpcClass(priority)]??={};counts[event]=(counts[event]??0)+1; }
  private sourceMetrics = new Map<string, RollingWorkMetrics>();
  private workMetrics = new RollingWorkMetrics();
  private rejectedQueuedByBackpressure = 0;
  private skippedDuringCooldown = 0;
  private readonly queue: Array<QueueEntry<unknown>> = [];
  private active = 0;
  private effectiveConcurrency: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastStartAt = -Infinity;
  private cooldownUntil = 0;
  private cooldownLevel = 0;
  private healthySince429 = 0;
  private sequence = 0;
  private rateLimits429 = 0;
  private successfulTasks = 0;
  private failedTasks = 0;
  private last429At: number | null = null;
  private p0Run=0;

  constructor(private readonly options: ScannerRpcLimiterOptions) {
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error('Scanner RPC maxConcurrency must be a positive integer');
    }
    if (options.minIntervalMs < 0 || options.baseCooldownMs < 0 || options.maxCooldownMs < options.baseCooldownMs) {
      throw new Error('Invalid scanner RPC timing configuration');
    }
    if (!Number.isInteger(options.recoverySuccesses) || options.recoverySuccesses < 1) {
      throw new Error('Scanner RPC recoverySuccesses must be a positive integer');
    }
    this.effectiveConcurrency = options.maxConcurrency;
  }

  run<T>(label: string, task: () => Promise<T>, priority: ScannerRpcPriority = 'LOW', options:RpcAdmissionOptions={}): Promise<T> {
    const cooldownRemainingMs = this.cooldownRemainingMs();
    const usefulAfterCooldown=priority!=='LOW'&&priority!=='RPC_P2_BROAD_DISCOVERY'&&Number.isFinite(options.deadlineMono)&&performance.now()+cooldownRemainingMs+(options.serviceMs??0)<options.deadlineMono!;
    if (cooldownRemainingMs > 0&&!usefulAfterCooldown) {
      this.countClass(priority,'cooldownSkipped');
      this.skippedDuringCooldown++;
      return Promise.reject(new ScannerRpcBackpressureError(cooldownRemainingMs));
    }
    if(performance.now()+Math.max(0,this.lastStartAt+this.options.minIntervalMs-performance.now())+(options.serviceMs??0)>(options.deadlineMono??Infinity))return Promise.reject(new Error('INTERNAL_PACING_DEADLINE'));

    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= 128) { reject(new Error('Scanner RPC bounded queue capacity exceeded')); return; }
      const entry={
        options,waitSince:performance.now(),waitKind:'queue',waits:{queue:0,pacing:0,concurrency:0,cooldown:0},
        queuedAt: Date.now(),
        label,
        priority,
        sequence: this.sequence++,
        task,
        resolve:(value:unknown)=>{options.signal?.removeEventListener('abort',cancel);resolve(value as T);},
        reject:(error:unknown)=>{options.signal?.removeEventListener('abort',cancel);reject(error);},
      } as QueueEntry<unknown>;
      const cancel=()=>{const index=this.queue.indexOf(entry);if(index>=0){this.queue.splice(index,1);entry.reject(new Error('CANCELLED'));}};
      this.queue.push(entry);options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted){cancel();return;}
      this.workMetrics.observeQueue(this.queue.length);
      this.queue.sort((a, b) => {
        const rank = (priority:ScannerRpcPriority) => rpcClass(priority)==='P0'?2:rpcClass(priority)==='P1'?1:0;
        const priorityDelta = rank(b.priority)-rank(a.priority);
        return priorityDelta !== 0 ? priorityDelta : Number(b.options.liveDependency??false)-Number(a.options.liveDependency??false)||a.sequence - b.sequence;
      });
      this.drain();
    });
  }

  isCoolingDown(): boolean {
    return this.cooldownRemainingMs() > 0;
  }

  snapshot(): ScannerRpcLimiterSnapshot {
    return {
      classes:structuredClone(this.classCounts),
      sources: Object.fromEntries([...this.sourceMetrics].map(([source, metric]) => [source, metric.snapshot()])),
      work: this.workMetrics.snapshot(), rejectedQueuedByBackpressure: this.rejectedQueuedByBackpressure,
      skippedDuringCooldown: this.skippedDuringCooldown, totalCooldowns: this.rateLimits429,
      queued: this.queue.length,
      active: this.active,
      effectiveConcurrency: this.effectiveConcurrency,
      maxConcurrency: this.options.maxConcurrency,
      rateLimits429: this.rateLimits429,
      successfulTasks: this.successfulTasks,
      failedTasks: this.failedTasks,
      cooldownRemainingMs: this.cooldownRemainingMs(),
      last429At: this.last429At,
    };
  }

  private cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - performance.now());
  }

  private markWait(kind:string){const now=performance.now();for(const entry of this.queue){entry.waits[entry.waitKind]=(entry.waits[entry.waitKind]??0)+now-entry.waitSince;entry.waitSince=now;entry.waitKind=kind;}}
  admissionState(){return {nextLegalSendMono:this.lastStartAt+this.options.minIntervalMs,cooldownUntilMono:this.cooldownUntil,active:this.active,queued:this.queue.length,concurrency:this.effectiveConcurrency,oldestQueueAgeMs:this.queue.length?Date.now()-this.queue[0]!.queuedAt:0};}

  private drain(): void {
    if(this.queue.length===0)return;
    if(this.active>=this.effectiveConcurrency){this.markWait('concurrency');return;}
    if(this.timer){this.markWait(this.isCoolingDown()?'cooldown':'pacing');return;}

    const cooldownRemainingMs = this.cooldownRemainingMs();
    if (cooldownRemainingMs > 0) {
      this.rejectQueuedForBackpressure(cooldownRemainingMs);
      if(this.queue.length){this.markWait('cooldown');this.timer=setTimeout(()=>{this.timer=undefined;this.drain();},cooldownRemainingMs);this.timer.unref?.();}
      return;
    }

    const now = performance.now();
    const waitMs = Math.max(0, this.options.minIntervalMs - (now - this.lastStartAt));
    if (waitMs > 0) {
      this.markWait('pacing');
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, waitMs);
      this.timer.unref?.();
      return;
    }

    this.markWait('queue');
    let index=0;
    if(this.p0Run>=4&&rpcClass(this.queue[0]!.priority)==='P0'){
      const p1=this.queue.findIndex(q=>rpcClass(q.priority)==='P1');
      const head=this.queue[0]!;
      if(p1>=0&&now+this.options.minIntervalMs+(this.queue[p1]!.options.serviceMs??0)+(head.options.serviceMs??0)<(head.options.deadlineMono??Infinity))index=p1;
    }
    const next = this.queue.splice(index,1)[0]!;
    if(now+(next.options.serviceMs??0)>(next.options.deadlineMono??Infinity)){next.reject(new Error(next.waits.concurrency!>0?'CONCURRENCY_DEADLINE':'QUEUE_DEADLINE'));this.drain();return;}
    next.options.onDispatch?.({...next.waits,dispatchMono:now});
    this.countClass(next.priority,'dispatched');
    this.p0Run=rpcClass(next.priority)==='P0'?this.p0Run+1:0;
    const finish = this.workMetrics.start(next.queuedAt);
    // Fixed source vocabulary prevents dynamic mint/URL labels leaking into the API or growing the map.
    const source = /orca/i.test(next.label) ? 'orca' : /meteora/i.test(next.label) ? 'meteora'
      : /wallet|balance/i.test(next.label) ? 'wallet' : /fee/i.test(next.label) ? 'fees'
      : /policy|mint|preflight/i.test(next.label) ? 'policy' : 'other';
    let sourceMetric = this.sourceMetrics.get(source);
    if (!sourceMetric) { sourceMetric = new RollingWorkMetrics(); this.sourceMetrics.set(source, sourceMetric); }
    const finishSource = sourceMetric.start(next.queuedAt);
    this.active++;
    this.lastStartAt = now;
    Promise.resolve()
      .then(next.task)
      .then((value) => {
        finish(true);
        finishSource(true);
        this.onSuccess(next.label);
        next.resolve(value);
      }, (error) => {
        this.countClass(next.priority,'failed');if(isRateLimit(error))this.countClass(next.priority,'http429');
        finish(false, isRateLimit(error));
        finishSource(false, isRateLimit(error));
        this.onFailure(next.label, error);
        next.reject(error);
      })
      .finally(() => {
        this.active--;
        this.drain();
      });

    // Healthy mode may admit another task up to the current shared limit. The
    // minInterval still spaces starts, so a single logical quote cannot trigger
    // an unbounded cross-provider burst.
    this.drain();
  }

  private onFailure(label: string, error: unknown): void {
    this.failedTasks++;
    if (!isRateLimit(error)) return;
    this.rateLimits429++;
    this.last429At = Date.now();
    this.healthySince429 = 0;
    this.effectiveConcurrency = 1;
    this.cooldownLevel = Math.min(this.cooldownLevel + 1, 8);
    const retryAfter=Number((error as {retryAfterMs?:number})?.retryAfterMs);
    const cooldownMs = Math.max(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter:0,Math.min(
      this.options.maxCooldownMs,
      this.options.baseCooldownMs * 2 ** Math.max(0, this.cooldownLevel - 1),
    ));
    this.cooldownUntil = Math.max(this.cooldownUntil, performance.now() + cooldownMs);
    const queued = this.queue.length;
    this.rejectQueuedForBackpressure(cooldownMs);
    log.warn('Scanner RPC limiter entered adaptive cooldown after rate limit', {
      label,
      cooldownMs,
      effectiveConcurrency: this.effectiveConcurrency,
      rejectedQueued: queued,
    });
  }

  private rejectQueuedForBackpressure(cooldownRemainingMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    const error = new ScannerRpcBackpressureError(cooldownRemainingMs);
    for (const queued of this.queue.splice(0)) {
      if(rpcClass(queued.priority)!=='P2'&&Number.isFinite(queued.options.deadlineMono)&&performance.now()+cooldownRemainingMs+(queued.options.serviceMs??0)<queued.options.deadlineMono!){this.queue.push(queued);continue;}
      this.rejectedQueuedByBackpressure++;this.countClass(queued.priority,'queuedCooldownRejected');queued.reject(error);
    }
  }

  private onSuccess(label: string): void {
    this.successfulTasks++;
    if (this.isCoolingDown() || this.effectiveConcurrency >= this.options.maxConcurrency) return;
    this.healthySince429++;
    if (this.healthySince429 < this.options.recoverySuccesses) return;
    this.healthySince429 = 0;
    this.effectiveConcurrency++;
    this.cooldownLevel = Math.max(0, this.cooldownLevel - 1);
    log.info('Scanner RPC limiter restored capacity after healthy requests', {
      label,
      effectiveConcurrency: this.effectiveConcurrency,
      maxConcurrency: this.options.maxConcurrency,
    });
  }
}

export const scannerRpcLimiter = new ScannerRpcLimiter(SCANNER_RPC_CONFIG);

export function runScannerRpc<T>(
  label: string,
  task: () => Promise<T>,
  priority: ScannerRpcPriority = 'LOW',
): Promise<T> {
  // Logical tasks may issue multiple concurrent SDK reads. Only transports spend HTTP capacity.
  return scannerRpcContext.run({...scannerRpcContext.getStore(),label,priority},task);
}

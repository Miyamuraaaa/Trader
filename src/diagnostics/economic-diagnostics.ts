import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryRun } from '../execution/source-lane.js';

/** Non-authoritative diagnostics only; never shares the journal/risk write queue. */
export class EconomicDiagnosticBuffer {
  private ordinary: unknown[] = [];
  private critical: unknown[] = [];
  private draining = false;
  private scheduled = false;
  private failed = false;
  private lastSuccessfulDiagnosticWriteAt: number | null = null;
  readonly counts = { ordinaryDropped: 0, criticalOverflow: 0, writeFailures: 0, written: 0 };
  constructor(private readonly write: (record: unknown) => Promise<void>, private readonly capacity = 256, private readonly criticalCapacity = 4096,
    private readonly storageMetadata = () => ({diagnosticDirectory:null as string|null,diagnosticPartsWritten:null as number|null,diagnosticBytesWritten:null as number|null})) {}
  enqueue(record: unknown, critical: boolean): void {
    if (critical) {
      if (this.critical.length >= this.criticalCapacity) { this.counts.criticalOverflow++; return; }
      this.critical.push(record);
    } else if (this.ordinary.length >= this.capacity || this.failed) this.counts.ordinaryDropped++;
    else this.ordinary.push(record);
    if (!this.scheduled && !this.draining && !this.failed) { this.scheduled = true; setImmediate(() => { this.scheduled = false; void this.drain(); }); }
  }
  private async drain(): Promise<void> {
    if (this.draining || this.failed) return;
    this.draining = true;
    try {
      while (this.critical.length || this.ordinary.length) {
        const queue = this.critical.length ? this.critical : this.ordinary;
        const record = queue[0];
        try { await this.write(record); queue.shift(); this.counts.written++; this.lastSuccessfulDiagnosticWriteAt=Date.now(); }
        catch { this.counts.writeFailures++; this.failed = true; break; }
      }
    } finally { this.draining = false; }
  }
  async flush(): Promise<void> {
    while (this.draining) await new Promise<void>(resolve => setTimeout(resolve, 1));
    await this.drain();
  }
  snapshot(finalizing=false) {
    const invalidReasons=[...(this.failed?['DIAGNOSTIC_WRITE_FAILURE']:[]),...(this.counts.criticalOverflow?['CRITICAL_DIAGNOSTIC_OVERFLOW']:[]),...(finalizing&&this.critical.length?['PENDING_CRITICAL_AT_FINALIZE']:[])];
    return { ...this.counts, pendingCritical: this.critical.length, pendingOrdinary: this.ordinary.length,
      valid:invalidReasons.length===0, diagnosticEvidenceValid:invalidReasons.length===0, invalidReasons,
      criticalOverflowCount:this.counts.criticalOverflow,ordinaryDropCount:this.counts.ordinaryDropped,writeFailureCount:this.counts.writeFailures,
      pendingCriticalAtFinalize:finalizing?this.critical.length:null,lastSuccessfulDiagnosticWriteAt:this.lastSuccessfulDiagnosticWriteAt,
      ...this.storageMetadata(),retention: 'per-run segmented JSONL; no automatic deletion of critical records' }; }
}

let directory: string | undefined;
let part = 0, bytes = 0, totalBytes = 0, partsWritten = 0;
export const economicDiagnosticBuffer = new EconomicDiagnosticBuffer(async record => {
  directory ??= join(process.cwd(), 'data', `economic-diagnostics-${telemetryRun.runId}`);
  await mkdir(directory, { recursive: true });
  const line = JSON.stringify({ ...telemetryRun, record }) + '\n';
  if (bytes + Buffer.byteLength(line) > 8 * 1024 * 1024) { part++; bytes = 0; }
  await appendFile(join(directory, `${part}.jsonl`), line, { encoding: 'utf8', mode: 0o600 });
  bytes += Buffer.byteLength(line);
  totalBytes += Buffer.byteLength(line);partsWritten=Math.max(partsWritten,part+1);
},256,4096,()=>({diagnosticDirectory:directory??null,diagnosticPartsWritten:partsWritten,diagnosticBytesWritten:totalBytes}));

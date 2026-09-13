import { readFile } from 'node:fs/promises';
import { writeAtomicJson } from '../persistence/atomic-json-file.js';
import path from 'node:path';
import type { ConfirmedCycleAccounting } from './confirmation-accounting.js';

export type ExecutionState =
  | 'DETECTED' | 'HANDOFF_RECEIVED' | 'REVALIDATING' | 'QUOTED' | 'BUILDING' | 'INSPECTING'
  | 'VALIDATING' | 'SIMULATING' | 'FINAL_REVALIDATION' | 'APPROVED' | 'SIGNING' | 'SIGNED' | 'SIGNED_SIMULATION' | 'APPROVED_FOR_SUBMISSION' | 'APPROVED_BY_USER'
  | 'SUBMITTING' | 'SUBMISSION_UNKNOWN' | 'SUBMITTED' | 'CONFIRMING' | 'CONFIRMED' | 'EXPIRED_UNLANDED'
  | 'EXPIRED' | 'REJECTED' | 'SIMULATION_FAILED' | 'SUBMISSION_FAILED'
  | 'TRANSACTION_FAILED' | 'ACCOUNTING_FAILED';

const terminal = new Set<ExecutionState>([
  'CONFIRMED', 'EXPIRED_UNLANDED', 'EXPIRED', 'REJECTED', 'SIMULATION_FAILED', 'SUBMISSION_FAILED', 'TRANSACTION_FAILED', 'ACCOUNTING_FAILED',
]);

const transitions: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  DETECTED: ['HANDOFF_RECEIVED', 'VALIDATING', 'REJECTED'],
  HANDOFF_RECEIVED: ['REVALIDATING', 'REJECTED', 'EXPIRED'],
  REVALIDATING: ['QUOTED', 'REJECTED', 'EXPIRED'],
  QUOTED: ['BUILDING', 'REJECTED', 'EXPIRED'],
  BUILDING: ['INSPECTING', 'REJECTED', 'EXPIRED'],
  INSPECTING: ['SIMULATING', 'REJECTED'],
  VALIDATING: ['SIMULATING', 'REJECTED', 'EXPIRED'],
  SIMULATING: ['FINAL_REVALIDATION', 'APPROVED', 'SIMULATION_FAILED', 'EXPIRED', 'REJECTED'],
  FINAL_REVALIDATION: ['BUILDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
  APPROVED: ['SIGNING', 'REJECTED', 'EXPIRED'],
  SIGNING: ['SIGNED', 'REJECTED'],
  SIGNED: ['SIGNED_SIMULATION', 'APPROVED_FOR_SUBMISSION', 'SUBMITTING', 'REJECTED', 'EXPIRED'],
  SIGNED_SIMULATION: ['APPROVED_FOR_SUBMISSION', 'REJECTED', 'EXPIRED'],
  APPROVED_FOR_SUBMISSION: ['APPROVED_BY_USER', 'SUBMITTING', 'REJECTED', 'EXPIRED'],
  // One user-approved refresh may rebuild the same route with fresh market
  // evidence and a new blockhash before the broadcaster sees it.
  APPROVED_BY_USER: ['REVALIDATING', 'SUBMITTING', 'REJECTED', 'EXPIRED'],
  SUBMITTING: ['SUBMITTED', 'SUBMISSION_UNKNOWN', 'CONFIRMING', 'CONFIRMED', 'TRANSACTION_FAILED', 'EXPIRED_UNLANDED'],
  SUBMISSION_UNKNOWN: ['CONFIRMING', 'CONFIRMED', 'TRANSACTION_FAILED', 'EXPIRED_UNLANDED'],
  SUBMITTED: ['CONFIRMING', 'CONFIRMED', 'TRANSACTION_FAILED', 'EXPIRED_UNLANDED'],
  CONFIRMING: ['CONFIRMED', 'TRANSACTION_FAILED', 'EXPIRED_UNLANDED'],
  EXPIRED_UNLANDED: [],
  CONFIRMED: [], EXPIRED: [], REJECTED: [], SIMULATION_FAILED: [], SUBMISSION_FAILED: [], TRANSACTION_FAILED: [], ACCOUNTING_FAILED: [],
};

export interface PersistedAccounting {
  actualFeeLamports: string;
  usdcBefore: string;
  usdcAfter: string;
  usdcDelta: string;
  solBeforeLamports: string;
  solAfterLamports: string;
  intermediateBefore: string;
  intermediateAfter: string;
  intermediateDust: string;
}

export interface ExecutionRecord {
  id: string;
  state: ExecutionState;
  messageHash?: string;
  serializedTransactionHash?: string;
  signature?: string;
  wallet?: string;
  baseMint?: string;
  intermediateMint?: string;
  inputAmount?: string;
  recoveryVersion?: number;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  transportKind?: 'rpc' | 'jito';
  sendAttemptId?: string;
  sendBoundaryAt?: number;
  policyHash?: string;
  recoveryBlockedReason?: string;
  observedLanded?: boolean;
  observedCommitment?: 'confirmed' | 'finalized';
  recoveryEvidence?: { endpoint: string; commitment: string; height: number; observedMono: number; latencyMs: number;firstHeight?:number;firstObservedMono?:number;finalLookupMono?:number;pollMs?:number };
  createdAt: number;
  updatedAt: number;
  reason?: string;
  accounting?: PersistedAccounting;
}

export const EXECUTION_JOURNAL_VERSION = 2;
interface JournalData { version?: number; records: ExecutionRecord[]; }
export function hasRecoveryMetadata(record: ExecutionRecord): boolean {
  return record.recoveryVersion === 1 && ['signature','serializedTransactionHash','recentBlockhash','wallet','baseMint','intermediateMint','sendAttemptId'].every(k=>typeof record[k as keyof ExecutionRecord]==='string' && String(record[k as keyof ExecutionRecord]).length>0)
    && typeof record.inputAmount==='string' && /^\d+$/.test(record.inputAmount) && BigInt(record.inputAmount)>0n
    && Number.isSafeInteger(record.lastValidBlockHeight) && record.lastValidBlockHeight!>0
    && Number.isFinite(record.sendBoundaryAt) && (record.transportKind==='rpc'||record.transportKind==='jito');
}

export function assertExecutionTransition(from: ExecutionState, to: ExecutionState): void {
  if (!transitions[from].includes(to)) throw new Error(`Illegal execution state transition: ${from} -> ${to}`);
}

export const SUBMISSION_POSSIBLE_STATES: ReadonlySet<ExecutionState> = new Set([
  'SUBMITTING', 'SUBMISSION_UNKNOWN', 'SUBMITTED', 'CONFIRMING',
]);

export interface JournalRecoveryResult {
  finalizedPreSubmission: ExecutionRecord[];
  requiresReconciliation: ExecutionRecord[];
}

function toPersistedAccounting(value: ConfirmedCycleAccounting): PersistedAccounting {
  return {
    actualFeeLamports: value.actualFeeLamports.toString(),
    usdcBefore: value.before.baseAmount.toString(), usdcAfter: value.after.baseAmount.toString(), usdcDelta: value.realizedBasePnlAtomic.toString(),
    solBeforeLamports: value.before.solLamports.toString(), solAfterLamports: value.after.solLamports.toString(),
    intermediateBefore: value.before.intermediateAmount.toString(), intermediateAfter: value.after.intermediateAmount.toString(),
    intermediateDust: value.intermediateDustAtomic.toString(),
  };
}
export function terminalAccountingMatches(record:ExecutionRecord,value:ConfirmedCycleAccounting,failed:boolean):boolean{
  return record.state===(failed?'TRANSACTION_FAILED':'CONFIRMED')&&record.signature===value.signature&&JSON.stringify(record.accounting)===JSON.stringify(toPersistedAccounting(value));
}

/** Atomic disk journal. Any unresolved submission blocks new execution on restart. */
export class PersistentExecutionJournal {
  private records = new Map<string, ExecutionRecord>();
  private persistenceFailed = false;

  private assertHealthy(): void {
    if (this.persistenceFailed) throw new Error('Execution journal persistence failed; restart/reconciliation required');
  }

  constructor(private readonly journalPath = path.resolve('data/execution-journal.json')) {}

  async load(): Promise<void> {
    this.assertHealthy();
    try {
      const data = JSON.parse(await readFile(this.journalPath, 'utf8')) as Partial<JournalData>;
      if (!Array.isArray(data.records)) throw new Error('Malformed execution journal');
      if (data.version !== undefined && data.version !== EXECUTION_JOURNAL_VERSION) throw new Error('Unsupported execution journal schema');
      const loaded = new Map<string,ExecutionRecord>();
      for (const record of data.records) {
        if (!record || typeof record.id !== 'string' || !record.id || !Object.hasOwn(transitions,record.state) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
          throw new Error('Malformed execution journal record');
        }
        if (loaded.has(record.id)) throw new Error('Duplicate execution journal identity');
        if (SUBMISSION_POSSIBLE_STATES.has(record.state) && !hasRecoveryMetadata(record)) record.recoveryBlockedReason='INSUFFICIENT_LEGACY_METADATA';
        loaded.set(record.id, record);
      }
      this.records=loaded;
      // Readers (including the dashboard process) must never overwrite a newer
      // executor write with a migration snapshot. The owning bootstrap performs
      // migration via checkpoint() before signer initialization.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(id: string): ExecutionRecord | undefined { this.assertHealthy(); const record=this.records.get(id);return record?structuredClone(record):undefined; }

  all(): ExecutionRecord[] {
    this.assertHealthy();return structuredClone([...this.records.values()]);
  }

  unresolved(): ExecutionRecord[] {
    this.assertHealthy();
    return structuredClone([...this.records.values()].filter((record) => !terminal.has(record.state)));
  }

  /** Validates writable atomic persistence before a signer is loaded. */
  async checkpoint():Promise<void>{await this.persist();}

  /**
   * A process restart cannot make a pre-submission attempt real. Those records
   * are finalized through the normal state machine so they do not block new
   * candidates forever. States where an RPC submission may have happened are
   * never discarded and must be reconciled by deterministic signature.
   */
  async recoverInterruptedPreSubmission(
    reason = 'Interrupted before submission by process restart',
  ): Promise<JournalRecoveryResult> {
    const finalizedPreSubmission: ExecutionRecord[] = [];
    const requiresReconciliation: ExecutionRecord[] = [];
    for (const record of this.unresolved()) {
      if (SUBMISSION_POSSIBLE_STATES.has(record.state)) {
        requiresReconciliation.push({ ...record });
        continue;
      }
      const finalized = await this.transition(record.id, 'REJECTED', { reason });
      finalizedPreSubmission.push({ ...finalized });
    }
    return { finalizedPreSubmission, requiresReconciliation };
  }

  async begin(id: string): Promise<ExecutionRecord> {
    this.assertHealthy();
    if (this.records.has(id)) throw new Error('Execution journal already contains this opportunity');
    const now = Date.now();
    const record: ExecutionRecord = { id, state: 'DETECTED', createdAt: now, updatedAt: now };
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  async transition(
    id: string,
    state: ExecutionState,
    update: Partial<Omit<ExecutionRecord,'id'|'state'|'createdAt'|'updatedAt'|'accounting'>> = {},
    options: { persist?: boolean } = {},
  ): Promise<ExecutionRecord> {
    this.assertHealthy();
    const current = this.records.get(id);
    if (!current) throw new Error('Execution journal record does not exist');
    assertExecutionTransition(current.state, state);
    if (SUBMISSION_POSSIBLE_STATES.has(current.state)) {
      for (const key of ['signature','serializedTransactionHash','recentBlockhash','lastValidBlockHeight','wallet','baseMint','intermediateMint','inputAmount','transportKind','sendAttemptId','sendBoundaryAt','policyHash','recoveryVersion'] as const) {
        if (update[key] !== undefined && update[key] !== current[key]) throw new Error('Immutable submission metadata changed');
      }
    }
    const next = { ...current, ...update, state, updatedAt: Date.now() };
    this.records.set(id, next);
    if (options.persist !== false || SUBMISSION_POSSIBLE_STATES.has(state) || terminal.has(state)) await this.persist();
    return next;
  }

  async recordAccounting(id: string, accounting: ConfirmedCycleAccounting, failed = false): Promise<ExecutionRecord> {
    this.assertHealthy();
    const current = this.records.get(id);
    if (!current) throw new Error('Execution journal record does not exist');
    const state = failed ? 'TRANSACTION_FAILED' as const : 'CONFIRMED' as const;
    if (current.signature && current.signature!==accounting.signature) throw new Error('Accounting signature mismatch');
    if (current.state===state && JSON.stringify(current.accounting)===JSON.stringify(toPersistedAccounting(accounting))) return current;
    assertExecutionTransition(current.state, state);
    const next = { ...current, state, updatedAt: Date.now(), accounting: toPersistedAccounting(accounting), observedCommitment: accounting.observedCommitment };
    this.records.set(id, next);
    await this.persist();
    return next;
  }

  async observeRecovery(id: string, update: Pick<ExecutionRecord,'observedLanded'|'observedCommitment'|'recoveryEvidence'>): Promise<void> {
    this.assertHealthy();const current=this.records.get(id);if(!current||!SUBMISSION_POSSIBLE_STATES.has(current.state))throw new Error('Invalid recovery record');
    this.records.set(id,{...current,...update,observedLanded:current.observedLanded||update.observedLanded});await this.persist();
  }

  async recordUnlanded(id:string,evidence:NonNullable<ExecutionRecord['recoveryEvidence']>):Promise<void>{
    this.assertHealthy();const current=this.records.get(id);if(current?.state==='EXPIRED_UNLANDED')return;
    if(!current||!hasRecoveryMetadata(current)||current.observedLanded||evidence.height<=current.lastValidBlockHeight!
      ||evidence.firstHeight===undefined||evidence.firstHeight<=current.lastValidBlockHeight!||evidence.firstHeight>evidence.height
      ||evidence.firstObservedMono===undefined||!evidence.pollMs||evidence.observedMono-evidence.firstObservedMono<evidence.pollMs
      ||evidence.finalLookupMono===undefined||evidence.finalLookupMono<evidence.observedMono)throw new Error('Unlanded settlement lacks recovery evidence');
    await this.transition(id,'EXPIRED_UNLANDED',{recoveryEvidence:evidence,reason:'Two qualifying block heights and final absent signature/transaction; no resend, no fee'});
  }

  private async persist(): Promise<void> {
    this.assertHealthy();
    try { await writeAtomicJson(this.journalPath, { version: EXECUTION_JOURNAL_VERSION, records: [...this.records.values()] }); }
    catch (error) { this.persistenceFailed = true; throw error; }
  }
}

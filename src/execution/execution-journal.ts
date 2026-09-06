import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConfirmedCycleAccounting } from './confirmation-accounting.js';

export type ExecutionState =
  | 'DETECTED' | 'HANDOFF_RECEIVED' | 'REVALIDATING' | 'QUOTED' | 'BUILDING' | 'INSPECTING'
  | 'VALIDATING' | 'SIMULATING' | 'FINAL_REVALIDATION' | 'APPROVED' | 'SIGNING' | 'SIGNED' | 'SIGNED_SIMULATION' | 'APPROVED_FOR_SUBMISSION' | 'APPROVED_BY_USER'
  | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMING' | 'CONFIRMED'
  | 'EXPIRED' | 'REJECTED' | 'SIMULATION_FAILED' | 'SUBMISSION_FAILED'
  | 'TRANSACTION_FAILED' | 'ACCOUNTING_FAILED';

const terminal = new Set<ExecutionState>([
  'CONFIRMED', 'EXPIRED', 'REJECTED', 'SIMULATION_FAILED', 'SUBMISSION_FAILED', 'TRANSACTION_FAILED', 'ACCOUNTING_FAILED',
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
  SUBMITTING: ['SUBMITTED', 'SUBMISSION_FAILED', 'CONFIRMING'],
  SUBMITTED: ['CONFIRMING', 'TRANSACTION_FAILED', 'ACCOUNTING_FAILED'],
  CONFIRMING: ['CONFIRMED', 'TRANSACTION_FAILED', 'ACCOUNTING_FAILED'],
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
  createdAt: number;
  updatedAt: number;
  reason?: string;
  accounting?: PersistedAccounting;
}

interface JournalData { records: ExecutionRecord[]; }

export function assertExecutionTransition(from: ExecutionState, to: ExecutionState): void {
  if (!transitions[from].includes(to)) throw new Error(`Illegal execution state transition: ${from} -> ${to}`);
}

export const SUBMISSION_POSSIBLE_STATES: ReadonlySet<ExecutionState> = new Set([
  'SUBMITTING', 'SUBMITTED', 'CONFIRMING',
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

/** Atomic disk journal. Any unresolved submission blocks new execution on restart. */
export class PersistentExecutionJournal {
  private records = new Map<string, ExecutionRecord>();

  constructor(private readonly journalPath = path.resolve('data/execution-journal.json')) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.journalPath, 'utf8')) as Partial<JournalData>;
      if (!Array.isArray(data.records)) throw new Error('Malformed execution journal');
      for (const record of data.records) {
        if (!record || typeof record.id !== 'string' || !(record.state in transitions) || !Number.isFinite(record.updatedAt)) {
          throw new Error('Malformed execution journal record');
        }
        this.records.set(record.id, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(id: string): ExecutionRecord | undefined { return this.records.get(id); }

  all(): ExecutionRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  unresolved(): ExecutionRecord[] {
    return [...this.records.values()].filter((record) => !terminal.has(record.state));
  }

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
    update: Pick<ExecutionRecord, 'messageHash' | 'serializedTransactionHash' | 'signature' | 'wallet' | 'baseMint' | 'intermediateMint' | 'inputAmount' | 'reason'> = {},
    options: { persist?: boolean } = {},
  ): Promise<ExecutionRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error('Execution journal record does not exist');
    assertExecutionTransition(current.state, state);
    const next = { ...current, ...update, state, updatedAt: Date.now() };
    this.records.set(id, next);
    if (options.persist !== false) await this.persist();
    return next;
  }

  async recordAccounting(id: string, accounting: ConfirmedCycleAccounting): Promise<ExecutionRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error('Execution journal record does not exist');
    assertExecutionTransition(current.state, 'CONFIRMED');
    const next = { ...current, state: 'CONFIRMED' as const, updatedAt: Date.now(), accounting: toPersistedAccounting(accounting) };
    this.records.set(id, next);
    await this.persist();
    return next;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.journalPath), { recursive: true });
    const temporary = `${this.journalPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ records: [...this.records.values()] }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.journalPath);
  }
}

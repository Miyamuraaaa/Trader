import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export interface ExecutionRiskLimits {
  maxTrades: number;
  maxConsecutiveFailures: number;
  maxSessionLossAtomic: bigint;
  maxDailyLossAtomic?: bigint;
  maxSingleTradeLossAtomic?: bigint;
}

interface RiskStateJson {
  version: 2;
  sessionId: string;
  sessionStartedAt: number;
  dateKeyUTC: string;
  dailyPnlAtomic: string;
  failedTransactionCostAtomic: string;
  settled: Record<string, { pnl: string; failed: boolean }>;
  haltReason?: string;
  executedIds: string[];
  tradeCount: number;
  failedTransactions: number;
  consecutiveFailures: number;
  realizedPnlAtomic: string;
}

const count = z.number().int().nonnegative();
const atomic = z.string().regex(/^-?\d+$/);
const legacySchema = z.object({ executedIds: z.array(z.string().min(1)), tradeCount: count,
  failedTransactions: count.default(0), consecutiveFailures: count, realizedPnlAtomic: atomic }).strict();
const riskSchema = legacySchema.extend({ version: z.literal(2), sessionId: z.string().min(1), sessionStartedAt: count,
  dateKeyUTC: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dailyPnlAtomic: atomic, failedTransactionCostAtomic: atomic,
  settled: z.record(z.object({ pnl: atomic, failed: z.boolean() }).strict()), haltReason: z.string().optional() }).strict();

export function confirmedRiskPnl(baseDelta: bigint, solDebitLamports: bigint, solPriceUsdcAtomic: bigint): bigint {
  if (solPriceUsdcAtomic <= 0n) throw new Error('Invalid SOL risk price ceiling');
  const debit = solDebitLamports > 0n ? solDebitLamports : 0n;
  return baseDelta - (debit * solPriceUsdcAtomic + 999_999_999n) / 1_000_000_000n;
}

export class PersistentRiskManager {
  private state: RiskStateJson;
  private persistenceFailed = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly limits: ExecutionRiskLimits,
    private readonly statePath = path.resolve('data/execution-risk.json'),
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limits.maxTrades) || limits.maxTrades < 1 || limits.maxTrades > 100
      || !Number.isInteger(limits.maxConsecutiveFailures) || limits.maxConsecutiveFailures < 1
      || limits.maxSessionLossAtomic <= 0n || (limits.maxDailyLossAtomic ?? 1n) <= 0n
      || (limits.maxSingleTradeLossAtomic ?? 1n) <= 0n) throw new Error('Invalid risk limits (session cap 1..100)');
    this.state = { version: 2, sessionId: randomUUID(), sessionStartedAt: now(), dateKeyUTC: this.day(),
      dailyPnlAtomic: '0', failedTransactionCostAtomic: '0', settled: {},
      executedIds: [], tradeCount: 0, failedTransactions: 0, consecutiveFailures: 0, realizedPnlAtomic: '0' };
  }

  private day(): string { return new Date(this.now()).toISOString().slice(0, 10); }
  snapshot(): Readonly<RiskStateJson> { return structuredClone(this.state); }
  private rollDay(): void {
    const today = this.day();
    if (today < this.state.dateKeyUTC) throw new Error('Risk UTC clock moved backwards');
    if (today > this.state.dateKeyUTC) {
      this.state.dateKeyUTC = today; this.state.dailyPnlAtomic = '0'; this.state.failedTransactionCostAtomic = '0';
    }
  }

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.statePath, 'utf8'));
      const current = riskSchema.safeParse(value);
      if (current.success) this.state = current.data;
      else {
        const old = legacySchema.parse(value);
        // Daily history and prior fee losses are unknowable: preserve all counters and halt for review.
        this.state = { ...this.state, ...old, dailyPnlAtomic: old.realizedPnlAtomic,
          haltReason: 'LEGACY_RISK_STATE_REQUIRES_OPERATOR_REVIEW' };
      }
      if (new Set(this.state.executedIds).size !== this.state.executedIds.length
        || Object.keys(this.state.settled).some((id) => !this.state.executedIds.includes(id))) throw new Error('Malformed risk identities');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.persist();
  }

  assertCanExecute(opportunityId: string, modeledConservativeNetAtomic?: bigint): void {
    if (this.persistenceFailed) throw new Error('Risk persistence failed; restart/reconciliation required');
    if (this.state.executedIds.includes(opportunityId)) throw new Error('Duplicate opportunity execution blocked');
    if (this.state.haltReason) throw new Error(this.state.haltReason);
    this.rollDay();
    if (this.state.tradeCount >= this.limits.maxTrades) throw new Error('MAX_TRADES_PER_SESSION reached');
    if (this.state.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      throw new Error('MAX_CONSECUTIVE_FAILURES reached');
    }
    if (-BigInt(this.state.realizedPnlAtomic) >= this.limits.maxSessionLossAtomic) {
      throw new Error('MAX_SESSION_LOSS_USDC reached');
    }
    if (-BigInt(this.state.dailyPnlAtomic) >= (this.limits.maxDailyLossAtomic ?? this.limits.maxSessionLossAtomic)) throw new Error('MAX_DAILY_LOSS_USDC reached');
    if (modeledConservativeNetAtomic !== undefined && -modeledConservativeNetAtomic > (this.limits.maxSingleTradeLossAtomic ?? this.limits.maxSessionLossAtomic)) throw new Error('MAX_SINGLE_TRADE_LOSS_USDC modeled loss exceeded');
  }

  /** Never called at startup. Explicit operator rotation cannot clear daily loss or unresolved submissions. */
  async beginReviewedSession(acknowledgement: 'START_NEW_REVIEWED_SESSION'): Promise<void> {
    if (acknowledgement !== 'START_NEW_REVIEWED_SESSION' || this.persistenceFailed || this.state.haltReason
      || this.state.executedIds.some((id) => !Object.hasOwn(this.state.settled, id))) throw new Error('Session rotation blocked: unresolved submission or operator-review halt');
    this.rollDay();
    Object.assign(this.state, { sessionId: randomUUID(), sessionStartedAt: this.now(), tradeCount: 0,
      failedTransactions: 0, consecutiveFailures: 0, realizedPnlAtomic: '0' });
    await this.persist();
  }

  /** Persist the one-shot attempt before any future submission RPC is invoked. */
  async recordSubmissionAttempt(opportunityId: string): Promise<void> {
    this.assertCanExecute(opportunityId);
    this.state.executedIds.push(opportunityId);
    this.state.tradeCount++;
    await this.persist();
  }

  async recordSuccess(opportunityId: string, realizedPnlAtomic: bigint): Promise<void> {
    await this.recordConfirmed(opportunityId, realizedPnlAtomic, false);
  }

  /** Idempotent reconciliation, persisted BEFORE terminal journal accounting. */
  async recordConfirmed(opportunityId: string, realizedPnlAtomic: bigint, failed: boolean): Promise<void> {
    if (this.persistenceFailed) throw new Error('Risk persistence failed');
    const previous = Object.hasOwn(this.state.settled, opportunityId) ? this.state.settled[opportunityId] : undefined;
    if (previous) {
      if (previous.pnl !== realizedPnlAtomic.toString() || previous.failed !== failed) throw new Error('Conflicting confirmed accounting');
      return;
    }
    this.rollDay();
    if (!this.state.executedIds.includes(opportunityId)) {
      // Crash between SUBMITTING journal persistence and risk write: recover, never resubmit.
      this.state.executedIds.push(opportunityId); this.state.tradeCount++;
    }
    if (failed) { this.state.failedTransactions++; this.state.consecutiveFailures++; }
    else this.state.consecutiveFailures = 0;
    this.state.realizedPnlAtomic = (BigInt(this.state.realizedPnlAtomic) + realizedPnlAtomic).toString();
    this.state.dailyPnlAtomic = (BigInt(this.state.dailyPnlAtomic) + realizedPnlAtomic).toString();
    if (failed && realizedPnlAtomic < 0n) this.state.failedTransactionCostAtomic = (BigInt(this.state.failedTransactionCostAtomic) - realizedPnlAtomic).toString();
    if (this.limits.maxSingleTradeLossAtomic !== undefined && -realizedPnlAtomic > this.limits.maxSingleTradeLossAtomic) this.state.haltReason = 'MAX_SINGLE_TRADE_LOSS_USDC exceeded; operator review required';
    this.state.settled[opportunityId] = { pnl: realizedPnlAtomic.toString(), failed };
    await this.persist();
  }

  async recordFailure(): Promise<void> {
    this.state.failedTransactions++;
    this.state.consecutiveFailures++;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const document = JSON.stringify(this.state);
    const write = this.writes.then(async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, document, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    this.writes = write.catch(() => { this.persistenceFailed = true; });
    await write;
  }
}

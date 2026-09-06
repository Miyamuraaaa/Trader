import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ExecutionRiskLimits {
  maxTrades: number;
  maxConsecutiveFailures: number;
  maxSessionLossAtomic: bigint;
}

interface RiskStateJson {
  executedIds: string[];
  tradeCount: number;
  failedTransactions: number;
  consecutiveFailures: number;
  realizedPnlAtomic: string;
}

export class PersistentRiskManager {
  private state: RiskStateJson = {
    executedIds: [], tradeCount: 0, failedTransactions: 0, consecutiveFailures: 0, realizedPnlAtomic: '0',
  };

  constructor(
    private readonly limits: ExecutionRiskLimits,
    private readonly statePath = path.resolve('data/execution-risk.json'),
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<RiskStateJson>;
      if (!Array.isArray(parsed.executedIds) || !Number.isInteger(parsed.tradeCount)
        || !Number.isInteger(parsed.consecutiveFailures) || typeof parsed.realizedPnlAtomic !== 'string') {
        throw new Error('Malformed execution risk state');
      }
      BigInt(parsed.realizedPnlAtomic);
      this.state = {
        executedIds: parsed.executedIds,
        tradeCount: parsed.tradeCount!,
        failedTransactions: parsed.failedTransactions ?? 0,
        consecutiveFailures: parsed.consecutiveFailures!,
        realizedPnlAtomic: parsed.realizedPnlAtomic,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  assertCanExecute(opportunityId: string): void {
    if (this.state.executedIds.includes(opportunityId)) throw new Error('Duplicate opportunity execution blocked');
    if (this.state.tradeCount >= this.limits.maxTrades) throw new Error('MAX_TRADES_PER_SESSION reached');
    if (this.state.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      throw new Error('MAX_CONSECUTIVE_FAILURES reached');
    }
    if (-BigInt(this.state.realizedPnlAtomic) >= this.limits.maxSessionLossAtomic) {
      throw new Error('MAX_SESSION_LOSS_USDC reached');
    }
  }

  /** Persist the one-shot attempt before any future submission RPC is invoked. */
  async recordSubmissionAttempt(opportunityId: string): Promise<void> {
    this.assertCanExecute(opportunityId);
    this.state.executedIds.push(opportunityId);
    this.state.tradeCount++;
    await this.persist();
  }

  async recordSuccess(opportunityId: string, realizedPnlAtomic: bigint): Promise<void> {
    if (!this.state.executedIds.includes(opportunityId)) {
      await this.recordSubmissionAttempt(opportunityId);
    }
    this.state.consecutiveFailures = 0;
    this.state.realizedPnlAtomic = (BigInt(this.state.realizedPnlAtomic) + realizedPnlAtomic).toString();
    await this.persist();
  }

  async recordFailure(): Promise<void> {
    this.state.failedTransactions++;
    this.state.consecutiveFailures++;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

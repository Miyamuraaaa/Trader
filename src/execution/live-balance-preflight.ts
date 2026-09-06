import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import type { AtomicExecutionPlan } from './types.js';

export interface LiveExecutionBalanceSnapshot {
  capturedAt: number;
  solLamports: bigint;
  baseAmount: bigint;
  intermediateAmount: bigint;
}

/** Fast, execution-specific balance refresh immediately before submission. */
export async function captureLiveExecutionBalances(
  connection: Connection,
  plan: AtomicExecutionPlan,
): Promise<LiveExecutionBalanceSnapshot> {
  const [solLamports, base, intermediate] = await Promise.all([
    connection.getBalance(new PublicKey(plan.wallet), 'confirmed'),
    connection.getTokenAccountBalance(new PublicKey(plan.baseAta.ata), 'confirmed'),
    plan.intermediateAta.exists
      ? connection.getTokenAccountBalance(new PublicKey(plan.intermediateAta.ata), 'confirmed')
      : Promise.resolve(undefined),
  ]);
  const baseAmount = BigInt(base.value.amount);
  const intermediateAmount = intermediate ? BigInt(intermediate.value.amount) : 0n;
  return {
    capturedAt: Date.now(),
    solLamports: BigInt(solLamports),
    baseAmount,
    intermediateAmount,
  };
}

export async function captureAndValidateLiveBalances(
  connection: Connection,
  plan: AtomicExecutionPlan,
): Promise<LiveExecutionBalanceSnapshot> {
  // The live approval validator already inspected ATA structure. Immediately
  // before submission we need only the spendable USDC amount and native SOL
  // reserve; intermediate balance/dust is captured after confirmation.
  const [currentSolLamports, base] = await Promise.all([
    connection.getBalance(new PublicKey(plan.wallet), 'confirmed'),
    connection.getTokenAccountBalance(new PublicKey(plan.baseAta.ata), 'confirmed'),
  ]);
  const snapshot: LiveExecutionBalanceSnapshot = {
    capturedAt: Date.now(),
    solLamports: BigInt(currentSolLamports),
    baseAmount: BigInt(base.value.amount),
    intermediateAmount: 0n,
  };
  const { baseAmount, solLamports } = snapshot;
  if (baseAmount < plan.inputAmount) throw new Error('Live preflight: insufficient base-token balance');
  const configuredMaxAtomic = BigInt(Math.floor(CONFIG.maxTradeUsdc * 1_000_000));
  if (plan.inputAmount > configuredMaxAtomic) {
    throw new Error('Live preflight: input exceeds MAX_TRADE_USDC');
  }
  const percentLimitAtomic = baseAmount * BigInt(Math.floor(CONFIG.maxTradePercent * 100)) / 10_000n;
  if (plan.inputAmount > percentLimitAtomic) {
    throw new Error('Live preflight: input exceeds MAX_TRADE_PERCENT of current USDC balance');
  }
  if (solLamports < BigInt(Math.ceil(CONFIG.minSolFeeReserve * 1_000_000_000))) {
    throw new Error('Live preflight: INSUFFICIENT SOL RESERVE');
  }
  return snapshot;
}

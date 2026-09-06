export interface ExecutionBalanceSnapshot {
  capturedAt: number;
  baseAmount: bigint;
  intermediateAmount: bigint;
  solLamports: bigint;
}

export interface RealizedCycleResult {
  realizedBaseDelta: bigint;
  solFeeDeltaLamports: bigint;
  intermediateDustDelta: bigint;
  hasUnexpectedIntermediateDust: boolean;
}

/** Confirmed balance deltas only; projected quote data is deliberately absent. */
export function calculateRealizedCycleResult(
  before: ExecutionBalanceSnapshot,
  after: ExecutionBalanceSnapshot,
): RealizedCycleResult {
  const intermediateDustDelta = after.intermediateAmount - before.intermediateAmount;
  return {
    realizedBaseDelta: after.baseAmount - before.baseAmount,
    solFeeDeltaLamports: before.solLamports - after.solLamports,
    intermediateDustDelta,
    hasUnexpectedIntermediateDust: intermediateDustDelta !== 0n,
  };
}

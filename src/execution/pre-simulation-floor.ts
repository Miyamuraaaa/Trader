/**
 * Necessary-condition gate evaluated BEFORE the RPC simulation.
 *
 * Network costs can only reduce profit, so if the enforceable minimum output
 * minus input is already below the required net profit with zero costs, the
 * final conservative gate cannot pass. Rejecting early saves a simulation and
 * separates "RTSE/threshold too wide" from a genuine on-chain failure.
 * This never accepts anything the existing final gates would reject.
 *
 * The message deliberately avoids the words "simulation", "stale", "expired"
 * and "quote age": existing classifiers map those to other terminal states.
 */
export interface FloorPlan { inputAmount: bigint; minimumOutputAmount: bigint }

export function assertConservativeFloor(plan: FloorPlan, minimumNetProfitAtomic: bigint): void {
  const grossAtMinimum = plan.minimumOutputAmount - plan.inputAmount;
  if (grossAtMinimum < minimumNetProfitAtomic) {
    throw new Error(
      `CONSERVATIVE_FLOOR_BELOW_BREAKEVEN: enforceable minimum output ${plan.minimumOutputAmount} - input ${plan.inputAmount} = ${grossAtMinimum} atomic, `
      + `below required net ${minimumNetProfitAtomic} before any network cost`);
  }
}

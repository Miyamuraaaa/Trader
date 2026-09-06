import type { AtomicExecutionPlan } from './types.js';

export interface FinalEconomicPolicy {
  now: number;
  maxQuoteAgeMs: number;
  estimatedCostsAtomic: bigint;
  minimumNetProfitAtomic: bigint;
  minimumProfitBps: bigint;
}

export function validateFinalEconomics(
  plan: AtomicExecutionPlan,
  policy: FinalEconomicPolicy,
): { passed: boolean; reasons: string[]; projectedNetAtomic: bigint; roiBps: bigint } {
  const reasons: string[] = [];
  const age = policy.now - plan.quoteReceivedAt;
  if (age < 0 || age > policy.maxQuoteAgeMs) reasons.push(`Stale quote: ${age}ms`);
  const projectedNetAtomic = plan.expectedOutputAmount - plan.inputAmount - policy.estimatedCostsAtomic;
  const roiBps = plan.inputAmount > 0n ? projectedNetAtomic * 10_000n / plan.inputAmount : -10_000n;
  if (projectedNetAtomic <= policy.minimumNetProfitAtomic) reasons.push('Projected net profit is below threshold');
  if (roiBps < policy.minimumProfitBps) reasons.push('Projected ROI is below threshold');
  if (plan.minimumOutputAmount <= plan.inputAmount + policy.estimatedCostsAtomic) {
    reasons.push('On-chain minimum output does not protect a profitable outcome');
  }
  return { passed: reasons.length === 0, reasons, projectedNetAtomic, roiBps };
}

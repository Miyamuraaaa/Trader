import { performance } from 'node:perf_hooks';
import { exact } from './math.js';
import type { EstimatedCostInput } from './profit.js';
export function breakEvenDiagnostic(size: number, cap: number, costs: EstimatedCostInput, minimumProfit: number, roiBps: number) {
  const input = exact(size);
  const known = costs.ataRentUsdc !== undefined;
  const additional = exact(costs.baseNetworkFeeUsdc).plus(costs.priorityFeeUsdc).plus(costs.ataRentUsdc ?? 0).plus(costs.otherKnownCostsUsdc ?? 0);
  const roi = input.mul(roiBps).div(10000), profit = roi.gt(minimumProfit) ? roi : exact(minimumProfit);
  return { inputUsdc: input.toString(), executionEligible: size <= cap, costDataComplete: known,
    baseFeeUsdc: String(costs.baseNetworkFeeUsdc), priorityFeeUsdc: String(costs.priorityFeeUsdc), ataRentUsdc: known ? String(costs.ataRentUsdc) : null,
    otherCostsUsdc: String(costs.otherKnownCostsUsdc ?? 0), additionalCostUsdc: additional.toString(),
    costBps: input.gt(0) ? additional.div(input).mul(10000).toString() : null,
    breakEvenSpreadUsdc: additional.toString(), requiredMinimumQuotedOutputUsdc: input.plus(additional).plus(profit).toString(),
    providerFees: 'ALREADY_EMBEDDED_IN_QUOTED_OUTPUT', variableSlippage: 'ENFORCED_BY_MINIMUM_OUTPUT_NOT_ADDED_TWICE',
    source: 'Existing scanner execution cost model; required output is after provider fees. Unknown ATA means lower bound, not full cost.' };
}
type Observation = { at: number; size: number; event: string };
class SizeDiagnostics {
  private observations: Observation[] = [];
  private costs = new Map<number, { at: number; value: EstimatedCostInput }>();
  record(size: number, event: string, costs?: EstimatedCostInput) {
    this.observations.push({ at: performance.now(), size, event });
    this.observations = this.observations.filter((o) => performance.now() - o.at < 900_000).slice(-10000);
    if (costs) { this.costs.set(size, { at: performance.now(), value: { ...costs } }); while (this.costs.size > 128) this.costs.delete(this.costs.keys().next().value!); }
  }
  utility(size: number) {
    const recent = this.observations.filter((o) => o.size === size && performance.now() - o.at < 60000);
    return Math.min(1, recent.reduce((sum, o) => sum + (o.event === 'constrained_positives' ? 1 : o.event === 'raw_positives' ? .1 : 0) * Math.exp(-(performance.now() - o.at) / 30000), 0));
  }
  snapshot(sizes: readonly number[], cap: number, minProfit: number, roiBps: number) {
    return sizes.map((size) => {
      const observations = this.observations.filter((o) => o.size === size && performance.now() - o.at < 900000);
      const counts = observations.reduce<Record<string, number>>((out, o) => { out[o.event] = (out[o.event] ?? 0) + 1; return out; }, {});
      const attempts = observations.filter((o) => o.event === 'discovery_attempts');
      const cached = this.costs.get(size);
      const cost = cached && performance.now() - cached.at < 60_000 ? cached.value : undefined;
      return { size, classification: size <= cap ? 'EXECUTION_ELIGIBLE_UNDER_CURRENT_CAP' : 'OBSERVATION_ONLY_ABOVE_CAP', counts,
        useful_positive_rate: (counts.constrained_positives ?? 0) / Math.max(1, counts.constrained_attempts ?? 0),
        cadenceMs: attempts.length > 1 ? (attempts.at(-1)!.at - attempts[0]!.at) / (attempts.length - 1) : null,
        cost: cost ? { ...breakEvenDiagnostic(size, cap, cost, minProfit, roiBps), ageMs: performance.now() - cached!.at, ttlMs: 60_000 } : null,
        conclusion: (counts.constrained_positives ?? 0) > 0 ? 'EXECUTABLE_ECONOMICS_OBSERVED' : 'INSUFFICIENT_DATA' };
    });
  }
}
export const scannerSizeDiagnostics = new SizeDiagnostics();

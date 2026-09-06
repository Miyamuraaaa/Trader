import { CONFIG } from '../config.js';
import type { AtomicExecutionPlan } from './types.js';

/** Fast routes stay at 1.2s. Only Raptor legs receive the capped 1.8s window. */
export function executionQuoteAgeLimit(plan: Pick<AtomicExecutionPlan, 'type' | 'aggregatorEvidence'>): number {
  const hasRaptor = plan.aggregatorEvidence?.providers.includes('raptor')
    || plan.type.includes('RAPTOR');
  return hasRaptor ? Math.min(1800, CONFIG.raptorExecutionQuoteAgeMs) : CONFIG.maxExecutionQuoteAgeMs;
}

export function quoteAgeMs(plan: Pick<AtomicExecutionPlan, 'quoteReceivedAt'>, now = Date.now()): number {
  return Math.max(0, now - plan.quoteReceivedAt);
}

export function assertExecutionQuoteFresh(
  plan: Pick<AtomicExecutionPlan, 'type' | 'aggregatorEvidence' | 'quoteReceivedAt'>,
  stage: string,
  now = Date.now(),
): { ageMs: number; maxAgeMs: number } {
  const ageMs = quoteAgeMs(plan, now);
  const maxAgeMs = executionQuoteAgeLimit(plan);
  if (ageMs > maxAgeMs) throw new Error(`Execution quote stale at ${stage}: age=${ageMs}ms limit=${maxAgeMs}ms`);
  return { ageMs, maxAgeMs };
}

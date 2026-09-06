import crypto from 'crypto';
import { getPoolIds } from './aggregators/types.js';
import { CONFIG } from './config.js';
import type { RoundTripResult } from './routes.js';

export type OpportunityState =
  | 'CANDIDATE'
  | 'LIVE_QUOTED'
  | 'CONFIRMED_QUOTE'
  | 'BELOW_THRESHOLD'
  | 'STALE'
  | 'OVERLAPPING_LIQUIDITY'
  | 'PARTIAL_FILL'
  | 'INVALID'
  | 'EXPIRED'
  | 'RAW_MARKET_OPPORTUNITY'
  | 'EXECUTABLE_CANDIDATE'
  | 'DISCOVERY_ONLY_TOKEN_2022';

export type OpportunityEventType = 'NEW' | 'UPDATED' | 'IMPROVED' | 'DEGRADED' | 'EXPIRED' | 'SUPPRESSED';

export interface OpportunityLifecycleEvent {
  identityKey: string;
  eventType: OpportunityEventType;
  state: OpportunityState;
  initialDetectedAt: number | null;
  observedAt: number;
  lifetimeMs: number | null;
}

interface ActiveOpportunity {
  firstSeenAt: number;
  lastSeenAt: number;
  profitBps: number;
  state: OpportunityState;
}

const active = new Map<string, ActiveOpportunity>();

export const opportunityMetrics = {
  candidateSpreads: 0,
  liveQuoted: 0,
  confirmed: 0,
  expired: 0,
  bestObservedRoiPct: 0,
  lifetimeTotalMs: 0,
};

export function opportunityIdentity(route: RoundTripResult): string {
  const parts = [
    route.buyQuote.provider,
    route.sellQuote.provider,
    route.buyQuote.inputMint,
    route.buyQuote.outputMint,
    route.sellQuote.outputMint,
    route.buyQuote.inAmount,
    ...getPoolIds(route.buyQuote).sort(),
    ...getPoolIds(route.sellQuote).sort(),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

export function stateForRoute(route: RoundTripResult): OpportunityState {
  if (route.buyQuote.isPartialFill || route.sellQuote.isPartialFill) return 'PARTIAL_FILL';
  if (route.stale) return 'STALE';
  if (route.liquidityOverlap === true) return 'OVERLAPPING_LIQUIDITY';
  if (route.category === 'NEGATIVE' || route.category === 'BELOW_THRESHOLD') return 'BELOW_THRESHOLD';
  if (route.opportunityScope === 'DISCOVERY_ONLY_TOKEN_2022') return 'DISCOVERY_ONLY_TOKEN_2022';
  if (route.opportunityScope === 'EXECUTABLE_CANDIDATE') return 'EXECUTABLE_CANDIDATE';
  if (route.opportunityScope === 'RAW_MARKET_OPPORTUNITY') return 'RAW_MARKET_OPPORTUNITY';
  return route.validationTier === 'OBSERVATION' ? 'CANDIDATE' : 'LIVE_QUOTED';
}

export function observeOpportunity(route: RoundTripResult, now = Date.now()): OpportunityLifecycleEvent {
  const identityKey = opportunityIdentity(route);
  const state = stateForRoute(route);
  const profitBps = route.profit.profitBps.toNumber();
  opportunityMetrics.candidateSpreads++;
  opportunityMetrics.bestObservedRoiPct = Math.max(
    opportunityMetrics.bestObservedRoiPct,
    route.profit.profitPct.toNumber(),
  );

  const previous = active.get(identityKey);
  const isActivePositive = state === 'LIVE_QUOTED'
    || state === 'RAW_MARKET_OPPORTUNITY'
    || state === 'EXECUTABLE_CANDIDATE'
    || state === 'DISCOVERY_ONLY_TOKEN_2022';
  if (!isActivePositive) {
    if (previous) {
      const lifetimeMs = now - previous.firstSeenAt;
      active.delete(identityKey);
      opportunityMetrics.expired++;
      opportunityMetrics.lifetimeTotalMs += lifetimeMs;
      return { identityKey, eventType: 'EXPIRED', state: 'EXPIRED', initialDetectedAt: previous.firstSeenAt, observedAt: now, lifetimeMs };
    }
    return { identityKey, eventType: 'UPDATED', state, initialDetectedAt: null, observedAt: now, lifetimeMs: null };
  }

  if (!previous) {
    active.set(identityKey, { firstSeenAt: now, lastSeenAt: now, profitBps, state });
    opportunityMetrics.liveQuoted++;
    return { identityKey, eventType: 'NEW', state, initialDetectedAt: now, observedAt: now, lifetimeMs: 0 };
  }

  const delta = profitBps - previous.profitBps;
  previous.lastSeenAt = now;
  previous.profitBps = profitBps;
  const eventType = Math.abs(delta) < CONFIG.opportunityUpdateBps
    ? 'SUPPRESSED'
    : delta > 0 ? 'IMPROVED' : 'DEGRADED';
  return {
    identityKey,
    eventType,
    state,
    initialDetectedAt: previous.firstSeenAt,
    observedAt: now,
    lifetimeMs: now - previous.firstSeenAt,
  };
}

export function markConfirmed(identityKey: string): void {
  const tracked = active.get(identityKey);
  if (tracked) tracked.state = 'CONFIRMED_QUOTE';
  opportunityMetrics.confirmed++;
}

export function expireInactive(now = Date.now()): OpportunityLifecycleEvent[] {
  const events: OpportunityLifecycleEvent[] = [];
  for (const [identityKey, item] of active) {
    if (now - item.lastSeenAt <= CONFIG.opportunityExpiryMs) continue;
    const lifetimeMs = item.lastSeenAt - item.firstSeenAt;
    active.delete(identityKey);
    opportunityMetrics.expired++;
    opportunityMetrics.lifetimeTotalMs += lifetimeMs;
    events.push({ identityKey, eventType: 'EXPIRED', state: 'EXPIRED', initialDetectedAt: item.firstSeenAt, observedAt: now, lifetimeMs });
  }
  return events;
}

export function getOpportunityLifecycleMetrics() {
  return {
    ...opportunityMetrics,
    active: active.size,
    averageLifetimeMs: opportunityMetrics.expired === 0
      ? 0
      : opportunityMetrics.lifetimeTotalMs / opportunityMetrics.expired,
  };
}

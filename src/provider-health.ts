import { CONFIG } from './config.js';
import { jupiterStats } from './jupiter.js';
import { meteoraPoolRegistry, meteoraRuntime } from './meteora.js';
import { orcaPoolRegistry, orcaRuntime } from './orca.js';
import { raydiumRuntime } from './raydium.js';
import { raptorStats } from './raptor.js';
import { rpcMetrics } from './solana.js';

interface HealthLine {
  provider: string;
  requests: number;
  successes: number;
  failures: number;
  rateLimits429: number;
  averageLatencyMs: number;
  cacheHits: number;
  cacheMisses: number;
  circuitOpen: boolean;
  state: 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'UNAVAILABLE';
}

export function getProviderHealth(): HealthLine[] {
  const direct = [raydiumRuntime.health(), orcaRuntime.health(), meteoraRuntime.health()];
  return [
    {
      provider: 'jupiter',
      requests: jupiterStats.requestsSinceStartup,
      successes: jupiterStats.successfulRequests,
      failures: jupiterStats.otherErrors,
      rateLimits429: jupiterStats.rateLimits429,
      averageLatencyMs: jupiterStats.avgLatencyMs,
      cacheHits: jupiterStats.cacheHits,
      cacheMisses: jupiterStats.cacheMisses,
      circuitOpen: jupiterStats.throttleState === 'BACKOFF',
      state: jupiterStats.throttleState === 'BACKOFF'
        ? 'COOLDOWN'
        : jupiterStats.otherErrors > 0 && jupiterStats.successfulRequests === 0
          ? 'UNAVAILABLE'
          : jupiterStats.otherErrors > 0 ? 'DEGRADED' : 'HEALTHY',
    },
    {
      provider: 'raptor',
      requests: raptorStats.requestsSinceStartup,
      successes: raptorStats.successfulRequests,
      failures: raptorStats.otherErrors,
      rateLimits429: raptorStats.rateLimits429,
      averageLatencyMs: raptorStats.avgLatencyMs,
      cacheHits: raptorStats.cacheHits,
      cacheMisses: raptorStats.cacheMisses,
      circuitOpen: raptorStats.throttleState === 'BACKOFF',
      state: raptorStats.throttleState === 'BACKOFF'
        ? 'COOLDOWN'
        : raptorStats.otherErrors > 0 && raptorStats.successfulRequests === 0
          ? 'UNAVAILABLE'
          : raptorStats.otherErrors > 0 ? 'DEGRADED' : 'HEALTHY',
    },
    ...direct,
  ];
}

let lastPrint = 0;

export function printProviderHealth(force = false): void {
  if (!force && Date.now() - lastPrint < CONFIG.providerHealthIntervalMs) return;
  lastPrint = Date.now();
  console.log('\n=== PROVIDER HEALTH (QUOTE-ONLY) ===');
  for (const health of getProviderHealth()) {
    if (health.requests === 0 && health.cacheHits === 0) continue;
    const successPct = health.requests === 0 ? 0 : health.successes / health.requests * 100;
    console.log(`${health.provider.padEnd(9)} ${health.state.padEnd(11)} success=${successPct.toFixed(1)}%`
      + ` avg=${health.averageLatencyMs.toFixed(0)}ms`
      + ` failures=${health.failures} 429=${health.rateLimits429}`
      + ` cache=${health.cacheHits}/${health.cacheMisses}`
      + `${health.circuitOpen ? ' CIRCUIT_OPEN' : ''}`);
  }
  console.log(`RPC logical request groups: ${rpcMetrics.logicalRequests}`);
  console.log(`Pool registry cache: Orca ${orcaPoolRegistry.stats.hits}/${orcaPoolRegistry.stats.misses},`
    + ` Meteora ${meteoraPoolRegistry.stats.hits}/${meteoraPoolRegistry.stats.misses} (hits/misses)`);
}

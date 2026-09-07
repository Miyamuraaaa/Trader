import { getRouteLabels, type Quote, type QuoteParams, type QuoteProviderName } from '../aggregators/types.js';
import { createHash } from 'node:crypto';

/**
 * One source of truth for the route surface audited by the live builders.
 * These are quote constraints, not execution authority; the executor still
 * reconstructs, inspects and simulates every transaction independently.
 */
export const EXECUTION_JUPITER_DEXES = ['Whirlpool'] as const;
export const EXECUTION_RAPTOR_DEXES = ['Raydium CLMM', 'PancakeSwap'] as const;
export const EXECUTION_AGGREGATOR_MAX_HOPS = 1;
export const EXECUTION_JUPITER_MAX_ACCOUNTS = 28;
export const EXECUTION_ORCA_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
export const EXECUTION_RAPTOR_DOWNSTREAM_PROGRAMS = new Set([
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq', // PancakeSwap Solana
]);

export const EXECUTABLE_PROVIDER_PAIRS = new Set<string>([
  'raptor:jupiter',
  'jupiter:raptor',
  'jupiter:orca',
  'orca:jupiter',
  'raptor:orca',
  'orca:raptor',
]);

export const EXECUTABLE_POLICY_VERSION = 2;
export const EXECUTABLE_POLICY_HASH = createHash('sha256').update(JSON.stringify({
  version: EXECUTABLE_POLICY_VERSION, pairs: [...EXECUTABLE_PROVIDER_PAIRS].sort(),
  jupiterDexes: EXECUTION_JUPITER_DEXES, raptorDexes: EXECUTION_RAPTOR_DEXES,
  maxHops: EXECUTION_AGGREGATOR_MAX_HOPS, maxAccounts: EXECUTION_JUPITER_MAX_ACCOUNTS,
  orcaProgram: EXECUTION_ORCA_PROGRAM_ID, raptorPrograms: [...EXECUTION_RAPTOR_DOWNSTREAM_PROGRAMS].sort(),
  tokenPolicy: 'classic-spl-only', amountPolicy: 'exact-in-enforceable-min-chain',
})).digest('hex');
export function executionAdapterIdentity(provider: string, program: string): string {
  return `${provider}:single-pool-exact-in:${program}`;
}

export function isExecutableProviderPair(
  buy: QuoteProviderName,
  sell: QuoteProviderName,
): boolean {
  return EXECUTABLE_PROVIDER_PAIRS.has(`${buy}:${sell}`);
}

export function executableQuoteConstraints(provider: QuoteProviderName): Pick<
  QuoteParams, 'dexes' | 'maxHops' | 'onlyDirectRoutes' | 'maxAccounts'
> {
  if (provider === 'jupiter') return {
    dexes: [...EXECUTION_JUPITER_DEXES],
    maxAccounts: EXECUTION_JUPITER_MAX_ACCOUNTS,
  };
  if (provider === 'raptor') return {
    dexes: [...EXECUTION_RAPTOR_DEXES],
    maxHops: EXECUTION_AGGREGATOR_MAX_HOPS,
    onlyDirectRoutes: true,
  };
  return {};
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Fail closed when a constrained provider response escapes its audited DEX surface. */
export function quoteMatchesExecutableProviderPolicy(quote: Quote): boolean {
  const labels = getRouteLabels(quote);
  if (quote.provider === 'orca') {
    return labels.length > 0 && quote.routePlan.every((step) =>
      step.swapInfo.programId === undefined
        || step.swapInfo.programId === EXECUTION_ORCA_PROGRAM_ID)
      && labels.every((label) => {
      const value = normalized(label);
      return value.includes('orca') || value.includes('whirlpool');
    });
  }
  if (quote.provider === 'jupiter') {
    return labels.length > 0
      && quote.routePlan.every((step) => step.swapInfo.programId === undefined
        || step.swapInfo.programId === EXECUTION_ORCA_PROGRAM_ID)
      && labels.every((label) => normalized(label).includes('whirlpool'));
  }
  if (quote.provider === 'raptor') {
    const allowed = new Set(EXECUTION_RAPTOR_DEXES.map(normalized));
    return quote.routePlan.length > 0
      && quote.routePlan.length <= EXECUTION_AGGREGATOR_MAX_HOPS
      && quote.routePlan.every((step) => typeof step.swapInfo.programId === 'string'
        && EXECUTION_RAPTOR_DOWNSTREAM_PROGRAMS.has(step.swapInfo.programId))
      && labels.every((label) => allowed.has(normalized(label)));
  }
  return false;
}

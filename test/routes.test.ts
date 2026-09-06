import { describe, expect, it } from 'vitest';
import type { ProviderQuoteResult } from '../src/aggregators/index.js';
import type { Quote, QuoteProvider } from '../src/aggregators/types.js';
import {
  buildRoundTripMatrix,
  classifyValidationTier,
  classifyRoute,
  detectLiquidityOverlap,
} from '../src/routes.js';
import {
  isAuditedAggregatorHandoffRoute,
  isAuditedMixedHandoffRoute,
  isFreshPositiveAuditedExecutionSignal,
} from '../src/execution/scanner-handoff-eligibility.js';
import {
  executableQuoteConstraints,
  quoteMatchesExecutableProviderPolicy,
} from '../src/execution/executable-route-policy.js';

function quote(provider: Quote['provider'], input: string, output: string, amount: string, out: string): Quote {
  const now = Date.now();
  return {
    provider,
    id: `${provider}-${out}`,
    inputMint: input,
    outputMint: output,
    inAmount: amount,
    consumedInAmount: amount,
    outAmount: out,
    otherAmountThreshold: out,
    swapMode: 'ExactIn',
    slippageBps: 50,
    platformFee: null,
    routePlan: [{ swapInfo: { label: provider, inputMint: input, outputMint: output } }],
    poolIds: [],
    isPartialFill: false,
    requestTimestamp: now,
    responseTimestamp: now,
    latencyMs: 1,
    rawResponse: '{}',
  };
}

describe('two-leg route matrix', () => {
  it('keeps raw market routes separate from executor-constrained routes', () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wsol = 'So11111111111111111111111111111111111111112';
    const unrestricted = quote('raptor', usdc, wsol, '50000', '100000');
    unrestricted.routePlan[0]!.swapInfo.label = 'HumidiFi';
    expect(quoteMatchesExecutableProviderPolicy(unrestricted)).toBe(false);

    const constrained = { ...unrestricted, routePlan: [{
      swapInfo: {
        ...unrestricted.routePlan[0]!.swapInfo,
        label: 'Raydium CLMM',
        programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      },
    }] };
    expect(quoteMatchesExecutableProviderPolicy(constrained)).toBe(true);
    expect(executableQuoteConstraints('jupiter')).toMatchObject({
      dexes: ['Whirlpool'], maxAccounts: 28,
    });
  });

  it('requires executor candidates to propagate leg-one minimum, not optimistic output', () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wsol = 'So11111111111111111111111111111111111111112';
    const buy = quote('raptor', usdc, wsol, '50000', '100000');
    buy.otherAmountThreshold = '99000';
    buy.routePlan[0]!.swapInfo.label = 'Raydium CLMM';
    buy.routePlan[0]!.swapInfo.programId = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
    const sell = quote('jupiter', wsol, usdc, '100000', '51000');
    sell.routePlan[0]!.swapInfo.label = 'Whirlpool';
    const route = {
      buyQuote: buy, sellQuote: sell, opportunityScope: 'EXECUTABLE_CANDIDATE',
      validationTier: 'CONSERVATIVE_CANDIDATE', liquidityOverlap: false, stale: false,
      profit: { estimatedNetProfitUsdc: { gt: () => true }, worstCaseNetProfitUsdc: { gt: () => true } },
    } as unknown as import('../src/routes.js').RoundTripResult;
    expect(isFreshPositiveAuditedExecutionSignal(route)).toBe(false);
    expect(isFreshPositiveAuditedExecutionSignal({
      ...route, sellQuote: { ...sell, inAmount: '99000', consumedInAmount: '99000' },
    })).toBe(true);
  });

  it('promotes fresh audited bidirectional Jupiter/Raptor cycles to the P0 handoff lane', async () => {
    const buy = quote('raptor', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112', '50000', '500000');
    buy.routePlan[0]!.swapInfo.label = 'Raydium CLMM';
    buy.routePlan[0]!.swapInfo.programId = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
    const jupiter: QuoteProvider = {
      name: 'jupiter', kind: 'aggregator', isRateLimited: () => false,
      getQuote: async (params) => {
        const sell = quote('jupiter', params.inputMint, params.outputMint, params.amountAtomic, '52000');
        sell.routePlan[0]!.swapInfo.label = 'Whirlpool';
        return sell;
      },
    };
    const matrix = await buildRoundTripMatrix([{ provider: 'raptor', quote: buy }], [jupiter], {
      intermediateMint: buy.outputMint, startingMint: buy.inputMint, slippageBps: 5,
    }, 0);
    const route = matrix.routes[0]!;
    expect(route.opportunityScope).toBe('RAW_MARKET_OPPORTUNITY');
    expect(route.validationTier).toBe('QUOTE_CANDIDATE');
    expect(isAuditedAggregatorHandoffRoute(route)).toBe(false);
    const executableRoute = {
      ...route,
      opportunityScope: 'EXECUTABLE_CANDIDATE' as const,
      validationTier: 'CONSERVATIVE_CANDIDATE' as const,
    };
    expect(isAuditedAggregatorHandoffRoute(executableRoute)).toBe(true);
    expect(isAuditedAggregatorHandoffRoute({ ...executableRoute, stale: true })).toBe(false);
    expect(isAuditedAggregatorHandoffRoute({
      ...executableRoute,
      buyQuote: { ...executableRoute.buyQuote, outputMint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump' },
    })).toBe(false);

    const dynamicMint = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';
    const jupiterBuy = quote('jupiter', buy.inputMint, dynamicMint, '50000', '700000');
    jupiterBuy.routePlan[0]!.swapInfo.label = 'Whirlpool';
    const raptorSell = quote('raptor', dynamicMint, buy.inputMint, '700000', '52000');
    raptorSell.routePlan[0]!.swapInfo.label = 'Raydium CLMM';
    raptorSell.routePlan[0]!.swapInfo.programId = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
    const reverse = {
      ...route,
      buyProvider: 'jupiter' as const,
      sellProvider: 'raptor' as const,
      buyQuote: jupiterBuy,
      sellQuote: raptorSell,
      liquidityOverlap: false,
      stale: false,
      validationTier: 'CONSERVATIVE_CANDIDATE' as const,
      opportunityScope: 'EXECUTABLE_CANDIDATE' as const,
    };
    expect(isAuditedAggregatorHandoffRoute(reverse)).toBe(true);
    expect(isAuditedAggregatorHandoffRoute({
      ...reverse, sellQuote: { ...raptorSell, inAmount: '699999' },
    })).toBe(false);
  });

  it('publishes only protocol-inspected mixed routes and keeps Raydium/Meteora discovery-only', () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wsol = 'So11111111111111111111111111111111111111112';
    const base = {
      buyProvider: 'jupiter' as const, sellProvider: 'orca' as const,
      buyQuote: quote('jupiter', usdc, wsol, '50000', '500000'),
      sellQuote: quote('orca', wsol, usdc, '500000', '52000'),
      liquidityOverlap: false, stale: false,
      validationTier: 'CONSERVATIVE_CANDIDATE' as const,
      opportunityScope: 'EXECUTABLE_CANDIDATE' as const,
    } as unknown as import('../src/routes.js').RoundTripResult;
    base.buyQuote.routePlan[0]!.swapInfo.label = 'Whirlpool';
    base.sellQuote.routePlan[0]!.swapInfo.label = 'Orca Whirlpool';
    expect(isAuditedMixedHandoffRoute(base)).toBe(true);
    expect(isAuditedMixedHandoffRoute({
      ...base, sellProvider: 'raydium', sellQuote: { ...base.sellQuote, provider: 'raydium' },
    })).toBe(false);
    expect(isAuditedMixedHandoffRoute({
      ...base, sellProvider: 'meteora', sellQuote: { ...base.sellQuote, provider: 'meteora' },
    })).toBe(false);
  });

  it('promotes a fresh positive supported live signal without requiring a paper confidence tier', () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wsol = 'So11111111111111111111111111111111111111112';
    const route = {
      buyQuote: quote('raptor', usdc, wsol, '50000', '100000'),
      sellQuote: quote('jupiter', wsol, usdc, '100000', '51000'),
      liquidityOverlap: false,
      stale: false,
      validationTier: 'QUOTE_CANDIDATE',
      opportunityScope: 'EXECUTABLE_CANDIDATE',
      profit: {
        estimatedNetProfitUsdc: { gt: (value: number) => value === 0 },
        worstCaseNetProfitUsdc: { gt: (value: number) => value === 0 },
      },
    } as unknown as import('../src/routes.js').RoundTripResult;
    route.buyQuote.routePlan[0]!.swapInfo.label = 'Raydium CLMM';
    route.buyQuote.routePlan[0]!.swapInfo.programId = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
    route.sellQuote.routePlan[0]!.swapInfo.label = 'Whirlpool';
    expect(isFreshPositiveAuditedExecutionSignal(route)).toBe(true);
    expect(isFreshPositiveAuditedExecutionSignal({ ...route, stale: true })).toBe(false);
    expect(isFreshPositiveAuditedExecutionSignal({ ...route, liquidityOverlap: true })).toBe(false);
  });

  it('uses the exact raw leg-1 output as leg-2 input', async () => {
    const buy = quote('raydium', 'USDC', 'SOL', '100000000', '123456789');
    let received = '';
    const orca: QuoteProvider = {
      name: 'orca',
      kind: 'direct',
      isRateLimited: () => false,
      getQuote: async (params) => {
        received = params.amountAtomic;
        return quote('orca', 'SOL', 'USDC', params.amountAtomic, '100100000');
      },
    };
    const first: ProviderQuoteResult[] = [{ provider: 'raydium', quote: buy }];
    const matrix = await buildRoundTripMatrix(first, [orca], {
      intermediateMint: 'SOL', startingMint: 'USDC', slippageBps: 50,
    }, 0);

    expect(received).toBe('123456789');
    expect(matrix.routes[0]?.sellQuote.inAmount).toBe(buy.outAmount);
    expect(matrix.routes[0]?.classification).toBe('DIRECT_CROSS_DEX');
    expect(matrix.routes[0]?.validationTier).toBe('QUOTE_CANDIDATE');
    expect(matrix.routes[0]?.opportunityScope).toBe('RAW_MARKET_OPPORTUNITY');
  });

  it('reserves the conservative tier for fresh non-overlapping minimum-output profit', async () => {
    const buy = quote('raydium', 'USDC', 'SOL', '100000000', '123456789');
    const orca: QuoteProvider = {
      name: 'orca', kind: 'direct', isRateLimited: () => false,
      getQuote: async (params) => quote('orca', 'SOL', 'USDC', params.amountAtomic, '101000000'),
    };
    const matrix = await buildRoundTripMatrix(
      [{ provider: 'raydium', quote: buy }], [orca],
      { intermediateMint: 'SOL', startingMint: 'USDC', slippageBps: 5 }, 0,
    );
    expect(matrix.routes[0]?.validationTier).toBe('QUOTE_CANDIDATE');
    expect(classifyValidationTier(
      matrix.routes[0]!.category,
      false,
      null,
      matrix.routes[0]!.profit,
    )).toBe('QUOTE_CANDIDATE');
  });

  it('continues when one second-leg provider fails', async () => {
    const buy = quote('raydium', 'USDC', 'SOL', '100000000', '123');
    const good: QuoteProvider = {
      name: 'orca', kind: 'direct', isRateLimited: () => false,
      getQuote: async (params) => quote('orca', 'SOL', 'USDC', params.amountAtomic, '100000001'),
    };
    const bad: QuoteProvider = {
      name: 'meteora', kind: 'direct', isRateLimited: () => false,
      getQuote: async () => { throw new Error('simulated failure'); },
    };
    const matrix = await buildRoundTripMatrix(
      [{ provider: 'raydium', quote: buy }],
      [good, bad],
      { intermediateMint: 'SOL', startingMint: 'USDC', slippageBps: 50 },
      0,
    );
    expect(matrix.routes).toHaveLength(1);
    expect(matrix.failures).toHaveLength(1);
  });

  it('marks aggregator/direct venue overlap from route labels', () => {
    const aggregate = quote('jupiter', 'USDC', 'SOL', '1', '1');
    aggregate.routePlan[0]!.swapInfo.label = 'Raydium CLMM';
    const direct = quote('raydium', 'SOL', 'USDC', '1', '1');
    expect(classifyRoute(aggregate, direct)).toBe('AGGREGATOR_ROUTE');
    expect(detectLiquidityOverlap(aggregate, direct)).toBe(true);
  });

  it('compares disclosed non-core aggregator venue labels', () => {
    const pancakeBuy = quote('raptor', 'USDC', 'SOL', '10000000', '103000000');
    pancakeBuy.routePlan[0]!.swapInfo.label = 'PancakeSwap';
    const pancakeSell = quote('jupiter', 'SOL', 'USDC', '103000000', '10001000');
    pancakeSell.routePlan[0]!.swapInfo.label = 'Pancake Swap';
    const fluxSell = quote('jupiter', 'SOL', 'USDC', '103000000', '10001000');
    fluxSell.routePlan[0]!.swapInfo.label = 'Flux';

    expect(detectLiquidityOverlap(pancakeBuy, pancakeSell)).toBe(true);
    expect(detectLiquidityOverlap(pancakeBuy, fluxSell)).toBe(false);
  });

  it('labels Jupiter versus Raptor as aggregator arbitrage', () => {
    const jupiter = quote('jupiter', 'USDC', 'SOL', '1', '1');
    const raptor = quote('raptor', 'SOL', 'USDC', '1', '1');
    expect(classifyRoute(jupiter, raptor)).toBe('AGGREGATOR_ARBITRAGE');
  });

  it('excludes partial first-leg fills from comparison', async () => {
    const partial = quote('meteora', 'USDC', 'SOL', '100', '10');
    partial.consumedInAmount = '50';
    partial.isPartialFill = true;
    const provider: QuoteProvider = {
      name: 'orca', kind: 'direct', isRateLimited: () => false,
      getQuote: async () => { throw new Error('must not be called'); },
    };
    const matrix = await buildRoundTripMatrix(
      [{ provider: 'meteora', quote: partial }], [provider],
      { intermediateMint: 'SOL', startingMint: 'USDC', slippageBps: 50 }, 0,
    );
    expect(matrix.routes).toHaveLength(0);
    expect(matrix.failures).toHaveLength(0);
  });
});

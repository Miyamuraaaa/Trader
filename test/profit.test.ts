import { describe, expect, it } from 'vitest';
import { calculateEstimatedRoundTripProfit } from '../src/profit.js';
import type { Quote } from '../src/aggregators/types.js';

describe('provider-independent estimated profit', () => {
  it('applies the minimum output once in conservative mode', () => {
    const sellQuote = {
      provider: 'raptor', outAmount: '101000000', otherAmountThreshold: '100000000',
    } as Quote;
    const result = calculateEstimatedRoundTripProfit(100, sellQuote, 0.1, 'conservative');
    expect(result.grossProfitUsdc.toString()).toBe('1');
    expect(result.estimatedSlippageUsdc.toString()).toBe('1');
    expect(result.estimatedNetProfitUsdc.toString()).toBe('-0.1');
    expect(result.worstCaseNetProfitUsdc.toString()).toBe('-0.1');
    expect(result.profitPct.toString()).toBe('-0.1');
  });

  it('does not subtract the slippage buffer in quote mode', () => {
    const sellQuote = {
      provider: 'raptor', outAmount: '101000000', otherAmountThreshold: '100000000',
    } as Quote;
    const result = calculateEstimatedRoundTripProfit(100, sellQuote, 0.1, 'quote');
    expect(result.estimatedSlippageUsdc.toString()).toBe('1');
    expect(result.estimatedFinalUsdc.toString()).toBe('101');
    expect(result.estimatedNetProfitUsdc.toString()).toBe('0.9');
  });
});

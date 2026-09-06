import { describe, expect, it } from 'vitest';
import { normalizeRaydiumQuote } from '../src/raydium.js';

describe('Raydium compute-only quote normalization', () => {
  it('normalizes exact integer amounts, fees, routes, and pool IDs', () => {
    const params = { inputMint: 'A', outputMint: 'B', amountAtomic: '1000', slippageBps: 50 };
    const quote = normalizeRaydiumQuote({
      id: 'quote-id', success: true, version: 'V1', data: {
        swapType: 'BaseIn', inputMint: 'A', inputAmount: '1000', actualInputAmount: '1000',
        outputMint: 'B', outputAmount: '2000', otherAmountThreshold: '1990',
        slippageBps: 50, priceImpactPct: 0.01,
        routePlan: [{ poolId: 'pool', inputMint: 'A', outputMint: 'B', feeMint: 'A', feeAmount: '3' }],
      },
    }, params, 100, 125);

    expect(quote.provider).toBe('raydium');
    expect(quote.inAmount).toBe('1000');
    expect(quote.consumedInAmount).toBe('1000');
    expect(quote.outAmount).toBe('2000');
    expect(quote.otherAmountThreshold).toBe('1990');
    expect(quote.feeAmount).toBe('3');
    expect(quote.poolIds).toEqual(['pool']);
    expect(quote.isPartialFill).toBe(false);
  });

  it('rejects logical API failures returned with HTTP 200', () => {
    expect(() => normalizeRaydiumQuote(
      { success: false, msg: 'No route found' },
      { inputMint: 'A', outputMint: 'B', amountAtomic: '1000', slippageBps: 50 },
      100,
      125,
    )).toThrow(/No route found/);
  });
});

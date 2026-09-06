import { describe, expect, it } from 'vitest';
import { withWalletUsdEstimate, type ReadOnlyWalletSnapshot } from '../src/wallet-reader.js';

const snapshot: ReadOnlyWalletSnapshot = {
  address: '9hZBCCw3Bvsucma1aQyDmyJ2wrdor7mmdhVuFtSnebZe',
  slot: 1,
  solLamports: '12000000',
  solDisplay: '0.012',
  usdcAmountAtomic: '1952400',
  tokenBalances: [],
  observedAt: 1,
  executionLimits: {
    configuredMaxTradeUsdc: 0.05,
    balancePercentLimit: 10,
    protectedSolReserve: 0.002,
    solReservePass: true,
  },
};

describe('read-only wallet display estimate', () => {
  it('keeps live wallet balances separate and derives a display-only USD estimate', () => {
    const result = withWalletUsdEstimate(snapshot, {
      priceUsd: 100,
      observedAt: 2,
      provider: 'orca',
    });
    expect(result.solLamports).toBe('12000000');
    expect(result.usdcAmountAtomic).toBe('1952400');
    expect(result.usdEstimate).toMatchObject({
      usdcValue: 1.9524,
      solValue: 1.2,
      totalUsd: 3.1524,
      solPriceProvider: 'orca',
    });
  });

  it('reports no estimate rather than fabricating a SOL/USD value', () => {
    expect(withWalletUsdEstimate(snapshot, null).usdEstimate).toBeNull();
  });
});

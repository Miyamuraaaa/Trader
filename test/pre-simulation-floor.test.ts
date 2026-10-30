import { describe, expect, it } from 'vitest';
import { assertConservativeFloor } from '../src/execution/pre-simulation-floor.js';

describe('assertConservativeFloor', () => {
  it('rejects when minimum output cannot cover input plus required net', () => {
    expect(() => assertConservativeFloor({ inputAmount: 250000n, minimumOutputAmount: 249900n }, 100n))
      .toThrow(/CONSERVATIVE_FLOOR_BELOW_BREAKEVEN/);
    expect(() => assertConservativeFloor({ inputAmount: 250000n, minimumOutputAmount: 250050n }, 100n))
      .toThrow(/CONSERVATIVE_FLOOR_BELOW_BREAKEVEN/);
  });
  it('passes only as a necessary condition (costs are still checked later)', () => {
    expect(() => assertConservativeFloor({ inputAmount: 250000n, minimumOutputAmount: 250100n }, 100n)).not.toThrow();
  });
  it('message avoids words that existing classifiers map to other terminal states', () => {
    try { assertConservativeFloor({ inputAmount: 1n, minimumOutputAmount: 1n }, 100n); } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/simulation|stale|expir|quote age/i);
    }
  });
});

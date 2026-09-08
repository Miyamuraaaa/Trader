import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({ CONFIG: {
  jupiterApiKey: 'TEST_ONLY_NOT_A_KEY', jupiterBaseUrl: 'https://example.invalid/swap/v1',
  jupiterSafetyIntervalMs: 100, httpTimeoutMs: 1000, httpMaxRetries: 0,
  maxQuoteAgeMs: 5000, maxExecutionQuoteAgeMs: 1200, raptorExecutionQuoteAgeMs: 1800, quoteCacheTtlMs: 0,
} }));
vi.mock('../src/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/dispatch-diagnostics.js', () => ({ dispatchDrift: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('Jupiter shared quote/auxiliary send authority', () => {
  it('rechecks an auxiliary pacing sleep when discovery takes the legal slot', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const calls: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.push(Date.now());
      return new Response(JSON.stringify({ inputMint: 'TEST_IN', outputMint: 'TEST_OUT', inAmount: '50000',
        outAmount: '100', otherAmountThreshold: '99', swapMode: 'ExactIn', slippageBps: 5,
        priceImpactPct: '0', routePlan: [] }), { status: 200 });
    }));
    const client = await import('../src/jupiter.js');
    client.jupiterStats.lastRequestTime = Date.now();
    const auxiliary = client.getJupiterJson('https://example.invalid/markets', 'TEST');
    await vi.advanceTimersByTimeAsync(1);
    const quote = client.getQuote({ inputMint: 'TEST_IN', outputMint: 'TEST_OUT', amountAtomic: '50000', slippageBps: 5, priority: 'DISCOVERY_HIGH' });
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([auxiliary, quote]);
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(100);
  });
  it('does not overlap quote HTTP with an active auxiliary HTTP request', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    let active = 0, maximumActive = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      active++; maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 150)); active--;
      return new Response(JSON.stringify({ inputMint: 'TEST_IN', outputMint: 'TEST_OUT', inAmount: '50000',
        outAmount: '100', otherAmountThreshold: '99', swapMode: 'ExactIn', slippageBps: 5,
        priceImpactPct: '0', routePlan: [] }), { status: 200 });
    }));
    const client = await import('../src/jupiter.js');
    const auxiliary = client.getJupiterJson('https://example.invalid/markets', 'TEST');
    await vi.advanceTimersByTimeAsync(1);
    const quote = client.getQuote({ inputMint: 'TEST_IN', outputMint: 'TEST_OUT', amountAtomic: '50000', slippageBps: 5, priority: 'DISCOVERY_HIGH' });
    await vi.advanceTimersByTimeAsync(500); await Promise.all([auxiliary, quote]);
    expect(maximumActive).toBe(1); expect(active).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/config.js';
import { getRaptorQuote, normalizeRaptorQuote, raptorStats } from '../src/raptor.js';

const rawQuote = {
  inputMint: 'A',
  outputMint: 'B',
  amountIn: '1000000',
  amountOut: '2000000',
  minAmountOut: '1990000',
  feeAmount: '1000',
  priceImpact: 0.01,
  slippageBps: 50,
  contextSlot: 123,
  timeTaken: 0.001,
  routePlan: [{
    programId: 'program', dex: 'Whirlpool', pool: 'pool', inputMint: 'A', outputMint: 'B',
    amountIn: '1000000', amountOut: '2000000', feeAmount: '1000', priceImpact: 0.01, percent: 100,
  }],
};

describe('Raptor quote-only integration', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    (CONFIG as { raptorSafetyIntervalMs: number }).raptorSafetyIntervalMs = 0;
    (CONFIG as { httpMaxRetries: number }).httpMaxRetries = 0;
    raptorStats.lastRequestTime = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('normalizes the documented HTTP/stream quote shape', () => {
    const quote = normalizeRaptorQuote(rawQuote, 100, 125);
    expect(quote.provider).toBe('raptor');
    expect(quote.inAmount).toBe('1000000');
    expect(quote.outAmount).toBe('2000000');
    expect(quote.otherAmountThreshold).toBe('1990000');
    expect(quote.routePlan[0]?.swapInfo.label).toBe('Whirlpool');
    expect(quote.latencyMs).toBe(25);
  });

  it('uses only GET /quote and sends no wallet or transaction fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(rawQuote), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    await getRaptorQuote({
      inputMint: 'A', outputMint: 'B', amountAtomic: '1000001', slippageBps: 50,
    });

    const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/quote?');
    expect(String(url)).not.toMatch(/wallet|publicKey|transaction|keypair/i);
    expect(options.method).toBe('GET');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getQuote, jupiterStats, getQueueLength } from '../src/jupiter.js';
import { CONFIG } from '../src/config.js';
import { log } from '../src/logger.js';

vi.mock('../src/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    opportunity: vi.fn(),
  }
}));

describe('Jupiter API Global Rate Limiter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Reset stats
    jupiterStats.requestsThisMinute = 0;
    jupiterStats.requestsThisHour = 0;
    jupiterStats.requestsSinceStartup = 0;
    jupiterStats.successfulRequests = 0;
    jupiterStats.rateLimits429 = 0;
    jupiterStats.otherErrors = 0;
    jupiterStats.throttleState = 'IDLE';
    
    // Default mock response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        outputMint: "So11111111111111111111111111111111111111112",
        inAmount: "1000000",
        outAmount: "10000000",
        otherAmountThreshold: "9900000",
        swapMode: "ExactIn",
        slippageBps: 50,
        priceImpactPct: "0.01",
        routePlan: [],
        contextSlot: 12345,
        timeTaken: 0.1
      })
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('queues concurrent requests and enforces JUPITER_SAFETY_INTERVAL_MS', async () => {
    (CONFIG as any).jupiterSafetyIntervalMs = 1050; // Use specified safety margin
    const start = Date.now();
    
    // Fire two concurrent requests
    const p1 = getQuote({ inputMint: 'A', outputMint: 'B', amountAtomic: '1', slippageBps: 50 });
    const p2 = getQuote({ inputMint: 'B', outputMint: 'C', amountAtomic: '1', slippageBps: 50 });
    
    expect(getQueueLength()).toBeGreaterThanOrEqual(0); // Might process immediately
    
    await Promise.all([p1, p2]);
    const end = Date.now();
    
    // They cannot have completed closer together than the safety interval
    expect(end - start).toBeGreaterThanOrEqual(CONFIG.jupiterSafetyIntervalMs);
    expect(jupiterStats.successfulRequests).toBe(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('backs off on 429 and respects Retry-After', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '2' }),
          text: async () => 'Rate limit exceeded'
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          inputMint: "A", outputMint: "B", inAmount: "2", outAmount: "1",
          otherAmountThreshold: "1", swapMode: "ExactIn", slippageBps: 50,
          priceImpactPct: "0", routePlan: []
        })
      });
    }) as any;

    const start = Date.now();
    
    // First will fail with 429
    await expect(getQuote({ inputMint: 'A', outputMint: 'B', amountAtomic: '2', slippageBps: 50 }))
      .rejects.toThrow(/Jupiter API rate-limited \(429\)/);
      
    // Queue should now be in backoff
    expect(jupiterStats.rateLimits429).toBe(1);
    
    // Second request will be queued and wait for backoff (using different amount so it doesn't cache the error)
    const p2 = getQuote({ inputMint: 'A', outputMint: 'B', amountAtomic: '2.1', slippageBps: 50 });
    await p2;
    
    const end = Date.now();
    // Must have waited at least 2 seconds (the retry-after header value)
    expect(end - start).toBeGreaterThanOrEqual(2000);
  });
  
  it('does not leak API key to logs on error', async () => {
    (CONFIG as any).jupiterApiKey = 'secret-key-123';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    }) as any;

    await expect(getQuote({ inputMint: 'A', outputMint: 'B', amountAtomic: '3', slippageBps: 50 }))
      .rejects.toThrow(/Jupiter HTTP 500/);

    const logCalls = (log.warn as any).mock.calls.concat((log.error as any).mock.calls);
    const logsStr = JSON.stringify(logCalls);
    expect(logsStr).not.toContain('secret-key-123');
  });

  it('correctly tracks request budget metrics', async () => {
    await getQuote({ inputMint: 'A', outputMint: 'B', amountAtomic: '4', slippageBps: 50 });
    expect(jupiterStats.requestsSinceStartup).toBeGreaterThanOrEqual(1);
    expect(jupiterStats.successfulRequests).toBeGreaterThanOrEqual(1);
  });

  it('uses the correct base URL and does not fall back to lite-api', async () => {
    await getQuote({ inputMint: 'A', outputMint: 'B', amountAtomic: '5', slippageBps: 50 });
    const urlCalled = (globalThis.fetch as any).mock.calls.find((c: any) => c[0].includes('amount=5'))?.[0];
    expect(urlCalled).toBeDefined();
    expect(urlCalled).not.toContain('lite-api.jup.ag');
  });
});

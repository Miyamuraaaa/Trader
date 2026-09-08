import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(['jupiter', 'raptor'] as const)('bounds %s scanner queue when a network request never completes', async (provider) => {
  vi.useFakeTimers(); vi.resetModules();
  // No transport reaches the network. Pending fixture promises hold no real resources.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
  const jupiter = await import('../src/jupiter.js');
  const raptor = await import('../src/raptor.js');
  const quote = provider === 'jupiter' ? jupiter.getQuote : raptor.getRaptorQuote;
  let rejected = 0;
  for (let i = 0; i < 140; i++) {
    void quote({ inputMint: 'TEST_BASE', outputMint: 'TEST_TOKEN', amountAtomic: String(i + 1), slippageBps: 5 })
      .catch((error: unknown) => { expect(String(error)).toMatch(/queue capacity|DISCOVERY_QUEUE_(OVERFLOW|DEADLINE_EXCEEDED)/); rejected++; });
  }
  await vi.advanceTimersByTimeAsync(1);
  const queueLength = provider === 'jupiter' ? jupiter.getQueueLength() : raptor.raptorQueueHealth().queueLength;
  expect(queueLength).toBeLessThanOrEqual(128);
  expect(rejected).toBeGreaterThanOrEqual(11);
  expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(1);
});

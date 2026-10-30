import { describe, expect, it, vi } from 'vitest';
import { QuoteProviderRuntime } from '../src/provider-runtime.js';
import type { Quote, QuoteParams } from '../src/aggregators/types.js';
vi.hoisted(() => { vi.stubEnv('EXECUTION_MODE', 'paper'); vi.stubEnv('LIVE_TRADING_ENABLED', 'false'); });
vi.mock('dotenv/config', () => ({}));

// If the QuoteParams/Quote fixtures fail to compile, adapt ONLY the fixture
// shape below, never the assertions.
describe('QuoteProviderRuntime hands every caller a unique quote id', () => {
  it('coalesced waiters and cache hits never share the provider-issued id', async () => {
    const runtime = new QuoteProviderRuntime('raydium', 0, 2, 10);
    const params = { inputMint: 'a', outputMint: 'b', amountAtomic: '100', slippageBps: 5 } as unknown as QuoteParams;
    const make = () => ({ id: 'fixed', provider: 'raydium', responseTimestamp: Date.now() } as unknown as Quote);
    const [x, y] = await Promise.all([
      runtime.run('k', async () => make(), 'LOW', params),
      runtime.run('k', async () => make(), 'LOW', params),
    ]);
    expect(x.id).not.toBe(y.id);
    expect(x.id).not.toBe('fixed');
    const cached = await runtime.run('k', async () => make(), 'LOW', params);
    expect([x.id, y.id, 'fixed']).not.toContain(cached.id);
  });
});

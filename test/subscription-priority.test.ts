import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionPriorityManager } from '../src/subscription-priority.js';
afterEach(() => vi.useRealTimers());
describe('TEST DATA: subscription priority', () => {
  it('HOT displaces discovery at cap after minimum residency, without duplicate subscriptions', async () => {
    vi.useFakeTimers(); let id = 0; const subscribe = vi.fn(() => ++id); const unsubscribe = vi.fn(async () => undefined);
    const manager = new SubscriptionPriorityManager(1, subscribe, unsubscribe, () => undefined);
    manager.watch('cold', 'A', 'DISCOVERY'); await manager.rebalance();
    manager.watch('hot', 'B', 'HOT'); await manager.rebalance(); expect(subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001); expect(unsubscribe).toHaveBeenCalledTimes(1); expect(manager.active('B')).toBe(true);
    for (let i = 0; i < 20; i++) { manager.watch('hot', 'B', 'HOT'); await manager.rebalance(); }
    expect(subscribe).toHaveBeenCalledTimes(2); expect(manager.snapshot().evictions).toBe(1); await manager.stop();
  });
  it('ref-counted owners survive one release and clean up after the last owner', async () => {
    const forgotten: string[] = []; const unsubscribe = vi.fn(async () => undefined);
    const manager = new SubscriptionPriorityManager(1, () => 1, unsubscribe, (a) => forgotten.push(a));
    manager.watch('one', 'A', 'WARM'); manager.watch('two', 'A', 'HOT'); await manager.rebalance();
    manager.release('one'); await manager.rebalance(); expect(manager.active('A')).toBe(true);
    manager.release('two'); await manager.rebalance(); expect(unsubscribe).toHaveBeenCalledTimes(1); expect(forgotten).toEqual(['A']); await manager.stop();
  });
  it('bounds deferred addresses/owners and expires inactive leases', async () => {
    vi.useFakeTimers(); const manager = new SubscriptionPriorityManager(2, () => 1, async () => undefined, () => undefined, Date.now, 1000, 2000);
    for (let i = 0; i < 100; i++) manager.watch('owner', String(i), 'DISCOVERY');
    await manager.rebalance(); expect(manager.snapshot().watchedAddresses).toBeLessThanOrEqual(8);
    await vi.advanceTimersByTimeAsync(3001); expect(manager.snapshot().watchedAddresses).toBe(0); await manager.stop();
  });
  it('unsubscribe failure never creates an over-cap replacement', async () => {
    vi.useFakeTimers(); const subscribe = vi.fn(() => 1);
    const manager = new SubscriptionPriorityManager(1, subscribe, async () => { throw new Error('TEST unsubscribe failure'); }, () => undefined);
    manager.watch('one', 'A', 'DISCOVERY'); await manager.rebalance(); await vi.advanceTimersByTimeAsync(1100);
    manager.watch('two', 'B', 'EXECUTABLE'); await expect(manager.rebalance()).rejects.toThrow();
    expect(subscribe).toHaveBeenCalledTimes(1); expect(manager.active('A')).toBe(true);
    await manager.stop().catch(() => undefined);
  });
});

import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { scannerConnection } from './scanner-rpc-transport.js';
import { log } from './logger.js';
import { SubscriptionPriorityManager, type SubscriptionPriority } from './subscription-priority.js';

type MarketChangeListener = (inputMint: string, outputMint: string) => void;
type Invalidate = () => void;

interface Watcher {
  pair: [string, string];
  invalidate: Invalidate;
}

interface CachedDirectAccount {
  account: AccountInfo<Buffer>;
  slot: number;
  receivedAt: number;
}

const connection = scannerConnection(CONFIG.rpcUrl, {
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
  ...(CONFIG.scannerWsUrl ? { wsEndpoint: CONFIG.scannerWsUrl } : {}),
});
const watchers = new Map<string, Map<string, Watcher>>();
const cached = new Map<string, CachedDirectAccount>();
let listener: MarketChangeListener | undefined;
let updates = 0;
const pairPriorities = new Map<string, { priority: SubscriptionPriority; executableUntil: number }>();
const pairKey = (pair: readonly string[]) => [...pair].sort().join(':');
const manager = new SubscriptionPriorityManager(CONFIG.directMarketStreamMaxSubscriptions,
  (value) => connection.onAccountChange(new PublicKey(value), (account, context) => {
    if (!manager.active(value)) return;
    const previous = cached.get(value);
    if (previous && context.slot < previous.slot) return;
    cached.set(value, { account, slot: context.slot, receivedAt: Date.now() }); updates++;
    for (const owner of manager.owners(value)) {
      const watcher = watchers.get(value)?.get(owner);
      if (!watcher) continue;
      try { watcher.invalidate(); listener?.(...watcher.pair); }
      catch { log.debug('Direct market-state invalidation failed', { address: value }); }
    }
  }, 'confirmed'),
  async (id, address) => { await connection.removeAccountChangeListener(id); cached.delete(address); },
  (address) => { watchers.delete(address); cached.delete(address); });

export function prioritizeDirectMarketPair(pair: [string, string], priority: SubscriptionPriority): void {
  const key = pairKey(pair);
  const previous = pairPriorities.get(key);
  // A routine HOT/WARM scheduler pass must not immediately demote an active execution watch.
  const executableUntil = priority === 'EXECUTABLE' ? Date.now() + 10_000 : previous?.executableUntil ?? 0;
  if (executableUntil > Date.now()) priority = 'EXECUTABLE';
  pairPriorities.delete(key); pairPriorities.set(key, { priority, executableUntil });
  while (pairPriorities.size > 256) pairPriorities.delete(pairPriorities.keys().next().value!);
  for (const [address, owners] of watchers) for (const [owner, watcher] of owners) {
    if (pairKey(watcher.pair) === key) manager.watch(owner, address, priority);
  }
  void manager.rebalance().catch(() => log.debug('Subscription priority rebalance deferred after unsubscribe failure'));
}

export function setDirectMarketChangeListener(value: MarketChangeListener | undefined): void {
  listener = value;
}

/** Read-only targeted invalidation for direct-pool SDK state. */
export async function watchDirectMarketAccounts(
  owner: string,
  addresses: readonly string[],
  pair: [string, string],
  invalidate: Invalidate,
): Promise<void> {
  // One-shot tools do not install a market-change listener and must not leave
  // an otherwise unused WebSocket connection alive.
  if (!listener) return;
  for (const value of new Set(addresses)) {
    new PublicKey(value);
    if (!manager.watch(owner, value, pairPriorities.get(pairKey(pair))?.priority ?? 'DISCOVERY')) continue;
    let owners = watchers.get(value);
    if (!owners) {
      owners = new Map();
      watchers.set(value, owners);
    }
    owners.set(owner, { pair, invalidate });
    const activeOwners = new Set(manager.owners(value));
    for (const key of owners.keys()) if (!activeOwners.has(key)) owners.delete(key);
  }
  await manager.rebalance();
}

export function directMarketStreamHealth() {
  const newest = [...cached.values()].reduce<number | undefined>(
    (result, value) => result === undefined ? value.receivedAt : Math.max(result, value.receivedAt),
    undefined,
  );
  return {
    ...manager.snapshot(),
    subscriptions: manager.snapshot().activeSubscriptions,
    cachedAccounts: cached.size,
    updates,
    newestStateAgeMs: newest === undefined ? undefined : Date.now() - newest,
    oldestStateAgeMs: cached.size ? Date.now() - Math.min(...[...cached.values()].map((v) => v.receivedAt)) : undefined,
  };
}

export async function stopDirectMarketStream(): Promise<void> {
  await manager.stop();
  watchers.clear();
  cached.clear();
  listener = undefined;
  pairPriorities.clear();
}

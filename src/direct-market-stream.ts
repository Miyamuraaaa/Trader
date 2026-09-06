import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { log } from './logger.js';

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

const connection = new Connection(CONFIG.rpcUrl, {
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
  ...(CONFIG.scannerWsUrl ? { wsEndpoint: CONFIG.scannerWsUrl } : {}),
});
const watchers = new Map<string, Map<string, Watcher>>();
const subscriptions = new Map<string, number>();
const cached = new Map<string, CachedDirectAccount>();
let listener: MarketChangeListener | undefined;
let updates = 0;
let subscriptionCapLogAt = 0;
let subscriptionCapSkips = 0;

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
    let owners = watchers.get(value);
    if (!owners) {
      owners = new Map();
      watchers.set(value, owners);
    }
    owners.set(owner, { pair, invalidate });
    if (subscriptions.has(value)) continue;
    if (subscriptions.size >= CONFIG.directMarketStreamMaxSubscriptions) {
      subscriptionCapSkips++;
      if (Date.now() - subscriptionCapLogAt >= 10_000) {
        log.debug('Direct market-state subscription cap reached', {
          cap: CONFIG.directMarketStreamMaxSubscriptions,
          deferredAddresses: subscriptionCapSkips,
        });
        subscriptionCapSkips = 0;
        subscriptionCapLogAt = Date.now();
      }
      continue;
    }
    const id = connection.onAccountChange(new PublicKey(value), (account, context) => {
      cached.set(value, { account, slot: context.slot, receivedAt: Date.now() });
      updates++;
      for (const watcher of watchers.get(value)?.values() ?? []) {
        try {
          watcher.invalidate();
          listener?.(...watcher.pair);
        } catch (error) {
          log.debug('Direct market-state invalidation failed', {
            address: value,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }, 'confirmed');
    subscriptions.set(value, id);
  }
}

export function directMarketStreamHealth(): {
  subscriptions: number;
  cachedAccounts: number;
  updates: number;
  newestStateAgeMs?: number;
} {
  const newest = [...cached.values()].reduce<number | undefined>(
    (result, value) => result === undefined ? value.receivedAt : Math.max(result, value.receivedAt),
    undefined,
  );
  return {
    subscriptions: subscriptions.size,
    cachedAccounts: cached.size,
    updates,
    newestStateAgeMs: newest === undefined ? undefined : Date.now() - newest,
  };
}

export async function stopDirectMarketStream(): Promise<void> {
  const ids = [...subscriptions.values()];
  subscriptions.clear();
  watchers.clear();
  cached.clear();
  listener = undefined;
  subscriptionCapLogAt = 0;
  subscriptionCapSkips = 0;
  await Promise.allSettled(ids.map((id) => connection.removeAccountChangeListener(id)));
}

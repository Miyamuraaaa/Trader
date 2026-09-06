import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import { log } from '../logger.js';

export interface ExecutionAccountUpdate {
  address: string;
  account: AccountInfo<Buffer>;
  slot: number;
  receivedAt: number;
}

export interface ExecutionAccountStreamHealth {
  subscriptions: number;
  cachedAccounts: number;
  latestSlot?: number;
  latestSlotAgeMs?: number;
  updates: number;
}

type Listener = (update: ExecutionAccountUpdate) => void;

/**
 * Read-only, execution-RPC account stream shared by all prepared routes.
 * One accountSubscribe is maintained per address even when several routes use
 * it. The stream never signs, builds, simulates, or submits transactions.
 */
export class ExecutionAccountStream {
  private readonly listeners = new Map<string, Map<string, Listener>>();
  private readonly subscriptions = new Map<string, number>();
  private readonly latest = new Map<string, ExecutionAccountUpdate>();
  private slotSubscription?: number;
  private latestSlot?: number;
  private latestSlotAt?: number;
  private updates = 0;
  private stopped = false;

  constructor(private readonly connection: Connection) {}

  async start(): Promise<void> {
    if (this.slotSubscription !== undefined || this.stopped) return;
    this.slotSubscription = this.connection.onSlotChange((slot) => {
      this.latestSlot = slot.slot;
      this.latestSlotAt = Date.now();
    });
  }

  async watch(owner: string, addresses: readonly string[], listener: Listener): Promise<void> {
    if (this.stopped) throw new Error('Execution account stream is stopped');
    await this.start();
    for (const value of new Set(addresses)) {
      new PublicKey(value); // fail closed before registering a malformed address
      let owners = this.listeners.get(value);
      if (!owners) {
        owners = new Map();
        this.listeners.set(value, owners);
      }
      owners.set(owner, listener);
      if (this.subscriptions.has(value)) continue;
      const subscription = this.connection.onAccountChange(
        new PublicKey(value),
        (account, context) => {
          const update: ExecutionAccountUpdate = {
            address: value,
            account,
            slot: context.slot,
            receivedAt: Date.now(),
          };
          this.latest.set(value, update);
          this.latestSlot = Math.max(this.latestSlot ?? 0, context.slot);
          this.latestSlotAt = update.receivedAt;
          this.updates++;
          for (const callback of this.listeners.get(value)?.values() ?? []) {
            try { callback(update); } catch (error) {
              log.warn('Execution account-state listener failed', {
                address: value,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
        },
        'confirmed',
      );
      this.subscriptions.set(value, subscription);
    }
  }

  latestUpdate(address: string): ExecutionAccountUpdate | undefined {
    const value = this.latest.get(address);
    return value ? { ...value } : undefined;
  }

  currentEvidence(now = Date.now()): { slot: number; observedAt: number } | undefined {
    if (this.latestSlot === undefined || this.latestSlotAt === undefined) return undefined;
    if (now - this.latestSlotAt > CONFIG.executionWsMaxSilenceMs) return undefined;
    return { slot: this.latestSlot, observedAt: this.latestSlotAt };
  }

  health(now = Date.now()): ExecutionAccountStreamHealth {
    return {
      subscriptions: this.subscriptions.size,
      cachedAccounts: this.latest.size,
      latestSlot: this.latestSlot,
      latestSlotAgeMs: this.latestSlotAt === undefined ? undefined : Math.max(0, now - this.latestSlotAt),
      updates: this.updates,
    };
  }

  async unwatch(owner: string): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const [address, owners] of this.listeners) {
      owners.delete(owner);
      if (owners.size > 0) continue;
      this.listeners.delete(address);
      const subscription = this.subscriptions.get(address);
      this.subscriptions.delete(address);
      if (subscription !== undefined) {
        removals.push(this.connection.removeAccountChangeListener(subscription).then(() => undefined));
      }
    }
    await Promise.allSettled(removals);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const accountSubscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    this.listeners.clear();
    await Promise.allSettled(accountSubscriptions.map((subscription) =>
      this.connection.removeAccountChangeListener(subscription)));
    if (this.slotSubscription !== undefined) {
      await this.connection.removeSlotChangeListener(this.slotSubscription).catch(() => undefined);
      this.slotSubscription = undefined;
    }
  }
}

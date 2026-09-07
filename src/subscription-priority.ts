export type SubscriptionPriority = 'EXECUTABLE' | 'HOT' | 'WARM' | 'SCAN' | 'DISCOVERY';
const rank: Record<SubscriptionPriority, number> = { EXECUTABLE: 5, HOT: 4, WARM: 3, SCAN: 2, DISCOVERY: 1 };
interface Entry { owners: Map<string, { priority: SubscriptionPriority; touchedAt: number }>; id?: number; since: number; touchedAt: number; }

/** Bounded, leased owners and priority/LRU subscriptions. No silent cap increase. */
export class SubscriptionPriorityManager {
  private entries = new Map<string, Entry>();
  private scheduled?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private evictions = 0;
  constructor(private readonly cap: number,
    private readonly subscribe: (address: string) => number,
    private readonly unsubscribe: (id: number, address: string) => Promise<void>,
    private readonly onForget: (address: string) => void,
    private readonly now: () => number = Date.now,
    private readonly residencyMs = 1000,
    private readonly leaseMs = 300_000) {}

  watch(owner: string, address: string, priority: SubscriptionPriority): boolean {
    if (this.stopped || this.cap < 1) return false;
    let entry = this.entries.get(address);
    if (!entry) {
      if (this.entries.size >= this.cap * 4) {
        const victim = [...this.entries].filter(([, e]) => e.id === undefined)
          .sort((a, b) => this.score(a[1]) - this.score(b[1]) || a[1].touchedAt - b[1].touchedAt)[0];
        if (!victim || this.score(victim[1]) > rank[priority]) return false;
        this.entries.delete(victim[0]); this.onForget(victim[0]);
      }
      entry = { owners: new Map(), since: 0, touchedAt: this.now() }; this.entries.set(address, entry);
    }
    if (!entry.owners.has(owner) && entry.owners.size >= 32) return false;
    entry.owners.set(owner, { priority, touchedAt: this.now() }); entry.touchedAt = this.now();
    return true;
  }

  release(owner: string): void { for (const entry of this.entries.values()) entry.owners.delete(owner); }
  active(address: string): boolean { return this.entries.get(address)?.id !== undefined; }
  owners(address: string): string[] { return [...(this.entries.get(address)?.owners.keys() ?? [])]; }
  private score(entry: Entry): number { return Math.max(0, ...[...entry.owners.values()].map((o) => rank[o.priority])); }

  rebalance(): Promise<void> {
    if (this.scheduled) return this.scheduled;
    this.scheduled = this.balance().finally(() => { this.scheduled = undefined; });
    return this.scheduled;
  }
  private async balance(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    for (const [address, entry] of this.entries) {
      for (const [owner, value] of entry.owners) if (now - value.touchedAt > this.leaseMs) entry.owners.delete(owner);
      if (!entry.owners.size) {
        if (entry.id !== undefined) await this.unsubscribe(entry.id, address);
        this.entries.delete(address); this.onForget(address);
      }
    }
    const ordered = [...this.entries].sort((a, b) => this.score(b[1]) - this.score(a[1]) || b[1].touchedAt - a[1].touchedAt);
    for (const [address, entry] of ordered) {
      if (this.stopped) return;
      if (entry.id !== undefined) continue;
      const active = [...this.entries].filter(([, e]) => e.id !== undefined);
      if (active.length >= this.cap) {
        const victim = active.sort((a, b) => this.score(a[1]) - this.score(b[1]) || a[1].touchedAt - b[1].touchedAt)[0]!;
        const higher = this.score(entry) > this.score(victim[1]);
        const newer = this.score(entry) === this.score(victim[1]) && entry.touchedAt > victim[1].touchedAt;
        if (!higher && !newer) continue;
        if (now - victim[1].since < this.residencyMs) continue;
        await this.unsubscribe(victim[1].id!, victim[0]); victim[1].id = undefined; this.evictions++;
      }
      entry.id = this.subscribe(address); entry.since = now;
    }
    if (!this.timer && this.entries.size > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.rebalance().catch(() => undefined); }, Math.max(1000, this.residencyMs));
      this.timer.unref();
    }
  }
  snapshot() {
    const active = [...this.entries.values()].filter((e) => e.id !== undefined);
    return { activeSubscriptions: active.length, cap: this.cap, deferredSubscriptions: this.entries.size - active.length,
      evictions: this.evictions, watchedAddresses: this.entries.size,
      subscriptionsByPriority: Object.fromEntries(Object.entries(rank).map(([name, score]) => [name, active.filter((e) => this.score(e) === score).length])) };
  }
  async stop(): Promise<void> {
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    await this.scheduled;
    for (const [address, entry] of this.entries) {
      if (entry.id !== undefined) await this.unsubscribe(entry.id, address);
      this.onForget(address);
    }
    this.entries.clear();
  }
}

import { performance } from 'node:perf_hooks';
/** TTL/size bounds for advisory metadata only. No keys/values are exposed in metrics. */
export class BoundedAdvisoryCache<K, V> extends Map<K, V> {
  private expiry = new Map<K, number>();
  constructor(readonly source: string, readonly ttlMs: number, readonly capacity = 512, private readonly now: () => number = () => performance.now()) {
    super();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid advisory cache bounds');
  }
  override get(key: K): V | undefined {
    if ((this.expiry.get(key) ?? 0) <= this.now()) { this.delete(key); return undefined; }
    return super.get(key);
  }
  override has(key: K): boolean { return this.get(key) !== undefined; }
  override set(key: K, value: V): this {
    this.expiry.set(key, this.now() + this.ttlMs); super.set(key, value);
    while (this.size > this.capacity) this.delete(this.keys().next().value!);
    return this;
  }
  override delete(key: K): boolean { this.expiry.delete(key); return super.delete(key); }
  override clear(): void { this.expiry.clear(); super.clear(); }
  snapshot() {
    for (const [key, expiry] of this.expiry) if (expiry <= this.now()) this.delete(key);
    return { source: this.source, ttlMs: this.ttlMs, capacity: this.capacity, entries: this.size,
      oldestAgeMs: Math.max(0, ...[...this.expiry.values()].map((end) => this.now() - end + this.ttlMs)) };
  }
}

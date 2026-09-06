import type { QuoteProviderName } from './aggregators/types.js';

export interface PoolMetadata {
  venue: Extract<QuoteProviderName, 'orca' | 'meteora'>;
  address: string;
  tokenMintA: string;
  tokenMintB: string;
  feeRate?: number;
  poolType: string;
  tvlUsdc?: string;
}

interface CacheEntry {
  pools: PoolMetadata[];
  expiresAt: number;
}

export class PoolRegistry {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<PoolMetadata[]>>();
  readonly stats = { hits: 0, misses: 0, refreshes: 0 };

  constructor(private readonly ttlMs: number) {}

  async getOrLoad(
    venue: PoolMetadata['venue'],
    mintA: string,
    mintB: string,
    loader: () => Promise<PoolMetadata[]>,
  ): Promise<PoolMetadata[]> {
    const pair = [mintA, mintB].sort().join(':');
    const key = `${venue}:${pair}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.stats.hits++;
      return cached.pools;
    }
    this.stats.misses++;

    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = loader().then((pools) => {
      this.stats.refreshes++;
      this.cache.set(key, { pools, expiresAt: Date.now() + this.ttlMs });
      this.pending.delete(key);
      return pools;
    }).catch((error: unknown) => {
      this.pending.delete(key);
      throw error;
    });
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void {
    this.cache.clear();
  }

  trackedPairCount(): number {
    return this.cache.size;
  }

  trackedPoolCount(): number {
    return new Set(
      [...this.cache.values()].flatMap((entry) => entry.pools.map((pool) => pool.address)),
    ).size;
  }
}

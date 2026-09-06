import type { Connection } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import { log } from '../logger.js';
import {
  fetchFreshOrcaPoolSnapshots,
  type OrcaExecutionSnapshotProvider,
  type OrcaPoolSnapshot,
} from '../orca.js';
import type { PoolMetadata } from '../pool-registry.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';
import { ExecutionAccountStream } from './execution-account-stream.js';
import { getExecutionKitRpc } from './execution-connection.js';

interface PreparedRouteState {
  key: string;
  pools: PoolMetadata[];
  directionInputMint?: string;
  snapshots?: OrcaPoolSnapshot[];
  dirty: boolean;
  refreshing?: Promise<void>;
  refreshTimer?: NodeJS.Timeout;
  lastRefreshAt?: number;
  lastEventAt?: number;
  lastEventSlot?: number;
  refreshCount: number;
  failureCount: number;
  watchedAccounts: Set<string>;
}

function routeKey(pools: readonly PoolMetadata[], directionInputMint?: string): string {
  // Preserve pool order. The caller maps snapshots back to pools by index and
  // an A->B route is not interchangeable with B->A.
  return `${directionInputMint ?? 'both'}:${pools.map((pool) => pool.address).join(',')}`;
}

function snapshotAccounts(pools: readonly PoolMetadata[], snapshots: readonly OrcaPoolSnapshot[]): string[] {
  return [...new Set(snapshots.flatMap((snapshot, index) => [
    pools[index]!.address,
    String(snapshot.whirlpool.tokenVaultA),
    String(snapshot.whirlpool.tokenVaultB),
    snapshot.oracleAddress,
    ...snapshot.tickArrayAddressesByStart.values(),
  ]))];
}

/**
 * Continuously refreshed decoded Whirlpool state for the isolated executor.
 * Account subscriptions only invalidate state; the official Orca decoder/RPC
 * path rebuilds a coherent snapshot in the background after each update.
 */
export class OrcaLiveStateCache implements OrcaExecutionSnapshotProvider {
  private readonly routes = new Map<string, PreparedRouteState>();
  private stopped = false;

  constructor(
    private readonly connection: Connection,
    private readonly stream: ExecutionAccountStream,
  ) {}

  async watch(
    pools: readonly PoolMetadata[],
    directionInputMint?: string,
    profiler?: ExecutionNetworkProfiler,
  ): Promise<void> {
    if (pools.length === 0 || this.stopped) return;
    const key = routeKey(pools, directionInputMint);
    let route = this.routes.get(key);
    if (!route) {
      route = {
        key,
        pools: [...pools],
        directionInputMint,
        dirty: true,
        refreshCount: 0,
        failureCount: 0,
        watchedAccounts: new Set(pools.map((pool) => pool.address)),
      };
      this.routes.set(key, route);
      // Pool changes are observed even during the first coherent snapshot
      // fetch. Tick/oracle/vault subscriptions are added after derivation.
      await this.stream.watch(key, pools.map((pool) => pool.address), (update) => {
        this.invalidate(route!, update.slot, update.receivedAt);
      });
    }
    await this.refresh(route, profiler);
  }

  async snapshots(
    pools: readonly PoolMetadata[],
    directionInputMint: string | undefined,
    profiler?: ExecutionNetworkProfiler,
  ): Promise<OrcaPoolSnapshot[] | undefined> {
    if (this.stopped || pools.length === 0) return undefined;
    const key = routeKey(pools, directionInputMint);
    let route = this.routes.get(key);
    if (!route) {
      await this.watch(pools, directionInputMint, profiler);
      route = this.routes.get(key);
    }
    if (!route) return undefined;
    if (route.dirty || !route.snapshots) await this.refresh(route, profiler);
    const evidence = this.stream.currentEvidence();
    if (!route.snapshots || !evidence) return undefined;
    // The account data remains unchanged unless its subscription invalidates
    // this route. A recent slot notification is the evidence that the cached
    // state is still current, rather than the original discovery timestamp.
    return route.snapshots.map((snapshot) => ({
      ...snapshot,
      requestTimestamp: evidence.observedAt,
      responseTimestamp: evidence.observedAt,
      slot: Math.max(snapshot.slot ?? 0, route!.lastEventSlot ?? 0, evidence.slot),
    }));
  }

  metrics(): {
    routes: number;
    refreshes: number;
    failures: number;
    websocket: ReturnType<ExecutionAccountStream['health']>;
  } {
    return {
      routes: this.routes.size,
      refreshes: [...this.routes.values()].reduce((total, route) => total + route.refreshCount, 0),
      failures: [...this.routes.values()].reduce((total, route) => total + route.failureCount, 0),
      websocket: this.stream.health(),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const route of this.routes.values()) {
      if (route.refreshTimer) clearTimeout(route.refreshTimer);
    }
    await this.stream.stop();
    this.routes.clear();
  }

  private invalidate(route: PreparedRouteState, slot: number, receivedAt: number): void {
    route.dirty = true;
    route.lastEventSlot = Math.max(route.lastEventSlot ?? 0, slot);
    route.lastEventAt = receivedAt;
    if (route.refreshTimer || route.refreshing || this.stopped) return;
    route.refreshTimer = setTimeout(() => {
      route.refreshTimer = undefined;
      void this.refresh(route).catch((error: unknown) => {
        log.warn('Background Orca execution-state refresh failed', {
          route: route.key,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    }, CONFIG.executionPoolRefreshDebounceMs);
    route.refreshTimer.unref();
  }

  private async refresh(route: PreparedRouteState, profiler?: ExecutionNetworkProfiler): Promise<void> {
    if (route.refreshing) return route.refreshing;
    const refresh = (async () => {
      try {
        let snapshots = await fetchFreshOrcaPoolSnapshots(
          route.pools,
          getExecutionKitRpc(),
          profiler,
          route.directionInputMint,
        );
        const derivedAccounts = snapshotAccounts(route.pools, snapshots);
        const newlyDerived = derivedAccounts.filter((address) => !route.watchedAccounts.has(address));
        if (newlyDerived.length > 0) {
          await this.stream.watch(route.key, newlyDerived, (update) => {
            this.invalidate(route, update.slot, update.receivedAt);
          });
          newlyDerived.forEach((address) => route.watchedAccounts.add(address));
          // Close the one-time gap between deriving tick/oracle accounts and
          // installing their subscriptions. This normally happens during
          // background preparation; it also handles tick-boundary changes.
          snapshots = await fetchFreshOrcaPoolSnapshots(
            route.pools,
            getExecutionKitRpc(),
            profiler,
            route.directionInputMint,
          );
        }
        const evidence = this.stream.currentEvidence();
        route.snapshots = snapshots.map((snapshot) => ({
          ...snapshot,
          slot: evidence?.slot ?? route.lastEventSlot,
        }));
        route.lastRefreshAt = Date.now();
        route.dirty = false;
        route.refreshCount++;
      } catch (error) {
        route.failureCount++;
        route.dirty = true;
        throw error;
      } finally {
        route.refreshing = undefined;
      }
    })();
    route.refreshing = refresh;
    return refresh;
  }
}

import crypto from 'crypto';
import { address, type Address } from '@solana/kit';
import {
  _TICK_ARRAY_SIZE,
  getTickArrayStartTickIndex,
  swapQuoteByInputToken,
  type OracleFacade,
  type TickArrayFacade,
} from '@orca-so/whirlpools-core';
import {
  DEFAULT_WHIRLPOOL_DEPLOYMENT,
  fetchAllOracle,
  fetchAllMaybeTickArray,
  fetchAllWhirlpool,
  fetchOracle,
  fetchWhirlpool,
  getOracleAddress,
  getTickArrayAddress,
} from '@orca-so/whirlpools-client';
import { z } from 'zod';
import { CONFIG } from './config.js';
import { getJson } from './http.js';
import { PoolRegistry, type PoolMetadata } from './pool-registry.js';
import { QuoteProviderRuntime, quoteCacheKey } from './provider-runtime.js';
import { recordRpcRequests, solanaRpc } from './solana.js';
import type { ExecutionNetworkProfiler } from './execution/network-profiler.js';
import {
  assertAtomicAmount,
  type Quote,
  type QuoteParams,
  type QuoteProvider,
} from './aggregators/types.js';
import { watchDirectMarketAccounts } from './direct-market-stream.js';

const OrcaPoolSchema = z.object({
  address: z.string(),
  tokenMintA: z.string(),
  tokenMintB: z.string(),
  feeRate: z.number().optional(),
  liquidity: z.string(),
  tvlUsdc: z.string().optional(),
  poolType: z.string().default('whirlpool'),
  hasWarning: z.boolean().default(false),
});

const OrcaPoolsResponseSchema = z.object({ data: z.array(OrcaPoolSchema) });

export const orcaPoolRegistry = new PoolRegistry(CONFIG.poolCacheTtlMs);
export const orcaRuntime = new QuoteProviderRuntime(
  'orca',
  CONFIG.orcaSafetyIntervalMs,
  CONFIG.orcaQuoteConcurrency,
  CONFIG.directQuoteQueueMax,
);

type FetchedWhirlpool = Awaited<ReturnType<typeof fetchWhirlpool>>['data'];

export interface OrcaPoolSnapshot {
  whirlpool: FetchedWhirlpool;
  oracle: OracleFacade | null | undefined;
  tickArrays: TickArrayFacade[];
  tickArrayAddressesByStart: Map<number, string>;
  oracleAddress: string;
  requestTimestamp: number;
  responseTimestamp: number;
  /** Slot of the subscription/fetch evidence when available. */
  slot?: number;
}

export interface OrcaExecutionSnapshotProvider {
  snapshots(
    pools: readonly PoolMetadata[],
    directionInputMint: string | undefined,
    profiler?: ExecutionNetworkProfiler,
  ): Promise<OrcaPoolSnapshot[] | undefined>;
}

let executionSnapshotProvider: OrcaExecutionSnapshotProvider | undefined;

/** Installed only inside the isolated execution process. Scanner RPC remains separate. */
export function setOrcaExecutionSnapshotProvider(
  provider: OrcaExecutionSnapshotProvider | undefined,
): void {
  executionSnapshotProvider = provider;
}

const orcaStateCache = new Map<string, { value: OrcaPoolSnapshot; expiresAt: number }>();
const orcaStatePending = new Map<string, Promise<OrcaPoolSnapshot>>();
interface OrcaDirectionalTemplate {
  starts: number[];
  tickAddresses: Address[];
  oracleAddress: Address;
  needsOracle: boolean;
}
const orcaDirectionalTemplates = new Map<string, OrcaDirectionalTemplate>();

export async function discoverOrcaPools(inputMint: string, outputMint: string): Promise<PoolMetadata[]> {
  return orcaPoolRegistry.getOrLoad('orca', inputMint, outputMint, async () => {
    const url = new URL(CONFIG.orcaApiBaseUrl.replace(/\/$/, '') + '/pools');
    url.searchParams.set('tokensBothOf', `${inputMint},${outputMint}`);
    url.searchParams.set('sortBy', 'tvl');
    url.searchParams.set('sortDirection', 'desc');
    url.searchParams.set('size', String(CONFIG.orcaMaxPoolsPerPair));
    url.searchParams.set('minTvl', String(CONFIG.directPoolMinTvlUsdc));
    const raw = await getJson<unknown>(url.toString(), {}, {
      provider: 'Orca pool discovery',
      maxRetries: Math.min(CONFIG.httpMaxRetries, 2),
    });
    const parsed = OrcaPoolsResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Unexpected Orca pool list shape: ${parsed.error.message}`);
    return parsed.data.data
      .filter((pool) => !pool.hasWarning && BigInt(pool.liquidity) > 0n)
      .map((pool) => ({
        venue: 'orca' as const,
        address: pool.address,
        tokenMintA: pool.tokenMintA,
        tokenMintB: pool.tokenMintB,
        feeRate: pool.feeRate,
        poolType: pool.poolType,
        tvlUsdc: pool.tvlUsdc,
      }));
  });
}

function emptyTickArray(startTickIndex: number): TickArrayFacade {
  return {
    startTickIndex,
    ticks: Array.from({ length: _TICK_ARRAY_SIZE() }, () => ({
      initialized: false,
      liquidityNet: 0n,
      liquidityGross: 0n,
      feeGrowthOutsideA: 0n,
      feeGrowthOutsideB: 0n,
      rewardGrowthsOutside: [0n, 0n, 0n],
    })),
  };
}

export function quoteOrcaPoolFromSnapshot(
  pool: PoolMetadata,
  params: QuoteParams,
  snapshot: OrcaPoolSnapshot,
): Quote {
  const whirlpool = snapshot.whirlpool;
  if (whirlpool.tokenMintA !== params.inputMint && whirlpool.tokenMintB !== params.inputMint) {
    throw new Error(`Orca pool ${pool.address} does not contain the input mint`);
  }

  const specifiedTokenA = whirlpool.tokenMintA === params.inputMint;
  const result = swapQuoteByInputToken(
    BigInt(params.amountAtomic),
    specifiedTokenA,
    params.slippageBps,
    whirlpool,
    snapshot.oracle,
    snapshot.tickArrays,
    BigInt(Math.floor(Date.now() / 1000)),
  );
  if (result.tokenIn !== BigInt(params.amountAtomic)) {
    throw new Error(`Orca pool ${pool.address} did not consume the exact requested input`);
  }
  if (result.tokenEstOut <= 0n) throw new Error(`Orca pool ${pool.address} returned zero output`);

  return {
    provider: 'orca',
    id: crypto.randomUUID(),
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmount: params.amountAtomic,
    consumedInAmount: result.tokenIn.toString(),
    outAmount: result.tokenEstOut.toString(),
    otherAmountThreshold: result.tokenMinOut.toString(),
    swapMode: 'ExactIn',
    slippageBps: params.slippageBps,
    platformFee: null,
    feeAmount: result.tradeFee.toString(),
    feeMint: params.inputMint,
    routePlan: [{
      swapInfo: {
        label: 'Orca Whirlpool',
        ammKey: pool.address,
        programId: String(DEFAULT_WHIRLPOOL_DEPLOYMENT.programId),
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: params.amountAtomic,
        outAmount: result.tokenEstOut.toString(),
        feeAmount: result.tradeFee.toString(),
        feeMint: params.inputMint,
      },
      percent: 100,
    }],
    poolIds: [pool.address],
    isPartialFill: false,
    requestTimestamp: snapshot.requestTimestamp,
    responseTimestamp: snapshot.responseTimestamp,
    latencyMs: snapshot.responseTimestamp - snapshot.requestTimestamp,
    rawResponse: JSON.stringify({
      pool: pool.address,
      tokenIn: result.tokenIn.toString(),
      tokenEstOut: result.tokenEstOut.toString(),
      tokenMinOut: result.tokenMinOut.toString(),
      tradeFee: result.tradeFee.toString(),
      tradeFeeRateMin: result.tradeFeeRateMin,
      tradeFeeRateMax: result.tradeFeeRateMax,
      stateTimestamp: snapshot.responseTimestamp,
    }),
  };
}

export async function quoteOrcaPool(pool: PoolMetadata, params: QuoteParams): Promise<Quote> {
  return quoteOrcaPoolFromSnapshot(pool, params, await getOrcaPoolSnapshot(pool));
}

async function fetchOrcaPoolSnapshot(pool: PoolMetadata): Promise<OrcaPoolSnapshot> {
  const requestTimestamp = Date.now();
  const poolAddress = address(pool.address);
  recordRpcRequests();
  const whirlpoolAccount = await fetchWhirlpool(solanaRpc, poolAddress);
  const whirlpool = whirlpoolAccount.data;

  const start = getTickArrayStartTickIndex(whirlpool.tickCurrentIndex, whirlpool.tickSpacing);
  const offset = whirlpool.tickSpacing * _TICK_ARRAY_SIZE();
  const starts = [start, start + offset, start + offset * 2, start - offset, start - offset * 2];
  const tickAddresses = await Promise.all(starts.map(async (index) =>
    (await getTickArrayAddress(poolAddress, index, DEFAULT_WHIRLPOOL_DEPLOYMENT.programId))[0],
  ));
  const tickArraysPromise = (async () => {
    recordRpcRequests();
    return fetchAllMaybeTickArray(solanaRpc, tickAddresses);
  })();
  // This speculative read can finish before later account derivation work. If
  // that later work fails, retain the original error but never let a parallel
  // public-RPC 429 escape as an unhandled rejection.
  void tickArraysPromise.catch(() => undefined);

  const oracleAddress = (await getOracleAddress(
    poolAddress,
    DEFAULT_WHIRLPOOL_DEPLOYMENT.programId,
  ))[0];

  const feeTierIndex = whirlpool.feeTierIndexSeed[0]!
    + whirlpool.feeTierIndexSeed[1]! * 256;
  const oraclePromise = feeTierIndex !== whirlpool.tickSpacing
    ? (async () => {
      recordRpcRequests();
      return (await fetchOracle(solanaRpc, oracleAddress)).data;
    })()
    : Promise.resolve(undefined);
  void oraclePromise.catch(() => undefined);
  const [maybeTickArrays, oracle] = await Promise.all([tickArraysPromise, oraclePromise]);
  const tickArrays: TickArrayFacade[] = maybeTickArrays.map((account, index) =>
    account.exists ? account.data : emptyTickArray(starts[index]!),
  );

  const responseTimestamp = Date.now();
  const snapshot: OrcaPoolSnapshot = {
    whirlpool,
    oracle,
    tickArrays,
    tickArrayAddressesByStart: new Map(
      starts.map((value, index) => [value, String(tickAddresses[index]!) ]),
    ),
    oracleAddress: String(oracleAddress),
    requestTimestamp,
    responseTimestamp,
  };
  void watchDirectMarketAccounts(
    `orca:${pool.address}`,
    [
      pool.address,
      String(whirlpool.tokenVaultA),
      String(whirlpool.tokenVaultB),
      String(oracleAddress),
      ...tickAddresses.map(String),
    ],
    [pool.tokenMintA, pool.tokenMintB],
    () => orcaStateCache.delete(pool.address),
  ).catch(() => undefined);
  return snapshot;
}

export async function getOrcaPoolSnapshot(pool: PoolMetadata): Promise<OrcaPoolSnapshot> {
  const cached = orcaStateCache.get(pool.address);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) orcaStateCache.delete(pool.address);
  const pending = orcaStatePending.get(pool.address);
  if (pending) return pending;
  const load = fetchOrcaPoolSnapshot(pool)
    .then((value) => {
      orcaStateCache.set(pool.address, {
        value,
        expiresAt: Date.now() + Math.min(CONFIG.poolStateCacheTtlMs, CONFIG.maxQuoteAgeMs),
      });
      return value;
    })
    .finally(() => orcaStatePending.delete(pool.address));
  orcaStatePending.set(pool.address, load);
  return load;
}

/**
 * Execution validation must quote from newly fetched state. This bypasses the
 * short-lived quote cache while leaving discovery metadata cacheable.
 */
export function getFreshOrcaPoolSnapshot(pool: PoolMetadata): Promise<OrcaPoolSnapshot> {
  return fetchOrcaPoolSnapshot(pool);
}

/**
 * Fetches a set of execution-critical pool snapshots with bounded, batched RPC
 * reads.  Unlike the discovery cache, this always reads current mainnet state.
 * Account ordering is preserved by the generated Orca client, so each decoded
 * account is matched back to the exact address supplied in the same position.
 */
export async function fetchFreshOrcaPoolSnapshots(
  pools: readonly PoolMetadata[],
  rpc: typeof solanaRpc = solanaRpc,
  profiler?: ExecutionNetworkProfiler,
  directionInputMint?: string,
): Promise<OrcaPoolSnapshot[]> {
  const executionFetchConfig = () => ({
    commitment: 'confirmed' as const,
    abortSignal: AbortSignal.timeout(CONFIG.executionRpcTimeoutMs),
  });
  if (pools.length === 0) return [];
  const requestTimestamp = Date.now();
  const poolAddresses = pools.map((pool) => address(pool.address));

  const templateKeys = directionInputMint
    ? pools.map((pool) => `${pool.address}:${directionInputMint}`)
    : [];
  const templates = templateKeys.map((key) => orcaDirectionalTemplates.get(key));
  const canPrefetchDirectionalAccounts = directionInputMint !== undefined
    && templates.length === pools.length && templates.every((template) => template !== undefined);

  const prefetchedAccountsPromise = canPrefetchDirectionalAccounts ? (() => {
    const cachedTemplates = templates as OrcaDirectionalTemplate[];
    const tickAddresses = cachedTemplates.flatMap((template) => template.tickAddresses);
    recordRpcRequests();
    const ticks = profiler
      ? profiler.measure('rpc.orca.prefetchTickArrays', 'rpc', () =>
        fetchAllMaybeTickArray(rpc, tickAddresses, executionFetchConfig()))
      : fetchAllMaybeTickArray(rpc, tickAddresses, executionFetchConfig());
    const oracleTemplates = cachedTemplates.filter((template) => template.needsOracle);
    const oracles = oracleTemplates.length > 0
      ? (recordRpcRequests(), profiler
        ? profiler.measure('rpc.orca.prefetchOracles', 'rpc', () =>
          fetchAllOracle(rpc, oracleTemplates.map((template) => template.oracleAddress), executionFetchConfig()))
        : fetchAllOracle(rpc, oracleTemplates.map((template) => template.oracleAddress), executionFetchConfig()))
      : Promise.resolve([]);
    const prefetched = Promise.all([ticks, oracles]);
    // The pool-state request is awaited before this speculative request is
    // consumed. Attach a handler immediately so a timeout cannot surface as an
    // unhandled rejection while the independent pool read is still pending.
    void prefetched.catch(() => undefined);
    return prefetched;
  })() : undefined;

  recordRpcRequests();
  const loadWhirlpools = () => fetchAllWhirlpool(rpc, poolAddresses, executionFetchConfig());
  const whirlpoolAccounts = profiler
    ? await profiler.measure('rpc.orca.fetchAllWhirlpool', 'rpc', loadWhirlpools)
    : await loadWhirlpools();

  const descriptors = await Promise.all(whirlpoolAccounts.map(async (account, poolIndex) => {
    const whirlpool = account.data;
    const start = getTickArrayStartTickIndex(whirlpool.tickCurrentIndex, whirlpool.tickSpacing);
    const offset = whirlpool.tickSpacing * _TICK_ARRAY_SIZE();
    const starts = directionInputMint
      ? (String(whirlpool.tokenMintA) === directionInputMint
        ? [start, start - offset, start - offset * 2]
        : String(whirlpool.tokenMintB) === directionInputMint
          ? [start, start + offset, start + offset * 2]
          : (() => { throw new Error('Execution input mint is not present in the Orca pool'); })())
      : [start, start + offset, start + offset * 2, start - offset, start - offset * 2];
    const tickAddresses = await Promise.all(starts.map(async (index) =>
      (await getTickArrayAddress(poolAddresses[poolIndex]!, index, DEFAULT_WHIRLPOOL_DEPLOYMENT.programId))[0],
    ));
    const oracleAddress = (await getOracleAddress(
      poolAddresses[poolIndex]!,
      DEFAULT_WHIRLPOOL_DEPLOYMENT.programId,
    ))[0];
    const feeTierIndex = whirlpool.feeTierIndexSeed[0]! + whirlpool.feeTierIndexSeed[1]! * 256;
    const descriptor = {
      whirlpool,
      starts,
      tickAddresses,
      oracleAddress,
      needsOracle: feeTierIndex !== whirlpool.tickSpacing,
    };
    if (directionInputMint) {
      orcaDirectionalTemplates.set(templateKeys[poolIndex]!, {
        starts, tickAddresses, oracleAddress, needsOracle: descriptor.needsOracle,
      });
    }
    return descriptor;
  }));

  const allTickAddresses = descriptors.flatMap((descriptor) => descriptor.tickAddresses);
  const oracleDescriptors = descriptors.filter((descriptor) => descriptor.needsOracle);
  const templatesStillMatch = canPrefetchDirectionalAccounts && templates.every((template, index) => {
    const descriptor = descriptors[index]!;
    return template!.starts.length === descriptor.starts.length
      && template!.starts.every((start, startIndex) => start === descriptor.starts[startIndex])
      && String(template!.oracleAddress) === String(descriptor.oracleAddress);
  });
  let maybeTickArrays: Awaited<ReturnType<typeof fetchAllMaybeTickArray>>;
  let oracleAccounts: Awaited<ReturnType<typeof fetchAllOracle>>;
  if (prefetchedAccountsPromise && templatesStillMatch) {
    [maybeTickArrays, oracleAccounts] = await prefetchedAccountsPromise;
  } else {
    // Await and discard a speculative request before issuing corrected addresses,
    // preventing an unhandled rejection if the pool crossed a tick-array boundary.
    if (prefetchedAccountsPromise) await prefetchedAccountsPromise;
    recordRpcRequests();
    const loadTicks = () => fetchAllMaybeTickArray(rpc, allTickAddresses, executionFetchConfig());
    const maybeTickArraysPromise = profiler
      ? profiler.measure('rpc.orca.fetchAllMaybeTickArray', 'rpc', loadTicks)
      : loadTicks();
    const oracleAccountsPromise = oracleDescriptors.length > 0
      ? (recordRpcRequests(), profiler
        ? profiler.measure('rpc.orca.fetchAllOracle', 'rpc', () =>
          fetchAllOracle(rpc, oracleDescriptors.map((descriptor) => descriptor.oracleAddress), executionFetchConfig()))
        : fetchAllOracle(rpc, oracleDescriptors.map((descriptor) => descriptor.oracleAddress), executionFetchConfig()))
      : Promise.resolve([]);
    [maybeTickArrays, oracleAccounts] = await Promise.all([maybeTickArraysPromise, oracleAccountsPromise]);
  }
  const oracleByAddress = new Map(oracleDescriptors.map((descriptor, index) => [
    String(descriptor.oracleAddress),
    oracleAccounts[index]!.data,
  ]));
  const responseTimestamp = Date.now();

  return descriptors.map((descriptor, poolIndex) => {
    const tickOffset = poolIndex * descriptor.starts.length;
    const tickArrays: TickArrayFacade[] = descriptor.starts.map((startTickIndex, index) => {
      const account = maybeTickArrays[tickOffset + index]!;
      return account.exists ? account.data : emptyTickArray(startTickIndex);
    });
    return {
      whirlpool: descriptor.whirlpool,
      oracle: descriptor.needsOracle ? oracleByAddress.get(String(descriptor.oracleAddress)) : undefined,
      tickArrays,
      tickArrayAddressesByStart: new Map(
        descriptor.starts.map((value, index) => [value, String(descriptor.tickAddresses[index]!)]),
      ),
      oracleAddress: String(descriptor.oracleAddress),
      requestTimestamp,
      responseTimestamp,
    };
  });
}

/**
 * Execution builders prefer continuously maintained subscribed state. If the
 * execution WebSocket is not healthy or the route has not been prepared yet,
 * the same bounded fresh RPC fetch remains the fail-closed fallback.
 */
export async function getFreshOrcaPoolSnapshots(
  pools: readonly PoolMetadata[],
  rpc: typeof solanaRpc = solanaRpc,
  profiler?: ExecutionNetworkProfiler,
  directionInputMint?: string,
): Promise<OrcaPoolSnapshot[]> {
  const streamed = await executionSnapshotProvider?.snapshots(
    pools, directionInputMint, profiler,
  );
  if (streamed) return streamed;
  return fetchFreshOrcaPoolSnapshots(pools, rpc, profiler, directionInputMint);
}

async function executeOrcaQuote(params: QuoteParams): Promise<Quote> {
  assertAtomicAmount(params.amountAtomic, 'Orca amount');
  const pools = await discoverOrcaPools(params.inputMint, params.outputMint);
  if (pools.length === 0) throw new Error('No sufficiently liquid direct Orca Whirlpool found');

  const settled = await Promise.allSettled(pools.map((pool) => quoteOrcaPool(pool, params)));
  const quotes = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (quotes.length === 0) {
    const reasons = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [],
    );
    throw new Error(`All candidate Orca pools failed: ${reasons.join('; ')}`);
  }
  const best = quotes.sort((a, b) => BigInt(a.outAmount) > BigInt(b.outAmount) ? -1 : 1)[0]!;
  return best;
}

export function getOrcaQuote(params: QuoteParams): Promise<Quote> {
  const key = quoteCacheKey([
    params.inputMint,
    params.outputMint,
    params.amountAtomic,
    params.slippageBps,
  ]);
  return orcaRuntime.run(key, () => executeOrcaQuote(params), params.priority);
}

export const orcaProvider: QuoteProvider = {
  name: 'orca',
  kind: 'direct',
  capabilities: {
    quote: true,
    dryRun: false,
    execution: false,
    streaming: false,
    atomicCycle: false,
  },
  supportsPair: async (inputMint, outputMint) => inputMint !== outputMint
    && (await discoverOrcaPools(inputMint, outputMint)).length > 0,
  health: () => orcaRuntime.health(),
  getQuote: getOrcaQuote,
  isRateLimited: () => orcaRuntime.isCoolingDown(),
};

import crypto from 'crypto';
import { createRequire } from 'node:module';
import type MeteoraDlmm from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { z } from 'zod';
import { CONFIG } from './config.js';
import { getJson } from './http.js';
import { PoolRegistry, type PoolMetadata } from './pool-registry.js';
import { QuoteProviderRuntime, quoteCacheKey } from './provider-runtime.js';
import { recordRpcRequests } from './solana.js';
import {
  assertAtomicAmount,
  type Quote,
  type QuoteParams,
  type QuoteProvider,
} from './aggregators/types.js';
import { watchDirectMarketAccounts } from './direct-market-stream.js';
import { scannerConnection } from './scanner-rpc-transport.js';

// @meteora-ag/dlmm 1.9.14 publishes both ESM and CommonJS. Its ESM build uses
// a named BN import that Node 22 cannot resolve from Anchor's CommonJS export.
// Loading the package's published CommonJS entry avoids that package-format
// incompatibility; it does not change or patch any SDK quote behavior.
const require = createRequire(import.meta.url);
function loadMeteoraSdk(): typeof MeteoraDlmm {
  // bigint-buffer's optional native addon is not required for correctness. On
  // Windows installations without the Visual C++ workload it emits this warning
  // even though it immediately selects its supported pure-JavaScript fallback.
  // Suppress only that exact dependency warning while the SDK is loaded; all
  // other warnings continue to be reported normally.
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args[0] === 'bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)') return;
    originalWarn(...args);
  };
  try {
    return require('@meteora-ag/dlmm') as typeof MeteoraDlmm;
  } finally {
    console.warn = originalWarn;
  }
}

const DLMM = loadMeteoraSdk();

const MeteoraTokenSchema = z.object({
  address: z.string(),
  decimals: z.number(),
  symbol: z.string().optional(),
});

const MeteoraPoolSchema = z.object({
  address: z.string(),
  name: z.string(),
  token_x: MeteoraTokenSchema,
  token_y: MeteoraTokenSchema,
  tvl: z.number(),
  is_blacklisted: z.boolean(),
  pool_config: z.object({
    bin_step: z.number(),
    base_fee_pct: z.number().optional(),
  }),
});

const MeteoraPoolsResponseSchema = z.object({ data: z.array(MeteoraPoolSchema) });

const connection = scannerConnection(CONFIG.rpcUrl, {
  commitment: 'confirmed',
  // The SDK's default web3.js behavior retries 429s internally several times,
  // outside our provider scheduler. Disable that hidden retry layer so the
  // scanner's bounded cooldown/circuit logic remains the only retry policy.
  disableRetryOnRateLimit: true,
});
export const meteoraPoolRegistry = new PoolRegistry(CONFIG.poolCacheTtlMs);
export const meteoraRuntime = new QuoteProviderRuntime(
  'meteora',
  CONFIG.meteoraSafetyIntervalMs,
  CONFIG.meteoraQuoteConcurrency,
  CONFIG.directQuoteQueueMax,
);

type MeteoraBinArrays = Awaited<ReturnType<MeteoraDlmm['getBinArrayForSwap']>>;

interface MeteoraPoolsSnapshot {
  pools: MeteoraDlmm[];
  requestTimestamp: number;
  responseTimestamp: number;
}

interface MeteoraBinSnapshot {
  binArrays: MeteoraBinArrays;
  requestTimestamp: number;
  responseTimestamp: number;
}

const meteoraPoolsCache = new Map<string, { value: MeteoraPoolsSnapshot; expiresAt: number }>();
const meteoraPoolsPending = new Map<string, Promise<MeteoraPoolsSnapshot>>();
const meteoraBinCache = new Map<string, { value: MeteoraBinSnapshot; expiresAt: number }>();
const meteoraBinPending = new Map<string, Promise<MeteoraBinSnapshot>>();

function stateTtlMs(): number {
  return Math.min(CONFIG.poolStateCacheTtlMs, CONFIG.maxQuoteAgeMs);
}

async function discoverMeteoraPools(inputMint: string, outputMint: string): Promise<PoolMetadata[]> {
  return meteoraPoolRegistry.getOrLoad('meteora', inputMint, outputMint, async () => {
    const url = new URL(CONFIG.meteoraApiBaseUrl.replace(/\/$/, '') + '/pools');
    url.searchParams.set('page', '1');
    url.searchParams.set('page_size', String(Math.max(10, CONFIG.meteoraMaxPoolsPerPair * 5)));
    url.searchParams.set('query', inputMint);
    url.searchParams.set('sort_by', 'tvl:desc');
    url.searchParams.set(
      'filter_by',
      `is_blacklisted=false && tvl>${CONFIG.directPoolMinTvlUsdc}`,
    );
    const raw = await getJson<unknown>(url.toString(), {}, {
      provider: 'Meteora pool discovery',
      maxRetries: Math.min(CONFIG.httpMaxRetries, 2),
    });
    const parsed = MeteoraPoolsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Unexpected Meteora pool list shape: ${parsed.error.message}`);
    }
    return parsed.data.data
      .filter((pool) => {
        const pair = new Set([pool.token_x.address, pool.token_y.address]);
        return !pool.is_blacklisted
          && pool.tvl >= CONFIG.directPoolMinTvlUsdc
          && pair.has(inputMint)
          && pair.has(outputMint);
      })
      .slice(0, CONFIG.meteoraMaxPoolsPerPair)
      .map((pool) => ({
        venue: 'meteora' as const,
        address: pool.address,
        tokenMintA: pool.token_x.address,
        tokenMintB: pool.token_y.address,
        feeRate: pool.pool_config.base_fee_pct,
        poolType: `dlmm-bin-${pool.pool_config.bin_step}`,
        tvlUsdc: String(pool.tvl),
      }));
  });
}

function quoteMeteoraPool(
  pool: MeteoraDlmm,
  metadata: PoolMetadata,
  params: QuoteParams,
  poolSnapshot: MeteoraPoolsSnapshot,
): Promise<Quote> {
  return (async () => {
    const tokenX = pool.tokenX.publicKey.toBase58();
    const tokenY = pool.tokenY.publicKey.toBase58();
    if (!new Set([tokenX, tokenY]).has(params.inputMint)
      || !new Set([tokenX, tokenY]).has(params.outputMint)) {
      throw new Error(`Meteora pool ${metadata.address} does not match requested mints`);
    }

    // Installed SDK source confirms true means token X -> token Y.
    const swapForY = tokenX === params.inputMint;
    const binSnapshot = await getMeteoraBinSnapshot(pool, metadata.address, swapForY);
    const result = pool.swapQuote(
      new BN(params.amountAtomic),
      swapForY,
      new BN(params.slippageBps),
      binSnapshot.binArrays,
      true,
    );
    void watchDirectMarketAccounts(
      `meteora:${metadata.address}`,
      [metadata.address, ...result.binArraysPubkey.map(String)],
      [params.inputMint, params.outputMint],
      () => {
        meteoraPoolsCache.clear();
        meteoraBinCache.delete(`${metadata.address}|x-to-y`);
        meteoraBinCache.delete(`${metadata.address}|y-to-x`);
      },
    ).catch(() => undefined);
    // Use the oldest state timestamp so downstream freshness checks account for
    // the brief snapshot reuse instead of pretending every local calculation
    // performed a new RPC read.
    const requestTimestamp = Math.min(poolSnapshot.requestTimestamp, binSnapshot.requestTimestamp);
    const responseTimestamp = Math.min(poolSnapshot.responseTimestamp, binSnapshot.responseTimestamp);
    const consumed = result.consumedInAmount.toString(10);
    const outAmount = result.outAmount.toString(10);
    const minOutAmount = result.minOutAmount.toString(10);
    if (BigInt(consumed) <= 0n || BigInt(outAmount) <= 0n) {
      throw new Error(`Meteora pool ${metadata.address} returned zero fill`);
    }

    return {
      provider: 'meteora',
      id: crypto.randomUUID(),
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amountAtomic,
      consumedInAmount: consumed,
      outAmount,
      otherAmountThreshold: minOutAmount,
      swapMode: 'ExactIn',
      slippageBps: params.slippageBps,
      priceImpactPct: result.priceImpact.toString(),
      platformFee: null,
      feeAmount: result.fee.toString(10),
      feeMint: result.feeOnInput ? params.inputMint : params.outputMint,
      routePlan: [{
        swapInfo: {
          label: 'Meteora DLMM',
          ammKey: metadata.address,
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          inAmount: consumed,
          outAmount,
          feeAmount: result.fee.toString(10),
          feeMint: result.feeOnInput ? params.inputMint : params.outputMint,
        },
        percent: 100,
      }],
      poolIds: [metadata.address],
      isPartialFill: consumed !== params.amountAtomic,
      requestTimestamp,
      responseTimestamp,
      latencyMs: responseTimestamp - requestTimestamp,
      rawResponse: JSON.stringify({
        pool: metadata.address,
        consumedInAmount: consumed,
        outAmount,
        minOutAmount,
        fee: result.fee.toString(10),
        protocolFee: result.protocolFee.toString(10),
        priceImpactPct: result.priceImpact.toString(),
        feeOnInput: result.feeOnInput,
        binArrays: result.binArraysPubkey.map(String),
      }),
    };
  })();
}

async function getMeteoraPoolsSnapshot(metadata: PoolMetadata[]): Promise<MeteoraPoolsSnapshot> {
  const key = metadata.map((pool) => pool.address).sort().join('|');
  const cached = meteoraPoolsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) meteoraPoolsCache.delete(key);
  const pending = meteoraPoolsPending.get(key);
  if (pending) return pending;

  const load = (async () => {
    const requestTimestamp = Date.now();
    recordRpcRequests();
    const pools = await DLMM.createMultiple(
      connection,
      metadata.map((pool) => new PublicKey(pool.address)),
      { cluster: 'mainnet-beta' },
    );
    const value = { pools, requestTimestamp, responseTimestamp: Date.now() };
    meteoraPoolsCache.set(key, { value, expiresAt: Date.now() + stateTtlMs() });
    return value;
  })().finally(() => meteoraPoolsPending.delete(key));
  meteoraPoolsPending.set(key, load);
  return load;
}

async function getMeteoraBinSnapshot(
  pool: MeteoraDlmm,
  poolAddress: string,
  swapForY: boolean,
): Promise<MeteoraBinSnapshot> {
  const key = `${poolAddress}|${swapForY ? 'x-to-y' : 'y-to-x'}`;
  const cached = meteoraBinCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) meteoraBinCache.delete(key);
  const pending = meteoraBinPending.get(key);
  if (pending) return pending;

  const load = (async () => {
    const requestTimestamp = Date.now();
    recordRpcRequests();
    const binArrays = await pool.getBinArrayForSwap(swapForY, 4);
    const value = { binArrays, requestTimestamp, responseTimestamp: Date.now() };
    meteoraBinCache.set(key, { value, expiresAt: Date.now() + stateTtlMs() });
    return value;
  })().finally(() => meteoraBinPending.delete(key));
  meteoraBinPending.set(key, load);
  return load;
}

async function executeMeteoraQuote(params: QuoteParams): Promise<Quote> {
  assertAtomicAmount(params.amountAtomic, 'Meteora amount');
  const metadata = await discoverMeteoraPools(params.inputMint, params.outputMint);
  if (metadata.length === 0) throw new Error('No sufficiently liquid direct Meteora DLMM pool found');

  const poolSnapshot = await getMeteoraPoolsSnapshot(metadata);
  const settled = await Promise.allSettled(poolSnapshot.pools.map((pool, index) =>
    quoteMeteoraPool(pool, metadata[index]!, params, poolSnapshot),
  ));
  const quotes = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (quotes.length === 0) {
    const reasons = settled.flatMap((result) =>
      result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    throw new Error(`All candidate Meteora pools failed: ${reasons.join('; ')}`);
  }

  const fullFills = quotes.filter((quote) => !quote.isPartialFill);
  const comparable = fullFills.length > 0 ? fullFills : quotes;
  const best = comparable.sort((a, b) => BigInt(a.outAmount) > BigInt(b.outAmount) ? -1 : 1)[0]!;
  return best;
}

export function getMeteoraQuote(params: QuoteParams): Promise<Quote> {
  const key = quoteCacheKey([
    params.inputMint,
    params.outputMint,
    params.amountAtomic,
    params.slippageBps,
  ]);
  return meteoraRuntime.run(key, () => executeMeteoraQuote(params), params.priority, params);
}

export const meteoraProvider: QuoteProvider = {
  name: 'meteora',
  kind: 'direct',
  capabilities: {
    quote: true,
    dryRun: false,
    execution: false,
    // DLMM account updates invalidate SDK state and wake the pair scheduler.
    // The quarantined transaction prototype is not a live execution adapter.
    streaming: true,
    atomicCycle: false,
  },
  supportsPair: async (inputMint, outputMint) => inputMint !== outputMint
    && (await discoverMeteoraPools(inputMint, outputMint)).length > 0,
  health: () => meteoraRuntime.health(),
  getQuote: getMeteoraQuote,
  isRateLimited: () => meteoraRuntime.isCoolingDown(),
};

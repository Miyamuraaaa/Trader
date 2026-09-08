import crypto from 'crypto';
import { z } from 'zod';
import { CONFIG } from './config.js';
import { getJson } from './http.js';
import { QuoteProviderRuntime, quoteCacheKey } from './provider-runtime.js';
import {
  assertAtomicAmount,
  type Quote,
  type QuoteParams,
  type QuoteProvider,
} from './aggregators/types.js';
import { watchDirectMarketAccounts } from './direct-market-stream.js';

const AtomicString = z.string().regex(/^(0|[1-9]\d*)$/);
const NumericValue = z.union([z.number(), z.string()]).transform(String);

const RaydiumRouteStepSchema = z.object({
  poolId: z.string(),
  inputMint: z.string(),
  outputMint: z.string(),
  feeMint: z.string().optional(),
  feeRate: z.number().optional(),
  feeAmount: AtomicString.optional(),
}).passthrough();

const RaydiumSuccessSchema = z.object({
  id: z.string(),
  success: z.literal(true),
  version: z.string(),
  data: z.object({
    swapType: z.string(),
    inputMint: z.string(),
    inputAmount: AtomicString,
    actualInputAmount: AtomicString.optional(),
    outputMint: z.string(),
    outputAmount: AtomicString,
    otherAmountThreshold: AtomicString,
    slippageBps: z.number(),
    priceImpactPct: NumericValue,
    routePlan: z.array(RaydiumRouteStepSchema).default([]),
  }).passthrough(),
});

const RaydiumFailureSchema = z.object({
  success: z.literal(false),
  msg: z.string().optional(),
});

export const raydiumRuntime = new QuoteProviderRuntime(
  'raydium',
  CONFIG.raydiumSafetyIntervalMs,
  CONFIG.raydiumQuoteConcurrency,
  CONFIG.directQuoteQueueMax,
);

export function normalizeRaydiumQuote(
  raw: unknown,
  requested: QuoteParams,
  requestTimestamp: number,
  responseTimestamp: number,
): Quote {
  const failure = RaydiumFailureSchema.safeParse(raw);
  if (failure.success) {
    throw new Error(`Raydium quote unavailable: ${failure.data.msg ?? 'no route or liquidity'}`);
  }

  const parsed = RaydiumSuccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Unexpected Raydium quote shape: ${parsed.error.message}`);
  }
  const q = parsed.data.data;
  if (q.swapType !== 'BaseIn') throw new Error(`Raydium returned unsupported swap type ${q.swapType}`);
  if (q.inputMint !== requested.inputMint || q.outputMint !== requested.outputMint) {
    throw new Error('Raydium returned a quote for different mints');
  }
  if (q.inputAmount !== requested.amountAtomic) {
    throw new Error('Raydium returned a quote for a different input amount');
  }
  if (BigInt(q.outputAmount) <= 0n || q.routePlan.length === 0) {
    throw new Error('Raydium returned zero liquidity or an empty route');
  }

  const consumed = q.actualInputAmount ?? q.inputAmount;
  assertAtomicAmount(consumed, 'Raydium actualInputAmount');
  const feeMints = new Set(q.routePlan.flatMap((step) => step.feeMint ? [step.feeMint] : []));
  const topLevelFee = feeMints.size === 1
    ? q.routePlan.reduce((sum, step) => sum + BigInt(step.feeAmount ?? '0'), 0n).toString()
    : undefined;

  return {
    provider: 'raydium',
    id: parsed.data.id || crypto.randomUUID(),
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inAmount: q.inputAmount,
    consumedInAmount: consumed,
    outAmount: q.outputAmount,
    otherAmountThreshold: q.otherAmountThreshold,
    swapMode: 'ExactIn',
    slippageBps: q.slippageBps,
    priceImpactPct: q.priceImpactPct,
    platformFee: null,
    feeAmount: topLevelFee,
    feeMint: feeMints.size === 1 ? [...feeMints][0] : undefined,
    routePlan: q.routePlan.map((step) => ({
      swapInfo: {
        label: 'Raydium',
        ammKey: step.poolId,
        inputMint: step.inputMint,
        outputMint: step.outputMint,
        feeAmount: step.feeAmount,
        feeMint: step.feeMint,
      },
      percent: 100,
    })),
    poolIds: [...new Set(q.routePlan.map((step) => step.poolId))],
    isPartialFill: consumed !== q.inputAmount,
    requestTimestamp,
    responseTimestamp,
    latencyMs: responseTimestamp - requestTimestamp,
    rawResponse: JSON.stringify(raw),
  };
}

async function executeRaydiumQuote(params: QuoteParams): Promise<Quote> {
  assertAtomicAmount(params.amountAtomic, 'Raydium amount');
  const url = new URL(CONFIG.raydiumBaseUrl.replace(/\/$/, '') + '/compute/swap-base-in');
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amountAtomic);
  url.searchParams.set('slippageBps', String(params.slippageBps));
  url.searchParams.set('txVersion', 'V0');

  const requestTimestamp = Date.now();
  const raw = await getJson<unknown>(url.toString(), {}, {
    provider: 'Raydium',
    maxRetries: Math.min(CONFIG.httpMaxRetries, 2),
    baseBackoffMs: 600,
  });
  const quote = normalizeRaydiumQuote(raw, params, requestTimestamp, Date.now());
  void watchDirectMarketAccounts(
    `raydium:${params.inputMint}:${params.outputMint}`,
    quote.poolIds ?? [],
    [params.inputMint, params.outputMint],
    () => undefined,
  ).catch(() => undefined);
  return quote;
}

export function getRaydiumQuote(params: QuoteParams): Promise<Quote> {
  const key = quoteCacheKey([
    params.inputMint,
    params.outputMint,
    params.amountAtomic,
    params.slippageBps,
  ]);
  return raydiumRuntime.run(key, () => executeRaydiumQuote(params), params.priority, params);
}

export const raydiumProvider: QuoteProvider = {
  name: 'raydium',
  kind: 'direct',
  capabilities: {
    quote: true,
    dryRun: false,
    execution: false,
    // Pool-account updates trigger targeted requotes, but quote math still
    // comes from the official Trade API until a pool-specific SDK adapter is audited.
    streaming: true,
    atomicCycle: false,
  },
  supportsPair: async (inputMint, outputMint) => inputMint !== outputMint,
  health: () => raydiumRuntime.health(),
  getQuote: getRaydiumQuote,
  isRateLimited: () => raydiumRuntime.isCoolingDown(),
};

import { z } from 'zod';
import { RollingWorkMetrics } from './work-metrics.js';
export const jupiterWorkMetrics = new RollingWorkMetrics();
import { CONFIG } from './config.js';
import { log } from './logger.js';
import crypto from 'crypto';
import { assertAtomicAmount, type Quote, type QuoteParams, type QuotePriority } from './aggregators/types.js';
export type { Quote, QuoteParams } from './aggregators/types.js';
export { getRouteLabels, routeMatchesDexes, routeSummary } from './aggregators/types.js';

/**
 * Jupiter Quote API client — READ-ONLY.
 */

// ---------------------------------------------------------------------------
// Runtime validation schemas (§3)
// ---------------------------------------------------------------------------

const PlatformFeeSchema = z.object({
  amount: z.string(),
  feeBps: z.number(),
}).nullable().optional();

const RoutePlanStepSchema = z.object({
  swapInfo: z.object({
    label: z.string().optional(),
    ammKey: z.string().optional(),
    inputMint: z.string().optional(),
    outputMint: z.string().optional(),
    inAmount: z.string().optional(),
    outAmount: z.string().optional(),
    feeAmount: z.string().optional(),
    feeMint: z.string().optional(),
  }),
  percent: z.number().nullable().optional(),
});

export const QuoteSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: z.string(),
  outAmount: z.string(),
  otherAmountThreshold: z.string(),
  swapMode: z.string(),
  slippageBps: z.number(),
  priceImpactPct: z.string(),
  platformFee: PlatformFeeSchema,
  routePlan: z.array(RoutePlanStepSchema).default([]),
  contextSlot: z.number().optional(),
  timeTaken: z.number().optional(),
});

export type ParsedQuote = z.infer<typeof QuoteSchema>;

export type Priority = QuotePriority;

// ---------------------------------------------------------------------------
// Global Rate Limiter & Queue (§1, §2, §3, §6)
// ---------------------------------------------------------------------------

export const jupiterStats = {
  requestsThisMinute: 0,
  requestsThisHour: 0,
  requestsToday: 0,
  requestsSinceStartup: 0,
  successfulRequests: 0,
  rateLimits429: 0,
  otherErrors: 0,
  lastRequestTime: 0,
  last429Time: 0,
  throttleState: 'IDLE',
  apiLatencyMs: 0,
  avgLatencyMs: 0,
  currentRps: 0,
  rolling1MinRps: 0,
  unusedCapacityRps: 1.0,
  cacheHits: 0,
  cacheMisses: 0,
  deduplicatedRequests: 0,
};

let minuteResetInterval = setInterval(() => { jupiterStats.requestsThisMinute = 0; }, 60000);
let hourResetInterval = setInterval(() => { jupiterStats.requestsThisHour = 0; }, 3600000);
// Reset daily at midnight local time
let dayResetInterval = setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    jupiterStats.requestsToday = 0;
  }
}, 60000);
minuteResetInterval.unref();
hourResetInterval.unref();
dayResetInterval.unref();

interface QueuedRequest {
  queuedAt: number;
  params: QuoteParams;
  cacheKey: string;
  resolve: (q: Quote) => void;
  reject: (e: Error) => void;
}

const queue: QueuedRequest[] = [];
let isProcessingQueue = false;
let rateLimitBackoffUntil = 0;

// Track timestamps for precise RPS calculation
const requestTimestamps: number[] = [];

export function getRateLimitState() {
  return { backoffUntil: rateLimitBackoffUntil, count: jupiterStats.rateLimits429 };
}

export function isRateLimited(): boolean {
  return Date.now() < rateLimitBackoffUntil;
}

export function getQueueLength(): number {
  return queue.length;
}

let auxiliaryRequestTail: Promise<void> = Promise.resolve();

/**
 * Low-priority Jupiter JSON request sharing the same free-tier pacing state as
 * quote traffic. Discovery waits for quotes and never bypasses Retry-After.
 */
export function getJupiterJson<T>(url: string, operation: string): Promise<T> {
  let resolveResult!: (value: T) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  auxiliaryRequestTail = auxiliaryRequestTail.then(async () => {
    while (isProcessingQueue || queue.length > 0 || isRateLimited()) {
      const waitMs = isRateLimited()
        ? Math.max(100, Math.min(1000, rateLimitBackoffUntil - Date.now()))
        : 250;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const effectiveIntervalMs = CONFIG.jupiterApiKey
      ? CONFIG.jupiterSafetyIntervalMs
      : Math.max(CONFIG.jupiterSafetyIntervalMs, 2050);
    const remaining = effectiveIntervalMs - (Date.now() - jupiterStats.lastRequestTime);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));

    const startedAt = Date.now();
    jupiterStats.lastRequestTime = startedAt;
    jupiterStats.requestsThisMinute++;
    jupiterStats.requestsThisHour++;
    jupiterStats.requestsToday++;
    jupiterStats.requestsSinceStartup++;
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (CONFIG.jupiterApiKey) headers['x-api-key'] = CONFIG.jupiterApiKey;
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(CONFIG.httpTimeoutMs),
      });
      const finishedAt = Date.now();
      updateMetrics(finishedAt, finishedAt - startedAt);
      const body = await response.text();
      if (response.status === 429) {
        jupiterStats.rateLimits429++;
        jupiterStats.last429Time = finishedAt;
        const retryAfter = Number(response.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 5000;
        rateLimitBackoffUntil = Date.now() + delayMs;
        throw new Error(`Jupiter ${operation} rate-limited (429); cooldown ${delayMs}ms`);
      }
      if (!response.ok) throw new Error(`Jupiter ${operation} HTTP ${response.status}: ${body.slice(0, 300)}`);
      let parsed: unknown;
      try { parsed = JSON.parse(body); }
      catch { throw new Error(`Jupiter ${operation} returned invalid JSON`); }
      jupiterStats.successfulRequests++;
      resolveResult(parsed as T);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('429')) jupiterStats.otherErrors++;
      rejectResult(error);
    }
  }).catch((error) => {
    rejectResult(error);
  });
  return result;
}

function updateMetrics(now: number, latency: number) {
  requestTimestamps.push(now);
  while (requestTimestamps.length > 0 && requestTimestamps[0]! < now - 60000) {
    requestTimestamps.shift();
  }
  
  // Rolling 1-min RPS
  jupiterStats.rolling1MinRps = requestTimestamps.length / 60;
  
  // Current RPS (last 10 seconds)
  const recent10s = requestTimestamps.filter(t => t > now - 10000).length;
  jupiterStats.currentRps = recent10s / 10;
  
  // Unused capacity
  jupiterStats.unusedCapacityRps = Math.max(0, CONFIG.jupiterMaxRps - jupiterStats.rolling1MinRps);

  // Moving average latency
  if (jupiterStats.avgLatencyMs === 0) {
    jupiterStats.avgLatencyMs = latency;
  } else {
    jupiterStats.avgLatencyMs = (jupiterStats.avgLatencyMs * 0.9) + (latency * 0.1);
  }
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (queue.length > 0) {
      if (isRateLimited()) {
        jupiterStats.throttleState = 'BACKOFF';
        const waitMs = rateLimitBackoffUntil - Date.now();
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // Enforce global RPS / Safety Interval (§1)
      const now = Date.now();
      const timeSinceLast = now - jupiterStats.lastRequestTime;
      const effectiveIntervalMs = CONFIG.jupiterApiKey
        ? CONFIG.jupiterSafetyIntervalMs
        : Math.max(CONFIG.jupiterSafetyIntervalMs, 2050); // official keyless limit: 0.5 RPS
      if (timeSinceLast < effectiveIntervalMs) {
        jupiterStats.throttleState = 'THROTTLED';
        const waitMs = effectiveIntervalMs - timeSinceLast;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // Dequeue next highest priority request
      let reqIndex = queue.findIndex(req => req.params.priority === 'HIGH');
      if (reqIndex === -1) reqIndex = 0;
      const req = queue.splice(reqIndex, 1)[0];
      if (!req) continue;

      jupiterStats.throttleState = 'ACTIVE';
      const finish = jupiterWorkMetrics.start(req.queuedAt);
      
      try {
        const quote = await executeQuoteWithRetry(req.params);
        finish(true);
        req.resolve(quote);
      } catch (err) {
        finish(false, /429/.test(String(err)));
        req.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  } finally {
    jupiterStats.throttleState = 'IDLE';
    isProcessingQueue = false;
  }
}

async function executeQuoteWithRetry(params: QuoteParams): Promise<Quote> {
  const maxRetries = Math.min(CONFIG.httpMaxRetries, 2);
  for (let attempt = 0; ; attempt++) {
    try {
      return await executeQuote(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A 429 already opens Jupiter's global Retry-After backoff. Retrying the
      // same logical request here would amplify rate-limit pressure.
      const retriable = /Jupiter HTTP 5\d\d|timed out|fetch failed|network/i.test(message);
      if (!retriable || attempt >= maxRetries) throw error;
      const backoffMs = Math.round(Math.min(4000, 500 * 2 ** attempt)
        * (0.8 + Math.random() * 0.4));
      log.warn('Jupiter transient quote failure; bounded retry scheduled', {
        attempt: attempt + 1,
        backoffMs,
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Request Deduplication & Caching
// ---------------------------------------------------------------------------

const shortCache = new Map<string, { quote: Quote, expires: number }>();
const pendingPromises = new Map<string, Promise<Quote>>();

export async function getQuote(params: QuoteParams): Promise<Quote> {
  const cacheKey = [
    params.inputMint, params.outputMint, params.amountAtomic,
    params.slippageBps, (params.dexes||[]).join(','),
    params.maxHops ?? '', params.onlyDirectRoutes ?? '', params.maxAccounts ?? '',
  ].join('|');

  // 1. Check short-lived cache (valid for 1500ms to allow concurrent scans of same pair to dedupe)
  const cached = shortCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    jupiterStats.cacheHits++;
    return { ...cached.quote, id: crypto.randomUUID() };
  }
  jupiterStats.cacheMisses++;

  // 2. Request coalescing (if exactly this is already queued/fetching, just await it)
  if (pendingPromises.has(cacheKey)) {
    jupiterStats.deduplicatedRequests++;
    return pendingPromises.get(cacheKey)!.then(quote => ({ ...quote, id: crypto.randomUUID() }));
  }

  // 3. Queue new request
  if (queue.length >= 128) throw new Error('Jupiter scanner quote queue capacity exceeded');
  const p = new Promise<Quote>((resolve, reject) => {
    queue.push({ params, cacheKey, resolve, reject, queuedAt: Date.now() });
    processQueue().catch(e => log.error('Queue processor error', { error: String(e) }));
  }).then(quote => {
    shortCache.set(cacheKey, { quote, expires: Date.now() + CONFIG.quoteCacheTtlMs });
    pendingPromises.delete(cacheKey);
    return quote;
  }).catch(err => {
    pendingPromises.delete(cacheKey);
    throw err;
  });

  pendingPromises.set(cacheKey, p);
  return p;
}

// ---------------------------------------------------------------------------
// Core Quote Execution
// ---------------------------------------------------------------------------

async function executeQuote(params: QuoteParams): Promise<Quote> {
  const base = CONFIG.jupiterBaseUrl.replace(/\/$/, '');
  // If the user sets exactly "https://api.jup.ag", append the v6 or v1 path automatically
  const path = base.includes('/swap/') || base.includes('/v6') ? '/quote' : '/swap/v1/quote';
  const url = new URL(base + path);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amountAtomic);
  url.searchParams.set('slippageBps', String(params.slippageBps));
  url.searchParams.set('swapMode', 'ExactIn');
  url.searchParams.set('maxAccounts', String(params.maxAccounts ?? 64));
  if (params.onlyDirectRoutes !== undefined) {
    url.searchParams.set('onlyDirectRoutes', String(params.onlyDirectRoutes));
  }
  if (params.dexes && params.dexes.length > 0) {
    url.searchParams.set('dexes', params.dexes.join(','));
  }

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (CONFIG.jupiterApiKey) {
    headers['x-api-key'] = CONFIG.jupiterApiKey;
  }

  const reqTs = Date.now();
  jupiterStats.lastRequestTime = reqTs;
  jupiterStats.requestsThisMinute++;
  jupiterStats.requestsThisHour++;
  jupiterStats.requestsToday++;
  jupiterStats.requestsSinceStartup++;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.httpTimeoutMs);

  let rawText: string;
  let resTs: number;

  try {
    const res = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timeout);

    rawText = await res.text();
    resTs = Date.now();
    jupiterStats.apiLatencyMs = resTs - reqTs;
    updateMetrics(resTs, jupiterStats.apiLatencyMs);

    if (res.status === 429) {
      jupiterStats.rateLimits429++;
      jupiterStats.last429Time = resTs;
      
      const retryAfterHeader = res.headers.get('retry-after');
      const baseDelay = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 5000;
      // Exponential backoff with jitter (§6)
      const attempt = Math.min(jupiterStats.rateLimits429, 5);
      const jitter = Math.random() * 1000;
      const delay = baseDelay * Math.pow(1.5, attempt - 1) + jitter;
      
      rateLimitBackoffUntil = Date.now() + delay;
      log.warn('Jupiter rate-limited (429), slowing global queue', { delayMs: Math.round(delay) });
      throw new Error(`Jupiter API rate-limited (429). Retry after ${Math.round(delay)}ms`);
    }

    if (!res.ok) {
      jupiterStats.otherErrors++;
      throw new Error('Jupiter HTTP ' + res.status + ': ' + rawText.slice(0, 300));
    }
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (!(err instanceof Error) || (!err.message.includes('429'))) {
      jupiterStats.otherErrors++;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Jupiter quote request timed out after ' + CONFIG.httpTimeoutMs + 'ms');
    }
    throw err;
  }

  jupiterStats.successfulRequests++;

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    throw new Error('Jupiter returned non-JSON: ' + rawText.slice(0, 200));
  }

  if (rawJson && typeof rawJson === 'object' && 'error' in rawJson) {
    throw new Error('Jupiter API error: ' + String((rawJson as Record<string, unknown>).error));
  }

  const parsed = QuoteSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error('Unexpected Jupiter quote shape: ' + parsed.error.message);
  }

  assertAtomicAmount(parsed.data.inAmount, 'Jupiter inAmount');
  assertAtomicAmount(parsed.data.outAmount, 'Jupiter outAmount');
  assertAtomicAmount(parsed.data.otherAmountThreshold, 'Jupiter otherAmountThreshold');

  return {
    ...parsed.data,
    provider: 'jupiter',
    consumedInAmount: parsed.data.inAmount,
    feeAmount: parsed.data.platformFee?.amount,
    feeMint: parsed.data.platformFee ? parsed.data.inputMint : undefined,
    poolIds: parsed.data.routePlan.flatMap((step) =>
      step.swapInfo.ammKey ? [step.swapInfo.ammKey] : [],
    ),
    isPartialFill: false,
    swapMode: 'ExactIn',
    id: crypto.randomUUID(),
    requestTimestamp: reqTs,
    responseTimestamp: resTs,
    latencyMs: resTs - reqTs,
    rawResponse: rawText,
  };
}

import crypto from 'crypto';
import { performance } from 'node:perf_hooks';
import { dispatchDrift } from './dispatch-diagnostics.js';
import { QuoteAdmission, semanticQuoteKey, type QuoteDeadline } from './quote-admission.js';
import { ScannerFairService } from './scanner-service-policy.js';
const fairService = new ScannerFairService();
import { z } from 'zod';
import { CONFIG } from './config.js';
import { getJson, HttpError } from './http.js';
import { log } from './logger.js';
import {
  assertAtomicAmount,
  type Quote,
  type QuoteParams,
  type QuoteProvider,
} from './aggregators/types.js';

const RaptorRouteStepSchema = z.object({
  programId: z.string().optional(),
  dex: z.string().optional(),
  pool: z.string().optional(),
  inputMint: z.string().optional(),
  outputMint: z.string().optional(),
  amountIn: z.string().optional(),
  amountOut: z.string().optional(),
  feeAmount: z.string().optional(),
  priceImpact: z.number().optional(),
  percent: z.number().nullable().optional(),
});

export const RaptorRawQuoteSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  amountIn: z.string(),
  amountOut: z.string(),
  minAmountOut: z.string(),
  feeAmount: z.string().optional(),
  priceImpact: z.number(),
  slippageBps: z.number(),
  routePlan: z.array(RaptorRouteStepSchema).default([]),
  contextSlot: z.number().optional(),
  timeTaken: z.number().optional(),
  swapUsdValue: z.string().optional(),
});

export type RaptorRawQuote = z.infer<typeof RaptorRawQuoteSchema>;

export const raptorStats = {
  requestsSinceStartup: 0,
  successfulRequests: 0,
  rateLimits429: 0,
  otherErrors: 0,
  lastRequestTime: 0,
  apiLatencyMs: 0,
  avgLatencyMs: 0,
  throttleState: 'IDLE',
  cacheHits: 0,
  cacheMisses: 0,
  deduplicatedRequests: 0,
  streamUpdates: 0,
  streamReconnects: 0,
};

interface QueuedRaptorRequest<T> {
  deadline: QuoteDeadline;
  queuedAt: number;
  task: () => Promise<T>;
  priority: QuoteParams['priority'];
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
const queue: QueuedRaptorRequest<Quote>[] = [];
export const raptorAdmission = new QuoteAdmission('raptor', () => CONFIG.raptorSafetyIntervalMs,
  () => performance.now(), () => Date.now(), () => ({
    nextLegalSendMono: performance.now() + Math.max(0, raptorStats.lastRequestTime + CONFIG.raptorSafetyIntervalMs - Date.now()),
    cooldownUntilMono: performance.now() + Math.max(0, backoffUntil - Date.now()),
  }));
let isProcessingQueue = false;
let backoffUntil = 0;
let consecutiveFailures = 0;
const cache = new Map<string, { quote: Quote; expires: number }>();
export function raptorQueueHealth() { return { queueLength: queue.length, active: raptorStats.throttleState === 'ACTIVE' ? 1 : 0, cooldownRemainingMs: Math.max(0, backoffUntil - Date.now()) }; }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function cacheKey(params: QuoteParams): string {
  return semanticQuoteKey('raptor', params);
}

async function paceRequest(): Promise<void> {
  const waitForBackoff = Math.max(0, backoffUntil - Date.now());
  const waitForInterval = Math.max(
    0,
    CONFIG.raptorSafetyIntervalMs - (Date.now() - raptorStats.lastRequestTime),
  );
  const waitMs = Math.max(waitForBackoff, waitForInterval);
  if (waitMs > 0) {
    raptorStats.throttleState = waitForBackoff > 0 ? 'BACKOFF' : 'THROTTLED';
    const expected = performance.now() + waitMs;
    await sleep(waitMs); dispatchDrift('raptor', expected);
  }
}

function enqueue(task: () => Promise<Quote>, priority: QuoteParams['priority'], deadline: QuoteDeadline): Promise<Quote> {
  return new Promise<Quote>((resolve, reject) => {
    if (queue.length >= 128) { reject(new Error('Raptor scanner quote queue capacity exceeded')); return; }
    queue.push({ task, priority, deadline, resolve, reject, queuedAt: Date.now() });
    const cancel = () => { const index = queue.findIndex((q) => q.deadline === deadline); if (index >= 0) queue.splice(index, 1); reject(new Error('DISCOVERY_QUEUE_CANCELLED')); };
    deadline.signal?.addEventListener('abort', cancel, { once: true });
    if (deadline.signal?.aborted) { cancel(); return; }
    raptorWorkMetrics.observeQueue(queue.length);
    void processQueue();
  });
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    while (queue.length > 0) {
      await paceRequest();
      const request = fairService.take(queue, (request) => request.priority, (request) => request.deadline.deadlineMono);
      if (!request) continue;
      raptorStats.throttleState = 'ACTIVE';
      let finish: ReturnType<typeof raptorWorkMetrics.start> | undefined;
      try {
        request.resolve(await raptorAdmission.dispatch(request.deadline, () => { finish = raptorWorkMetrics.start(request.queuedAt); return request.task(); }));
        finish?.(true);
      } catch (error) {
        finish?.(false, /429/.test(String(error)));
        request.reject(error);
      }
    }
  } finally {
    raptorStats.throttleState = 'IDLE';
    isProcessingQueue = false;
    // Requests can arrive between the while condition and finally.
    if (queue.length > 0) void processQueue();
  }
}

/** Also accepts the `data` payload from Raptor's quote-only /stream WebSocket. */
export function normalizeRaptorQuote(
  raw: unknown,
  requestTimestamp: number,
  responseTimestamp: number,
): Quote {
  const parsed = RaptorRawQuoteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Unexpected Raptor quote shape: ' + parsed.error.message);
  }

  const q = parsed.data;
  assertAtomicAmount(q.amountIn, 'Raptor amountIn');
  assertAtomicAmount(q.amountOut, 'Raptor amountOut');
  assertAtomicAmount(q.minAmountOut, 'Raptor minAmountOut');
  return {
    provider: 'raptor',
    id: crypto.randomUUID(),
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inAmount: q.amountIn,
    consumedInAmount: q.amountIn,
    outAmount: q.amountOut,
    otherAmountThreshold: q.minAmountOut,
    swapMode: 'ExactIn',
    slippageBps: q.slippageBps,
    priceImpactPct: String(q.priceImpact),
    platformFee: null,
    feeAmount: q.feeAmount,
    feeMint: q.feeAmount ? q.inputMint : undefined,
    routePlan: q.routePlan.map((step) => ({
      swapInfo: {
        label: step.dex,
        ammKey: step.pool,
        programId: step.programId,
        inputMint: step.inputMint,
        outputMint: step.outputMint,
        inAmount: step.amountIn,
        outAmount: step.amountOut,
        feeAmount: step.feeAmount,
      },
      percent: step.percent,
    })),
    poolIds: q.routePlan.flatMap((step) => step.pool ? [step.pool] : []),
    isPartialFill: false,
    contextSlot: q.contextSlot,
    timeTaken: q.timeTaken,
    requestTimestamp,
    responseTimestamp,
    latencyMs: responseTimestamp - requestTimestamp,
    rawResponse: JSON.stringify(raw),
  };
}

async function executeQuote(params: QuoteParams): Promise<Quote> {
  const base = CONFIG.raptorBaseUrl.replace(/\/$/, '');
  const url = new URL(base + '/quote');
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amountAtomic);
  url.searchParams.set('slippageBps', String(params.slippageBps));
  url.searchParams.set('maxHops', String(params.maxHops ?? CONFIG.raptorMaxHops));
  if (params.onlyDirectRoutes !== undefined) {
    url.searchParams.set('onlyDirectRoutes', String(params.onlyDirectRoutes));
  }
  if (params.dexes && params.dexes.length > 0) {
    url.searchParams.set('dexes', params.dexes.join(','));
  }

  const requestTimestamp = Date.now();
  raptorStats.lastRequestTime = requestTimestamp;
  raptorStats.requestsSinceStartup++;

  try {
    const raw = await getJson<unknown>(url.toString(), {}, {
      provider: 'Raptor',
      maxRetries: params.scheduling ? 0 : Math.min(CONFIG.httpMaxRetries, 2),
      timeoutMs: Math.max(1, Math.floor(Math.min(CONFIG.httpTimeoutMs, (params.scheduling?.deadlineMono ?? Infinity) - performance.now()))),
      baseBackoffMs: 750,
    });
    const responseTimestamp = Date.now();
    const quote = normalizeRaptorQuote(raw, requestTimestamp, responseTimestamp);
    consecutiveFailures = 0;
    raptorStats.successfulRequests++;
    raptorStats.apiLatencyMs = quote.latencyMs;
    raptorStats.avgLatencyMs = raptorStats.avgLatencyMs === 0
      ? quote.latencyMs
      : raptorStats.avgLatencyMs * 0.9 + quote.latencyMs * 0.1;
    return quote;
  } catch (error) {
    consecutiveFailures++;
    if (error instanceof HttpError && error.status === 429) {
      raptorStats.rateLimits429++;
      backoffUntil = Math.max(backoffUntil, Date.now() + Math.max(5000, error.retryAfterMs ?? 0));
      raptorAdmission.recordRateLimit(params.priority, Math.max(5000, error.retryAfterMs ?? 0), params.scheduling?.traceId, params.amountAtomic);
      log.warn('Raptor rate-limited after bounded retries; provider cooling down', {
        backoffMs: 5000,
      });
    } else {
      raptorStats.otherErrors++;
    }
    if (consecutiveFailures >= CONFIG.providerFailureThreshold) {
      backoffUntil = Math.max(backoffUntil, Date.now() + CONFIG.providerCooldownMs);
      log.warn('Raptor circuit opened after repeated quote failures', {
        cooldownMs: CONFIG.providerCooldownMs,
      });
    }
    throw error;
  }
}

export async function getRaptorQuote(params: QuoteParams): Promise<Quote> {
  params = structuredClone(params);
  const key = cacheKey(params);
  const cached = cache.get(key);
  raptorStats.cacheMisses++;
  return raptorAdmission.request(params, (deadline) => enqueue(() => executeQuote({ ...params, scheduling: { deadlineMono: deadline.deadlineMono, traceId: deadline.traceId } }), params.priority, deadline), cached && performance.now() < cached.expires ? cached.quote : undefined)
    .then((quote) => {
      cache.set(key, { quote, expires: cached?.quote.responseTimestamp === quote.responseTimestamp ? cached.expires : performance.now() + CONFIG.quoteCacheTtlMs });
      while (cache.size > 256) cache.delete(cache.keys().next().value!);
      return { ...quote, id: crypto.randomUUID() };
    });
}

/** Accept a quote-only `/stream` payload as a short-lived cache update. */
export function acceptRaptorStreamQuote(raw: unknown, receivedAt = Date.now()): Quote {
  const quote = normalizeRaptorQuote(raw, receivedAt, receivedAt);
  const key = cacheKey({
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    amountAtomic: quote.inAmount,
    slippageBps: quote.slippageBps,
  });
  cache.set(key, { quote, expires: performance.now() + CONFIG.quoteCacheTtlMs });
  while (cache.size > 256) cache.delete(cache.keys().next().value!);
  raptorStats.streamUpdates++;
  return quote;
}

export function isRaptorRateLimited(): boolean {
  return Date.now() < backoffUntil;
}

export const raptorProvider: QuoteProvider = {
  name: 'raptor',
  kind: 'aggregator',
  capabilities: {
    quote: true,
    dryRun: false,
    execution: false,
    streaming: true,
    atomicCycle: false,
  },
  supportsPair: async (inputMint, outputMint) => inputMint !== outputMint || CONFIG.enableRaptorCircular,
  health: () => ({
    state: isRaptorRateLimited()
      ? 'COOLDOWN'
      : raptorStats.otherErrors > 0 && raptorStats.successfulRequests === 0
        ? 'UNAVAILABLE'
        : raptorStats.otherErrors > 0 ? 'DEGRADED' : 'HEALTHY',
    requests: raptorStats.requestsSinceStartup,
    successes: raptorStats.successfulRequests,
    failures: raptorStats.otherErrors,
    rateLimits429: raptorStats.rateLimits429,
    averageLatencyMs: raptorStats.avgLatencyMs,
    circuitOpen: isRaptorRateLimited(),
  }),
  getQuote: getRaptorQuote,
  isRateLimited: isRaptorRateLimited,
};
import { RollingWorkMetrics } from './work-metrics.js';
export const raptorWorkMetrics = new RollingWorkMetrics();

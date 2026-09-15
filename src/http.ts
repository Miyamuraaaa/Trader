import { CONFIG } from './config.js';
import { log } from './logger.js';

/**
 * Robust GET-JSON helper. Handles:
 *   - timeouts (AbortSignal.timeout)
 *   - HTTP 429 / 5xx with exponential backoff (respects Retry-After)
 *   - network errors
 * Throws a typed error the caller can safely catch; never returns partial data.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retriable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface GetJsonOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  provider?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function withJitter(ms: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.round(ms * factor));
}

export async function getJson<T = unknown>(
  url: string,
  headers: Record<string, string> = {},
  options: GetJsonOptions = {},
): Promise<T> {
  let lastErr: unknown;

  const timeoutMs = options.timeoutMs ?? CONFIG.httpTimeoutMs;
  const maxRetries = options.maxRetries ?? CONFIG.httpMaxRetries;
  const baseBackoffMs = options.baseBackoffMs ?? 500;
  const provider = options.provider ?? 'HTTP provider';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    comparisonBarrier.assertOpen();
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Rate limited or transient server error -> retry with backoff.
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = retryAfterMs(res.headers.get('retry-after'));
        const backoffMs = retryAfter !== undefined
          ? retryAfter
          : withJitter(Math.min(baseBackoffMs * 2 ** attempt, 8000));
        lastErr = new HttpError(`HTTP ${res.status} from ${short(url)}`, res.status, true, retryAfter);
        if (attempt < maxRetries) {
          comparisonBarrier.assertOpen();
          log.warn(`${provider} HTTP ${res.status}; backing off`, {
            attempt: attempt + 1,
            backoffMs,
            rateLimited: res.status === 429,
          });
          await sleep(backoffMs);
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        // 4xx (other than 429): not retriable, caller decides what to do.
        const body = await safeText(res);
        throw new HttpError(`HTTP ${res.status} from ${short(url)}: ${body}`, res.status, false);
      }

      // Guard against non-JSON / malformed bodies.
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError(`Invalid JSON from ${short(url)}`, res.status, false);
      }
    } catch (err) {
      comparisonBarrier.assertOpen();
      lastErr = err;
      const isAbort = err instanceof Error && err.name === 'TimeoutError';
      const isNet = err instanceof TypeError; // fetch network failure
      const retriable = isAbort || isNet || (err instanceof HttpError && err.retriable);

      if (retriable && attempt < maxRetries) {
        const backoffMs = withJitter(Math.min(baseBackoffMs * 2 ** attempt, 8000));
        log.warn(`${provider} retriable request error; backing off`, {
          attempt: attempt + 1,
          backoffMs,
          reason: isAbort ? 'timeout' : isNet ? 'network' : 'http',
        });
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new HttpError('Unknown HTTP failure');
}

function short(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<no body>';
  }
}
import { comparisonBarrier } from './comparison-drain.js';

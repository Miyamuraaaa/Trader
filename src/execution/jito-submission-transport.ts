import { CONFIG } from '../config.js';
import type { SubmissionTransport } from './broadcaster.js';

interface JitoJsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export function assertJitoEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.block-engine.jito.wtf')) {
    throw new Error('Jito endpoint must be an official HTTPS *.block-engine.jito.wtf host');
  }
  url.pathname = '/api/v1/transactions';
  url.search = '';
  return url;
}

/**
 * Exact-byte Jito sender. Like the RPC transport, it has no retry path. Jito's
 * single-transaction endpoint always skips server-side preflight, so the
 * executor's already-completed exact simulation remains mandatory.
 */
export class JitoBlockEngineSubmissionTransport implements SubmissionTransport {
  private readonly endpoint: URL;

  constructor(
    endpoint = CONFIG.jitoBlockEngineUrl,
    private readonly request: typeof fetch = fetch,
  ) {
    this.endpoint = assertJitoEndpoint(endpoint);
  }

  async submitExactSignedBytes(bytes: Uint8Array): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(
      new Error(`Jito submission exceeded ${CONFIG.jitoSubmissionTimeoutMs} ms`),
    ), CONFIG.jitoSubmissionTimeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (CONFIG.jitoAuthKey) headers['x-jito-auth'] = CONFIG.jitoAuthKey;
      const response = await this.request(this.endpoint, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'sendTransaction',
          params: [Buffer.from(bytes).toString('base64'), { encoding: 'base64' }],
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Jito HTTP ${response.status}: ${text.slice(0, 200)}`);
      let parsed: JitoJsonRpcResponse;
      try { parsed = JSON.parse(text) as JitoJsonRpcResponse; } catch {
        throw new Error('Jito returned invalid JSON');
      }
      if (parsed.error) {
        throw new Error(`Jito RPC ${parsed.error.code ?? 'error'}: ${parsed.error.message ?? 'unknown error'}`);
      }
      if (typeof parsed.result !== 'string' || parsed.result.length < 32) {
        throw new Error('Jito response did not contain a transaction signature');
      }
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

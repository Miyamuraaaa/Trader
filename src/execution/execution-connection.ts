import { Connection, type FetchFn } from '@solana/web3.js';
import { createSolanaRpc, mainnet } from '@solana/kit';
import { CONFIG } from '../config.js';

/**
 * Execution-critical RPC calls must either finish inside the fresh-quote
 * window or fail. web3.js' default 429 retry loop can otherwise spend seconds
 * backing off while the approved market state expires.
 */
export function createExecutionConnection(): Connection {
  const failFastFetch: FetchFn = async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(
      new Error(`Execution RPC exceeded ${CONFIG.executionRpcTimeoutMs} ms`),
    ), CONFIG.executionRpcTimeoutMs);
    const upstreamSignal = init?.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }
  };
  return new Connection(CONFIG.executionRpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: failFastFetch,
    ...(CONFIG.executionWsUrl ? { wsEndpoint: CONFIG.executionWsUrl } : {}),
  });
}

const createExecutionKitRpc = () => createSolanaRpc(mainnet(CONFIG.executionRpcUrl));
type ExecutionKitRpc = ReturnType<typeof createExecutionKitRpc>;
let executionKitRpc: ExecutionKitRpc | undefined;

/** Orca's generated client uses Kit RPC; it must share the isolated execution endpoint. */
export function getExecutionKitRpc(): ExecutionKitRpc {
  executionKitRpc ??= createExecutionKitRpc();
  return executionKitRpc;
}

export function executionRpcEndpointLabel(): string {
  try {
    const parsed = new URL(CONFIG.executionRpcUrl);
    return parsed.hostname === 'api.mainnet-beta.solana.com'
      ? parsed.origin
      : '[configured dedicated execution RPC]';
  } catch {
    return '[configured execution RPC]';
  }
}

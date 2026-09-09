import { Connection, PublicKey } from '@solana/web3.js';
import { BoundedAdvisoryCache } from '../bounded-advisory-cache.js';
import {
  associatedTokenAddress,
  inspectAssociatedTokenAccount,
  inspectParsedAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  type TokenAccountPreflight,
} from './account-preflight.js';
import {
  analyzeParsedTokenMint,
  analyzeTokenMint,
  type TokenProgramAnalysis,
} from './token-analysis.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';

// Match structurally: importing the scanner governor here would expand the
// isolated executor's dependency surface.
export function isExecutionPreflightBackpressure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; name?: unknown };
  return value.code === 'SCANNER_RPC_BACKPRESSURE'
    || value.code === 'RPC_BACKPRESSURE'
    || value.name === 'ScannerRpcBackpressureError';
}

function observePreflight<T>(promise: Promise<T>): Promise<T> {
  const pending = promise.catch((error: unknown) => {
    if (isExecutionPreflightBackpressure(error)) {
      throw Object.assign(new Error('RPC_BACKPRESSURE: PREFLIGHT_UNAVAILABLE'), {
        code: 'RPC_BACKPRESSURE', reason: 'PREFLIGHT_UNAVAILABLE',
      });
    }
    throw error;
  });
  // Cache probes may be abandoned by a background caller. Observe rejection
  // immediately, but return the rejecting promise so active callers fail closed.
  void pending.catch(() => {});
  return pending;
}

// ATA existence is structural and the live balance gate refreshes spendable
// amounts immediately before submission. Keep this off the candidate hot path.
const ATA_TTL_MS = 300_000;
const mintCache = new BoundedAdvisoryCache<string, Promise<TokenProgramAnalysis>>('RPC mint policy', 60_000);
const ataCache = new BoundedAdvisoryCache<string, { expiresAt: number; value: Promise<TokenAccountPreflight> }>('RPC ATA metadata', ATA_TTL_MS);
export function executionPreflightCacheHealth() { return { mints: mintCache.snapshot(), atas: ataCache.snapshot() }; }
/** Read-only cache lookup: never starts RPC, and preserves both existing TTLs. */
export function peekExecutionPreflight(connection: Connection, wallet: PublicKey, mint: string): Promise<[TokenProgramAnalysis, TokenAccountPreflight]> | undefined {
  const analysis = mintCache.get(`${connection.rpcEndpoint}:${mint}`);
  const ata = ataCache.get(`${connection.rpcEndpoint}:${wallet.toBase58()}:${mint}`);
  if (!analysis || !ata || ata.expiresAt <= Date.now()) return undefined;
  return observePreflight(Promise.all([analysis, ata.value]));
}

export function getCachedExecutionMintAnalysis(
  connection: Connection,
  mint: string,
  profiler?: ExecutionNetworkProfiler,
): Promise<TokenProgramAnalysis> {
  const key = `${connection.rpcEndpoint}:${mint}`;
  const cached = mintCache.get(key);
  if (cached) return cached;
  const pending = observePreflight(analyzeTokenMint(connection, mint, profiler).catch((error) => {
    mintCache.delete(key);
    throw error;
  }));
  mintCache.set(key, pending);
  return pending;
}

export function getCachedExecutionAta(
  connection: Connection,
  wallet: PublicKey,
  mint: string,
  profiler?: ExecutionNetworkProfiler,
): Promise<TokenAccountPreflight> {
  const key = `${connection.rpcEndpoint}:${wallet.toBase58()}:${mint}`;
  const cached = ataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = observePreflight(inspectAssociatedTokenAccount(
    connection, wallet, new PublicKey(mint), TOKEN_PROGRAM_ID, profiler,
  ).catch((error) => {
    ataCache.delete(key);
    throw error;
  }));
  ataCache.set(key, { expiresAt: Date.now() + ATA_TTL_MS, value: pending });
  return pending;
}

export async function preloadExecutionPreflight(
  connection: Connection,
  wallet: PublicKey,
  mints: readonly string[],
  profiler?: ExecutionNetworkProfiler,
): Promise<void> {
  const uniqueMints = [...new Set(mints)];
  const endpoint = connection.rpcEndpoint;
  const missingMints = uniqueMints.filter((mint) => !mintCache.has(`${endpoint}:${mint}`));
  const missingAtas = uniqueMints.filter((mint) => {
    const cached = ataCache.get(`${endpoint}:${wallet.toBase58()}:${mint}`);
    return !cached || cached.expiresAt <= Date.now();
  });
  if (missingMints.length > 0 || missingAtas.length > 0) {
    const mintKeys = missingMints.map((mint) => new PublicKey(mint));
    const ataKeys = missingAtas.map((mint) => associatedTokenAddress(
      new PublicKey(mint), wallet, TOKEN_PROGRAM_ID,
    ));
    const batch = (async () => {
      const load = () => connection.getMultipleParsedAccounts(
        [...mintKeys, ...ataKeys], { commitment: 'confirmed' },
      );
      const response = profiler
        ? await profiler.measure('rpc.preflight.getMultipleParsedAccounts', 'rpc', load)
        : await load();
      const mintValues = response.value.slice(0, mintKeys.length);
      const ataValues = response.value.slice(mintKeys.length);
      let rentLamports = 0;
      if (ataValues.some((value) => value === null)) {
        const loadRent = () => connection.getMinimumBalanceForRentExemption(165);
        rentLamports = profiler
          ? await profiler.measure('rpc.preflight.getMinimumBalanceForRentExemption', 'rpc', loadRent)
          : await loadRent();
      }
      return { mintValues, ataValues, rentLamports };
    })();
    missingMints.forEach((mint, index) => {
      const key = `${endpoint}:${mint}`;
      const value = observePreflight(batch.then(({ mintValues }) =>
        analyzeParsedTokenMint(mint, mintValues[index] ?? null)));
      void value.catch(() => mintCache.delete(key));
      mintCache.set(key, value);
    });
    missingAtas.forEach((mint, index) => {
      const key = `${endpoint}:${wallet.toBase58()}:${mint}`;
      const value = observePreflight(batch.then(({ ataValues, rentLamports }) =>
        inspectParsedAssociatedTokenAccount(
          ataValues[index] ?? null,
          wallet,
          new PublicKey(mint),
          TOKEN_PROGRAM_ID,
          rentLamports,
        )));
      void value.catch(() => ataCache.delete(key));
      ataCache.set(key, {
        expiresAt: Date.now() + ATA_TTL_MS,
        value,
      });
    });
  }
  await Promise.all(uniqueMints.flatMap((mint) => [
    getCachedExecutionMintAnalysis(connection, mint, profiler),
    getCachedExecutionAta(connection, wallet, mint, profiler),
  ]));
}

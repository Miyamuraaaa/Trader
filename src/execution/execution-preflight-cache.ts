import { Connection, PublicKey } from '@solana/web3.js';
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

// ATA existence is structural and the live balance gate refreshes spendable
// amounts immediately before submission. Keep this off the candidate hot path.
const ATA_TTL_MS = 300_000;
const mintCache = new Map<string, Promise<TokenProgramAnalysis>>();
const ataCache = new Map<string, { expiresAt: number; value: Promise<TokenAccountPreflight> }>();

export function getCachedExecutionMintAnalysis(
  connection: Connection,
  mint: string,
  profiler?: ExecutionNetworkProfiler,
): Promise<TokenProgramAnalysis> {
  const key = `${connection.rpcEndpoint}:${mint}`;
  const cached = mintCache.get(key);
  if (cached) return cached;
  const pending = analyzeTokenMint(connection, mint, profiler).catch((error) => {
    mintCache.delete(key);
    throw error;
  });
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
  const pending = inspectAssociatedTokenAccount(
    connection, wallet, new PublicKey(mint), TOKEN_PROGRAM_ID, profiler,
  ).catch((error) => {
    ataCache.delete(key);
    throw error;
  });
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
      const value = batch.then(({ mintValues }) =>
        analyzeParsedTokenMint(mint, mintValues[index] ?? null));
      void value.catch(() => mintCache.delete(key));
      mintCache.set(key, value);
    });
    missingAtas.forEach((mint, index) => {
      const key = `${endpoint}:${wallet.toBase58()}:${mint}`;
      const value = batch.then(({ ataValues, rentLamports }) =>
        inspectParsedAssociatedTokenAccount(
          ataValues[index] ?? null,
          wallet,
          new PublicKey(mint),
          TOKEN_PROGRAM_ID,
          rentLamports,
        ));
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

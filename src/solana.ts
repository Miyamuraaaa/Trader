import { createSolanaRpc, mainnet } from '@solana/kit';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  CONFIG,
  BASE_SIGNATURE_FEE_LAMPORTS,
  LAMPORTS_PER_SOL,
  MINTS,
  DECIMALS,
} from './config.js';
import { log } from './logger.js';
import { runScannerRpc } from './scanner-rpc-limiter.js';

/**
 * Read-only Solana RPC access via the official @solana/kit SDK.
 *
 * Scanner-side RPC work is admitted through one adaptive limiter so Orca,
 * Meteora, wallet/discovery reads, and fee sampling cannot independently
 * overload the same public endpoint. The isolated executor has its own RPC and
 * does not use this module-level limiter.
 */

const solanaRpcs = CONFIG.rpcUrls.map((url) => createSolanaRpc(mainnet(url)));
let activeRpcIndex = 0;
export let solanaRpc = solanaRpcs[0]!;

export const rpcMetrics = {
  logicalRequests: 0,
  failures: 0,
  failovers: 0,
  activeEndpoint: CONFIG.rpcUrls[0] ?? CONFIG.rpcUrl,
};

export function recordRpcRequests(count = 1): void {
  rpcMetrics.logicalRequests += count;
}

export async function checkRpc(): Promise<bigint> {
  let lastError: unknown;
  for (let offset = 0; offset < solanaRpcs.length; offset++) {
    const index = (activeRpcIndex + offset) % solanaRpcs.length;
    try {
      recordRpcRequests();
      const slot = await runScannerRpc(
        `scanner.health.getSlot.${index}`,
        () => solanaRpcs[index]!.getSlot().send(),
        'LOW',
      );
      if (index !== activeRpcIndex) rpcMetrics.failovers++;
      activeRpcIndex = index;
      solanaRpc = solanaRpcs[index]!;
      rpcMetrics.activeEndpoint = CONFIG.rpcUrls[index]!;
      return slot;
    } catch (error) {
      rpcMetrics.failures++;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All configured Solana RPC endpoints failed');
}

export async function verifyCanonicalTokenMints(): Promise<void> {
  const expected = [
    { symbol: 'USDC', mint: CONFIG.scanTokens.includes('USDC') ? MINTS.USDC : '', decimals: DECIMALS.USDC },
    { symbol: 'SOL/WSOL', mint: CONFIG.scanTokens.includes('SOL') ? MINTS.SOL : '', decimals: DECIMALS.SOL },
    { symbol: 'USDT', mint: CONFIG.scanTokens.includes('USDT') ? MINTS.USDT : '', decimals: DECIMALS.USDT },
  ].filter((token) => token.mint !== '');
  const connection = new Connection(rpcMetrics.activeEndpoint, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  recordRpcRequests();
  const accounts = await runScannerRpc(
    'scanner.bootstrap.verifyCanonicalTokenMints',
    () => connection.getMultipleAccountsInfo(
      expected.map((token) => new PublicKey(token.mint)),
      'confirmed',
    ),
    'HIGH',
  );
  expected.forEach((token, index) => {
    const account = accounts[index];
    if (!account || account.data.length < 45) throw new Error(`${token.symbol} canonical mint account is unavailable`);
    const decimals = account.data[44];
    if (decimals !== token.decimals) {
      throw new Error(`${token.symbol} decimals mismatch: chain=${decimals}, configured=${token.decimals}`);
    }
  });
}

/**
 * ESTIMATE the lamports a two-swap arb transaction would cost.
 *
 * Formula: base signature fee + (priority fee per CU × assumed CUs).
 * Scanner fee sampling is intentionally LOW priority; when the scanner RPC is
 * saturated the configured conservative fallback is preferable to delaying an
 * executable-candidate policy read.
 */
export async function estimateNetworkFeeLamports(): Promise<number> {
  return (await estimateNetworkFeeBreakdown()).totalLamports;
}

export interface EstimatedNetworkFeeBreakdown {
  baseFeeLamports: number;
  priorityFeeLamports: number;
  totalLamports: number;
}

export async function estimateNetworkFeeBreakdown(): Promise<EstimatedNetworkFeeBreakdown> {
  let microLamportsPerCu = CONFIG.fallbackPriorityFeeMicroLamports;

  try {
    recordRpcRequests();
    const recent = await runScannerRpc(
      'scanner.fees.getRecentPrioritizationFees',
      () => solanaRpc.getRecentPrioritizationFees().send(),
      'LOW',
    );
    const fees = recent
      .map((r) => Number(r.prioritizationFee))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (fees.length > 0) {
      fees.sort((a, b) => a - b);
      const mid = Math.floor(fees.length / 2);
      const median =
        fees.length % 2 === 0 ? (fees[mid - 1]! + fees[mid]!) / 2 : fees[mid]!;
      if (median > 0) microLamportsPerCu = median;
    }
  } catch (err) {
    log.warn('Could not fetch recent prioritization fees; using fallback', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  const priorityFeeLamports =
    (microLamportsPerCu * CONFIG.assumedComputeUnits) / 1_000_000;

  return {
    baseFeeLamports: BASE_SIGNATURE_FEE_LAMPORTS,
    priorityFeeLamports,
    totalLamports: BASE_SIGNATURE_FEE_LAMPORTS + priorityFeeLamports,
  };
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

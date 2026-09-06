import type { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import { log } from '../logger.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';

export interface PriorityFeeSnapshot {
  microLamportsPerCu: number;
  sampledAt?: number;
  sampleCount: number;
  source: 'rpc' | 'fallback';
}

let current: PriorityFeeSnapshot = {
  microLamportsPerCu: CONFIG.fallbackPriorityFeeMicroLamports,
  sampleCount: 0,
  source: 'fallback',
};

function percentile(values: number[], requested: number): number {
  if (values.length === 0) return CONFIG.fallbackPriorityFeeMicroLamports;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((requested / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function bounded(value: number): number {
  return Math.max(
    CONFIG.executionPriorityFeeMinMicroLamports,
    Math.min(CONFIG.executionPriorityFeeMaxMicroLamports, Math.ceil(value)),
  );
}

/** Synchronous hot-path read. It never performs an RPC call. */
export function currentExecutionPriorityFee(): PriorityFeeSnapshot {
  return { ...current };
}

/**
 * Samples recent landed fees in the background. The selected bounded value is
 * inserted into the exact transaction and the same value is charged by the
 * executor economics model.
 */
export async function sampleExecutionPriorityFee(
  connection: Connection,
  lockedWritableAccounts: readonly PublicKey[] = [],
  profiler?: ExecutionNetworkProfiler,
): Promise<PriorityFeeSnapshot> {
  const load = () => connection.getRecentPrioritizationFees(
    lockedWritableAccounts.length > 0 ? { lockedWritableAccounts: [...lockedWritableAccounts] } : undefined,
  );
  const samples = profiler
    ? await profiler.measure('rpc.getRecentPrioritizationFees.background', 'rpc', load)
    : await load();
  const fees = samples.map((sample) => sample.prioritizationFee)
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  current = {
    microLamportsPerCu: bounded(percentile(fees, CONFIG.executionPriorityFeePercentile)),
    sampledAt: Date.now(),
    sampleCount: fees.length,
    source: fees.length > 0 ? 'rpc' : 'fallback',
  };
  return currentExecutionPriorityFee();
}

export function startExecutionPriorityFeeSampler(
  connection: Connection,
  profiler?: ExecutionNetworkProfiler,
): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void run(), CONFIG.executionPriorityFeeRefreshMs);
    timer.unref();
  };
  const run = async (): Promise<void> => {
    try {
      const snapshot = await sampleExecutionPriorityFee(connection, [], profiler);
      log.debug('Execution priority-fee sample updated', { ...snapshot });
    } catch (error) {
      log.warn('Execution priority-fee sample failed; bounded fallback/current sample retained', {
        reason: error instanceof Error ? error.message : String(error),
        retainedMicroLamportsPerCu: current.microLamportsPerCu,
      });
    } finally {
      schedule();
    }
  };
  void run();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

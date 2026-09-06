import { PublicKey, TransactionMessage, type Connection, type VersionedMessage } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import type { AtomicExecutionPlan } from './types.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';

interface CachedFee {
  lamports: number;
  expiresAt: number;
}

const fees = new Map<string, CachedFee>();
const FEE_TTL_MS = 300_000;

function priorityFeeLamports(plan: AtomicExecutionPlan): number {
  return Math.ceil(
    (plan.computeUnitLimit ?? 500_000)
      * (plan.computeUnitPriceMicroLamports ?? CONFIG.fallbackPriorityFeeMicroLamports) / 1_000_000,
  );
}

function key(message: VersionedMessage, plan: AtomicExecutionPlan): string {
  return [
    message.header.numRequiredSignatures,
    plan.computeUnitLimit ?? 500_000,
    plan.computeUnitPriceMicroLamports ?? CONFIG.fallbackPriorityFeeMicroLamports,
  ].join(':');
}

/**
 * Fail-closed local estimate used when no fresh RPC fee sample is available.
 * The base component is deliberately twice the current 5,000 lamports per
 * signature convention; priority fee is added separately from the approved
 * compute limit and price.
 */
function conservativeFloor(message: VersionedMessage, plan: AtomicExecutionPlan): number {
  return message.header.numRequiredSignatures * 10_000 + priorityFeeLamports(plan);
}

/** Preload a current fee sample outside the fresh-quote critical path. */
export async function preloadExecutionFeeEstimate(
  connection: Connection,
  message: VersionedMessage,
  plan: AtomicExecutionPlan,
  profiler?: ExecutionNetworkProfiler,
): Promise<number> {
  const load = () => connection.getFeeForMessage(message, 'confirmed');
  const response = profiler
    ? await profiler.measure('rpc.preload.getFeeForMessage', 'rpc', load)
    : await load();
  const floor = conservativeFloor(message, plan);
  const lamports = Math.max(response.value ?? 0, floor);
  fees.set(key(message, plan), { lamports, expiresAt: Date.now() + FEE_TTL_MS });
  return lamports;
}

export async function preloadExecutionPlanFee(
  connection: Connection,
  plan: AtomicExecutionPlan,
  profiler?: ExecutionNetworkProfiler,
): Promise<number> {
  const loadBlockhash = () => connection.getLatestBlockhash('confirmed');
  const latest = profiler
    ? await profiler.measure('rpc.preload.getLatestBlockhash', 'rpc', loadBlockhash)
    : await loadBlockhash();
  const message = new TransactionMessage({
    payerKey: new PublicKey(plan.wallet),
    recentBlockhash: latest.blockhash,
    instructions: plan.instructions,
  }).compileToV0Message(plan.lookupTableAccounts ?? []);
  return preloadExecutionFeeEstimate(connection, message, plan, profiler);
}

/** Synchronous hot-path lookup: never adds an RPC round trip after quoting. */
export function executionFeeEstimate(message: VersionedMessage, plan: AtomicExecutionPlan): number {
  const floor = conservativeFloor(message, plan);
  const cached = fees.get(key(message, plan));
  if (!cached || cached.expiresAt <= Date.now()) return floor;
  return Math.max(cached.lamports, floor);
}

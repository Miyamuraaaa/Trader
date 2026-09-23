import {
  Connection,
  PublicKey,
  MessageV0,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { performance } from 'node:perf_hooks';
import type { AtomicExecutionPlan, SignerContext, SimulationResult } from './types.js';
import type { LocallySignedExecution } from './approved-transaction.js';
import type { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';
import { executionFeeEstimate } from './execution-fee-cache.js';
import { prepareRaydiumSimulation, inspectRaydiumSimulationEffects } from './raydium-simulation-effects.js';

export interface PreparedExecutionBlockhash {
  value: BlockhashWithExpiryBlockHeight;
  retrievedAt: number;
  retrievalMs: number;
}

export async function fetchExecutionBlockhash(
  connection: Connection,
  profiler?: ExecutionNetworkProfiler,
): Promise<PreparedExecutionBlockhash> {
  const started = performance.now();
  const load = () => connection.getLatestBlockhash('confirmed');
  const value = profiler
    ? await profiler.measure('rpc.getLatestBlockhash', 'rpc', load)
    : await load();
  return {
    value,
    retrievedAt: Date.now(),
    retrievalMs: Number((performance.now() - started).toFixed(1)),
  };
}

export async function fetchExecutionBlockHeight(
  connection: Connection,
  profiler?: ExecutionNetworkProfiler,
): Promise<number> {
  const load = () => connection.getBlockHeight('confirmed');
  return profiler
    ? profiler.measure('rpc.getBlockHeight.final', 'rpc', load)
    : load();
}

export async function simulateAtomicTransaction(
  connection: Connection,
  plan: AtomicExecutionPlan,
  signer: Pick<SignerContext, 'publicKey'>,
  quoteSafety?: { quoteReceivedAt: number; maxAgeMs: number },
  profiler?: ExecutionNetworkProfiler,
  preparedBlockhash?: PreparedExecutionBlockhash,
): Promise<SimulationResult> {
  if (signer.publicKey !== plan.wallet) throw new Error('Simulation signer does not match execution plan');
  const prepared = preparedBlockhash ?? await fetchExecutionBlockhash(connection, profiler);
  const latest = prepared.value;
  const blockhashRetrievalMs = prepared.retrievalMs;
  const blockhashRetrievedAt = prepared.retrievedAt;
  const serializationStart = performance.now();
  let message: MessageV0;
  let transaction: VersionedTransaction;
  let transactionBytes: number;
  try {
    message = new TransactionMessage({
      payerKey: plan.type === 'RAPTOR_RAYDIUM_CYCLE'
        ? new PublicKey(signer.publicKey)
        : (signer as SignerContext).keypair.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: plan.instructions,
    }).compileToV0Message(plan.lookupTableAccounts ?? []);
    transaction = new VersionedTransaction(message);
    transactionBytes = transaction.serialize().length;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // web3.js throws this low-level message when shortvec/message encoding
    // cannot fit the composed account/instruction surface. Convert it into a
    // stable fail-closed reason rather than reporting a generic validation
    // failure that looks like an expiry.
    if (/encoding overruns Uint8Array|offset is outside|out of bounds/i.test(reason)) {
      throw new Error(`Transaction exceeds Solana packet/account encoding capacity: ${reason}`);
    }
    throw error;
  }
  const serializationMs = Number((performance.now() - serializationStart).toFixed(1));
  if (transactionBytes > 1232) throw new Error(`Transaction exceeds Solana packet limit: ${transactionBytes} bytes`);
  const raydiumSnapshot=plan.type==='RAPTOR_RAYDIUM_CYCLE'?await prepareRaydiumSimulation(connection,plan,message):undefined;
  const raydiumFee=raydiumSnapshot?(await connection.getFeeForMessage(message,'confirmed')).value:undefined;
  if(raydiumSnapshot&&(!Number.isSafeInteger(raydiumFee)||raydiumFee===null||raydiumFee===undefined||raydiumFee<=0))throw new Error('RAYDIUM_SIMULATION_FEE_UNAVAILABLE');
  const quoteAgeBeforeSimulation = quoteSafety ? Date.now() - quoteSafety.quoteReceivedAt : undefined;
  if (quoteSafety && quoteAgeBeforeSimulation! > quoteSafety.maxAgeMs) {
    throw new Error(`Final transaction quote became stale before simulation (${quoteAgeBeforeSimulation} ms > ${quoteSafety.maxAgeMs} ms)`);
  }
  const simulationRequestAt = Date.now();
  const simulationStart = performance.now();
  const simulate = () => connection.simulateTransaction(transaction, {
    commitment: 'confirmed', sigVerify: false, innerInstructions: true,
    ...(raydiumSnapshot?{minContextSlot:raydiumSnapshot.slot,accounts:{encoding:'base64' as const,addresses:raydiumSnapshot.addresses}}:{}),
  });
  const response = profiler
    ? await profiler.measure('rpc.simulateTransaction.sigVerifyFalse', 'rpc', simulate)
    : await simulate();
  const simulationRpcMs = Number((performance.now() - simulationStart).toFixed(1));
  const simulationResponseAt = Date.now();
  // Base/priority fee metadata is stable for a message shape and is preloaded
  // before candidates enter the critical path. A deliberately conservative
  // local floor applies if warmup failed; fee discovery can never hold READY.
  const estimatedFeeLamports = Math.max(executionFeeEstimate(message, plan),raydiumFee??0);
  if(raydiumSnapshot)inspectRaydiumSimulationEffects(plan,message,raydiumSnapshot,response.value,response.context.slot,raydiumFee!);
  const loadedAccountsDataSize = 'loadedAccountsDataSize' in response.value
    && typeof response.value.loadedAccountsDataSize === 'number'
    ? response.value.loadedAccountsDataSize
    : undefined;
  return {
    passed: response.value.err === null,
    error: response.value.err,
    logs: response.value.logs ?? [],
    unitsConsumed: response.value.unitsConsumed ?? undefined,
    transactionBytes,
    estimatedBaseFeeLamports: estimatedFeeLamports,
    transactionVersion: 'v0',
    staticAccountCount: message.staticAccountKeys.length,
    lookupTableCount: message.addressTableLookups.length,
    lookupTableAccountCount: message.addressTableLookups.reduce(
      (total, lookup) => total + lookup.readonlyIndexes.length + lookup.writableIndexes.length,
      0,
    ),
    lookupTableAddresses: message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58()),
    requiredSignatures: message.header.numRequiredSignatures,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    sigVerify: false,
    loadedAccountsDataSize,
    returnData: response.value.returnData ?? null,
    transaction,
    timing: {
      blockhashRetrievalMs,
      serializationMs,
      simulationRpcMs,
      blockhashRetrievedAt,
      simulationRequestAt,
      simulationResponseAt,
    },
  };
}

/**
 * Local-only final check of a previously inspected and fingerprinted message.
 * It performs no send RPC. This is deliberately separate from unsigned route
 * simulation so the signer is touched only after all earlier gates pass.
 */
export async function simulateSignedApprovedTransaction(
  connection: Connection,
  signed: LocallySignedExecution,
  profiler?: ExecutionNetworkProfiler,
): Promise<SimulationResult> {
  const transaction = signed.transaction;
  const serializationStart = performance.now();
  const transactionBytes = transaction.serialize().length;
  const serializationMs = Number((performance.now() - serializationStart).toFixed(1));
  if (transactionBytes > 1232) throw new Error(`Signed transaction exceeds Solana packet limit: ${transactionBytes} bytes`);
  const simulationRequestAt = Date.now();
  const simulationStart = performance.now();
  const simulate = () => connection.simulateTransaction(
    transaction, { commitment: 'confirmed', sigVerify: true, innerInstructions: true });
  const response = profiler
    ? await profiler.measure('rpc.simulateTransaction.sigVerifyTrue', 'rpc', simulate)
    : await simulate();
  const simulationRpcMs = Number((performance.now() - simulationStart).toFixed(1));
  const simulationResponseAt = Date.now();
  const loadedAccountsDataSize = 'loadedAccountsDataSize' in response.value
    && typeof response.value.loadedAccountsDataSize === 'number'
    ? response.value.loadedAccountsDataSize : undefined;
  return {
    passed: response.value.err === null,
    error: response.value.err,
    logs: response.value.logs ?? [],
    unitsConsumed: response.value.unitsConsumed ?? undefined,
    transactionBytes,
    // Signed simulation is a validator-only duplicate. Its fee value is not
    // used for live approval; preserve a conservative non-zero estimate.
    estimatedBaseFeeLamports: transaction.message.header.numRequiredSignatures * 10_000,
    transactionVersion: 'v0',
    staticAccountCount: transaction.message.staticAccountKeys.length,
    lookupTableCount: transaction.message.addressTableLookups.length,
    lookupTableAccountCount: transaction.message.addressTableLookups.reduce(
      (total, lookup) => total + lookup.readonlyIndexes.length + lookup.writableIndexes.length, 0),
    lookupTableAddresses: transaction.message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58()),
    requiredSignatures: transaction.message.header.numRequiredSignatures,
    blockhash: transaction.message.recentBlockhash,
    lastValidBlockHeight: undefined,
    sigVerify: true,
    loadedAccountsDataSize,
    returnData: response.value.returnData ?? null,
    transaction,
    timing: {
      blockhashRetrievalMs: 0,
      serializationMs,
      simulationRpcMs,
      blockhashRetrievedAt: simulationRequestAt,
      simulationRequestAt,
      simulationResponseAt,
    },
  };
}

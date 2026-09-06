import { Connection } from '@solana/web3.js';
import { calculateRealizedCycleResult, type ExecutionBalanceSnapshot } from './realized-accounting.js';
import type { PersistentExecutionJournal } from './execution-journal.js';

export interface ConfirmationRequest {
  signature: string;
  wallet: string;
  baseMint: string;
  intermediateMint: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  commitment?: 'confirmed' | 'finalized';
  journal?: PersistentExecutionJournal;
  executionId?: string;
}

export interface TokenBalanceRecord {
  accountIndex: number;
  mint: string;
  owner?: string;
  amount: bigint;
}

export interface ConfirmedTransactionBalanceData {
  feeLamports: bigint;
  accountKeys: string[];
  preBalances: bigint[];
  postBalances: bigint[];
  preTokenBalances: TokenBalanceRecord[];
  postTokenBalances: TokenBalanceRecord[];
}

export interface ConfirmedCycleAccounting {
  signature: string;
  actualFeeLamports: bigint;
  before: ExecutionBalanceSnapshot;
  after: ExecutionBalanceSnapshot;
  realizedBasePnlAtomic: bigint;
  intermediateDustAtomic: bigint;
  hasUnexpectedIntermediateDust: boolean;
}

function walletLamports(keys: string[], balances: bigint[], wallet: string): bigint {
  const index = keys.indexOf(wallet);
  if (index === -1) throw new Error('Confirmed transaction does not include the configured wallet');
  const balance = balances[index];
  if (balance === undefined) throw new Error('Confirmed transaction is missing the wallet balance');
  return balance;
}

function tokenAmount(records: TokenBalanceRecord[], wallet: string, mint: string): bigint {
  return records
    .filter((record) => record.owner === wallet && record.mint === mint)
    .reduce((total, record) => total + record.amount, 0n);
}

export function calculateConfirmedCycleAccounting(
  signature: string,
  wallet: string,
  baseMint: string,
  intermediateMint: string,
  data: ConfirmedTransactionBalanceData,
): ConfirmedCycleAccounting {
  const before: ExecutionBalanceSnapshot = {
    capturedAt: Date.now(),
    baseAmount: tokenAmount(data.preTokenBalances, wallet, baseMint),
    intermediateAmount: tokenAmount(data.preTokenBalances, wallet, intermediateMint),
    solLamports: walletLamports(data.accountKeys, data.preBalances, wallet),
  };
  const after: ExecutionBalanceSnapshot = {
    capturedAt: Date.now(),
    baseAmount: tokenAmount(data.postTokenBalances, wallet, baseMint),
    intermediateAmount: tokenAmount(data.postTokenBalances, wallet, intermediateMint),
    solLamports: walletLamports(data.accountKeys, data.postBalances, wallet),
  };
  const realized = calculateRealizedCycleResult(before, after);
  return {
    signature,
    actualFeeLamports: data.feeLamports,
    before,
    after,
    realizedBasePnlAtomic: realized.realizedBaseDelta,
    intermediateDustAtomic: realized.intermediateDustDelta,
    hasUnexpectedIntermediateDust: realized.hasUnexpectedIntermediateDust,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Read-only confirmation and accounting for a future sender. This module never
 * constructs or submits transactions; it starts from an already-existing
 * signature and verifies its confirmed on-chain outcome.
 */
export async function confirmAndAccountForCycle(
  connection: Connection,
  request: ConfirmationRequest,
): Promise<ConfirmedCycleAccounting> {
  const timeoutMs = request.timeoutMs ?? 60_000;
  const pollIntervalMs = request.pollIntervalMs ?? 750;
  const requiredCommitment = request.commitment ?? 'confirmed';
  if (request.journal && !request.executionId) throw new Error('Confirmation journal requires an execution id');
  if (request.journal && request.executionId
    && request.journal.get(request.executionId)?.state !== 'CONFIRMING') {
    await request.journal.transition(request.executionId, 'CONFIRMING');
  }
  const deadline = Date.now() + timeoutMs;
  let confirmed = false;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([request.signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) {
      if (request.journal && request.executionId) await request.journal.transition(request.executionId, 'TRANSACTION_FAILED', { reason: JSON.stringify(status.err) });
      throw new Error(`Confirmed transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === requiredCommitment || (requiredCommitment === 'confirmed' && status?.confirmationStatus === 'finalized')) {
      confirmed = true;
      break;
    }
    await wait(pollIntervalMs);
  }
  if (!confirmed) throw new Error(`Timed out waiting for ${requiredCommitment} confirmation of ${request.signature}`);
  try {
    const transaction = await connection.getTransaction(request.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction?.meta) throw new Error('Confirmed transaction details are unavailable');
    const message = transaction.transaction.message;
    const accountKeys = 'addressTableLookups' in message && message.addressTableLookups.length > 0
      ? message.getAccountKeys({ accountKeysFromLookups: transaction.meta.loadedAddresses }).keySegments().flat().map((key) => key.toBase58())
      : message.staticAccountKeys.map((key) => key.toBase58());
    const asRecords = (balances: typeof transaction.meta.preTokenBalances): TokenBalanceRecord[] =>
      (balances ?? []).map((balance) => ({
        accountIndex: balance.accountIndex,
        mint: balance.mint,
        owner: balance.owner,
        amount: BigInt(balance.uiTokenAmount.amount),
      }));
    const accounting = calculateConfirmedCycleAccounting(
      request.signature,
      request.wallet,
      request.baseMint,
      request.intermediateMint,
      {
        feeLamports: BigInt(transaction.meta.fee),
        accountKeys,
        preBalances: transaction.meta.preBalances.map(BigInt),
        postBalances: transaction.meta.postBalances.map(BigInt),
        preTokenBalances: asRecords(transaction.meta.preTokenBalances),
        postTokenBalances: asRecords(transaction.meta.postTokenBalances),
      },
    );
    if (request.journal && request.executionId) await request.journal.recordAccounting(request.executionId, accounting);
    return accounting;
  } catch (error) {
    if (request.journal && request.executionId
      && request.journal.get(request.executionId)?.state === 'CONFIRMING') {
      await request.journal.transition(request.executionId, 'ACCOUNTING_FAILED', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

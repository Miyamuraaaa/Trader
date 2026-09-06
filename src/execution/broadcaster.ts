import { Connection } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import {
  assertApprovedSignedExecution,
  type ApprovedSignedExecution,
} from './approved-transaction.js';
import type { PersistentExecutionJournal } from './execution-journal.js';
import { assertLiveSubmissionAllowed, type LiveSubmissionGuardConfig } from './live-guard.js';
import type { PersistentRiskManager } from './risk-manager.js';
import { executionQuoteAgeLimit } from './quote-freshness.js';

export interface SubmissionTransport {
  submitExactSignedBytes(bytes: Uint8Array): Promise<string>;
}

/** The only production RPC call capable of submitting bytes. No retry exists. */
export class SolanaRpcSubmissionTransport implements SubmissionTransport {
  constructor(private readonly connection: Connection) {}

  submitExactSignedBytes(bytes: Uint8Array): Promise<string> {
    return this.connection.sendRawTransaction(bytes, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      // An ambiguous result must be reconciled by its already-known signature,
      // never resent by this application or retried by the RPC node.
      maxRetries: 0,
    });
  }
}

export class AmbiguousSubmissionError extends Error {
  constructor(public readonly transactionSignature: string, cause: unknown) {
    super(`Submission result is ambiguous; reconcile signature ${transactionSignature} before any further action`, { cause });
    this.name = 'AmbiguousSubmissionError';
  }
}

export interface OneShotBroadcasterOptions {
  readinessReady: boolean;
  guardConfig?: LiveSubmissionGuardConfig;
  now?: () => number;
  maxQuoteAgeMs?: number;
  maxBlockhashAgeMs?: number;
}

/**
 * Narrow one-shot boundary. It cannot choose routes, quote, build, alter, or
 * sign. It can submit only the exact bytes of an in-process approval object.
 */
export class OneShotBroadcaster {
  private attempted = false;

  constructor(
    private readonly transport: SubmissionTransport,
    private readonly journal: PersistentExecutionJournal,
    private readonly risk: PersistentRiskManager,
    private readonly options: OneShotBroadcasterOptions,
  ) {}

  async submit(approved: ApprovedSignedExecution): Promise<string> {
    assertLiveSubmissionAllowed(this.options.readinessReady, this.options.guardConfig);
    if (this.attempted) throw new Error('One-shot broadcaster already attempted a submission in this process');
    assertApprovedSignedExecution(approved);

    const now = (this.options.now ?? Date.now)();
    const maxQuoteAge = this.options.maxQuoteAgeMs ?? executionQuoteAgeLimit(approved.plan);
    const maxBlockhashAge = this.options.maxBlockhashAgeMs ?? CONFIG.maxApprovedBlockhashAgeMs;
    const marketEvidenceAt = approved.signedSimulation?.timing.simulationResponseAt
      ?? approved.unsignedSimulation.timing.simulationResponseAt;
    if (now - marketEvidenceAt > maxQuoteAge) {
      throw new Error('Broadcast blocked: approved market evidence is stale');
    }
    if (now - approved.unsignedSimulation.timing.blockhashRetrievedAt > maxBlockhashAge) {
      throw new Error('Broadcast blocked: approved blockhash is stale');
    }

    const record = this.journal.get(approved.executionId);
    if (!record || (record.state !== 'APPROVED_FOR_SUBMISSION' && record.state !== 'APPROVED_BY_USER')) {
      throw new Error('Broadcast blocked: journal is not awaiting a valid user approval');
    }
    if (record.messageHash !== approved.messageHash) {
      throw new Error('Broadcast blocked: journal fingerprint mismatch');
    }
    const competing = this.journal.unresolved().filter((item) => item.id !== approved.executionId);
    if (competing.length > 0) throw new Error('Broadcast blocked: another unresolved execution requires reconciliation');

    this.risk.assertCanExecute(approved.executionId);
    const bytes = approved.transaction.serialize();
    // Persist the deterministic signature and exact byte hash before invoking
    // the RPC. A crash or network ambiguity therefore blocks all new sends.
    await this.journal.transition(approved.executionId, 'SUBMITTING', {
      messageHash: approved.messageHash,
      serializedTransactionHash: approved.serializedTransactionHash,
      signature: approved.transactionSignature,
      wallet: approved.plan.wallet,
      baseMint: approved.plan.inputMint,
      intermediateMint: approved.plan.intermediateMint,
      inputAmount: approved.plan.inputAmount.toString(),
    });
    await this.risk.recordSubmissionAttempt(approved.executionId);
    this.attempted = true;

    let returnedSignature: string;
    try {
      returnedSignature = await this.transport.submitExactSignedBytes(bytes);
    } catch (error) {
      // Intentionally leave SUBMITTING unresolved. The deterministic local
      // signature is enough to reconcile without a dangerous resubmission.
      throw new AmbiguousSubmissionError(approved.transactionSignature, error);
    }
    if (returnedSignature !== approved.transactionSignature) {
      throw new AmbiguousSubmissionError(
        approved.transactionSignature,
        new Error(`RPC returned unexpected signature ${returnedSignature}`),
      );
    }
    await this.journal.transition(approved.executionId, 'SUBMITTED', {
      signature: approved.transactionSignature,
    });
    return approved.transactionSignature;
  }
}

import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG, DECIMALS, MINTS } from './config.js';
import { SolanaRpcSubmissionTransport } from './execution/broadcaster.js';
import { createSubmissionBroadcaster } from './execution/submission-capability.js';
import { bootstrapExecutor } from './execution/executor-bootstrap.js';
import { SubmissionReconciler,chainRecoveryObserver } from './execution/submission-reconciler.js';
import { AggregatorHandoffInbox } from './execution/aggregator-handoff-inbox.js';
import { aggregatorHandoffIdentity, parseAggregatorAtomicHandoff, type AggregatorAtomicHandoff } from './execution/aggregator-handoff-dto.js';
import { validateAggregatorHandoffForApproval } from './execution/aggregator-handoff-validator.js';
import { confirmAndAccountForCycle, ConfirmedTransactionFailure, type ConfirmedCycleAccounting } from './execution/confirmation-accounting.js';
import { PersistentExecutionJournal, SUBMISSION_POSSIBLE_STATES, type ExecutionRecord } from './execution/execution-journal.js';
import { PersistentExecutionLock } from './execution/execution-lock.js';
import { handoffIdentity, parseOrcaAtomicHandoff, type OrcaAtomicHandoff } from './execution/handoff-dto.js';
import { OrcaHandoffInbox } from './execution/handoff-inbox.js';
import { validateOrcaHandoffForApproval } from './execution/handoff-validator.js';
import { captureAndValidateLiveBalances, captureLiveExecutionBalances } from './execution/live-balance-preflight.js';
import { assertLiveSubmissionAllowed } from './execution/live-guard.js';
import { EXECUTION_IMPLEMENTATION_READY } from './execution/readiness-manifest.js';
import { PersistentRiskManager, confirmedRiskPnl } from './execution/risk-manager.js';
import { log } from './logger.js';
import { fromAtomic, toAtomic } from './math.js';
import type { AtomicExecutionPlan, SignerContext, SimulationResult } from './execution/types.js';
import type { ApprovedSignedExecution } from './execution/approved-transaction.js';
import type { ExecutorEconomics } from './execution/handoff-validator.js';
import {
  createExecutionConnection, executionRpcEndpointLabel,
} from './execution/execution-connection.js';
import {
  classifyExecutionExpiry,
  executionStageMetrics,
  getLatestExecutionStage,
  logExecutionStage,
} from './execution/execution-diagnostics.js';
import { preloadExecutionPreflight } from './execution/execution-preflight-cache.js';
import { ExecutionNetworkProfiler, executionNetworkMetrics } from './execution/network-profiler.js';
import { discoverOrcaPools, setOrcaExecutionSnapshotProvider } from './orca.js';
import { ExecutionAccountStream } from './execution/execution-account-stream.js';
import { OrcaLiveStateCache } from './execution/orca-live-state.js';
import {
  currentExecutionPriorityFee,
  startExecutionPriorityFeeSampler,
} from './execution/priority-fee-oracle.js';
import { executionQuoteAgeLimit } from './execution/quote-freshness.js';
import { recordLiveCandidateOutcome } from './execution/live-candidate-window.js';
import type { ManualApprovalResponse, ManualApprovalView } from './execution/manual-approval.js';
import { randomUUID } from 'node:crypto';
import { JitoBlockEngineSubmissionTransport } from './execution/jito-submission-transport.js';
import { AGGREGATOR_CPI_PROGRAM_ALLOWLIST, AGGREGATOR_EXECUTION_PROGRAM_ALLOWLIST } from './execution/transaction-inspector.js';
import { seedAggregatorExecutableAccountCache } from './execution/aggregator-cycle-builder.js';
import { seedMixedExecutableAccountCache } from './execution/mixed-cycle-builder.js';

export interface LiveExecutionWorker {
  stop(): void;
  readonly running: boolean;
  approveManual(executionId: string, messageHash: string, approvalToken: string): Promise<ManualApprovalResponse>;
  rejectManual(executionId: string, messageHash: string, approvalToken: string): Promise<ManualApprovalResponse>;
  enqueueCandidate(candidate: unknown): void;
  prewarmMints(mints: readonly string[]): void;
}

export interface LiveExecutionWorkerOptions {
  bootstrap?: Awaited<ReturnType<typeof bootstrapExecutor>>;
  /** Isolated diagnostic process only: manual acceptance is unavailable for its entire lifetime. */
  noBroadcast?: boolean;
  onManualApprovalUpdate?: (view: ManualApprovalView | null) => void;
}

interface PendingManualApproval {
  candidate: OrcaAtomicHandoff | AggregatorAtomicHandoff;
  identity: string;
  plan: AtomicExecutionPlan;
  economics: ExecutorEconomics;
  unsignedSimulation: SimulationResult;
  approved: ApprovedSignedExecution;
  view: ManualApprovalView;
  release: () => Promise<void>;
  busy: boolean;
}

function riskManager(): PersistentRiskManager {
  return new PersistentRiskManager({
    maxTrades: CONFIG.maxTradesPerSession,
    maxConsecutiveFailures: CONFIG.maxExecutionConsecutiveFailures,
    maxSessionLossAtomic: BigInt(toAtomic(CONFIG.maxSessionLossUsdc, DECIMALS.USDC)),
    maxDailyLossAtomic: BigInt(toAtomic(CONFIG.maxDailyLossUsdc, DECIMALS.USDC)),
    maxSingleTradeLossAtomic: BigInt(toAtomic(CONFIG.maxSingleTradeLossUsdc, DECIMALS.USDC)),
  });
}

function chargeConfirmedRisk(risk: PersistentRiskManager, id: string, accounting: ConfirmedCycleAccounting, failed: boolean): Promise<void> {
  const debit = accounting.before.solLamports - accounting.after.solLamports;
  // Count fees even if a rent refund masks the SOL debit. Do not count SOL credits as USDC wins.
  return risk.recordConfirmed(id, confirmedRiskPnl(accounting.realizedBasePnlAtomic,
    debit > accounting.actualFeeLamports ? debit : accounting.actualFeeLamports,
    BigInt(toAtomic(CONFIG.executionSolPriceCeilingUsdc, DECIMALS.USDC))), failed, accounting.signature);
}

async function reconcile(connection: Connection, journal: PersistentExecutionJournal, record: ExecutionRecord, risk: PersistentRiskManager): Promise<void> {
  if (!['SUBMITTING', 'SUBMITTED', 'CONFIRMING'].includes(record.state)) {
    throw new Error(`Pre-submission ${record.state} record reached submission reconciliation unexpectedly`);
  }
  if (!record.signature || !record.wallet || !record.baseMint || !record.intermediateMint) {
    throw new Error('Unresolved submission lacks persisted reconciliation metadata; manual review required');
  }
  const accounting = await confirmAndAccountForCycle(connection, {
    signature: record.signature, wallet: record.wallet, baseMint: record.baseMint,
    intermediateMint: record.intermediateMint, commitment: CONFIG.executionConfirmationCommitment,
    journal, executionId: record.id,
    onConfirmed: (accounting, failed) => chargeConfirmedRisk(risk, record.id, accounting, failed),
  });
  log.info('Reconciled existing live submission', {
    signature: record.signature, realizedUsdcAtomic: accounting.realizedBasePnlAtomic.toString(),
    feeLamports: accounting.actualFeeLamports.toString(),
  });
}

async function prepareCandidate(
  candidate: OrcaAtomicHandoff | AggregatorAtomicHandoff,
  connection: Connection,
  journal: PersistentExecutionJournal,
  risk: PersistentRiskManager,
  signer: SignerContext,
): Promise<PendingManualApproval | undefined> {
  const isAggregator = candidate.schema === 'sol-arb.aggregator-execution-handoff';
  const identity = isAggregator ? aggregatorHandoffIdentity(candidate) : handoffIdentity(candidate);
  const lock = new PersistentExecutionLock();
  const release = await lock.acquire(identity);
  let retainLock = false;
  try {
    risk.assertCanExecute(identity);
    const validation = isAggregator
      ? await validateAggregatorHandoffForApproval(candidate, {
        connection, journal, signer, journalAlreadyLoaded: true,
      })
      : await validateOrcaHandoffForApproval(candidate, {
        connection, journal, signer, journalAlreadyLoaded: true,
      });
    if (validation.status !== 'APPROVED_FOR_SUBMISSION' || !validation.approvedSignedExecution
      || !validation.plan || !validation.economics || !validation.unsignedSimulation) {
      const reason = validation.reason ?? 'unknown reason';
      const lastStage = getLatestExecutionStage(identity);
      const expired = /stale|expired|age/i.test(reason);
      const expiryStage = expired ? classifyExecutionExpiry(reason, lastStage?.stage) : undefined;
      recordLiveCandidateOutcome({
        identity,
        outcome: expired ? 'EXPIRED' : 'REJECTED',
        reason: expiryStage ? `${expiryStage}: ${reason}` : reason,
        lastCompletedStage: lastStage?.stage,
        candidateToOutcomeMs: Math.max(0, Date.now() - candidate.detectedAt),
        recordedAt: Date.now(),
      });
      log.info('Scanner candidate rejected by independent executor', {
        identity, reason, expiryStage,
      });
      return undefined;
    }
    if (validation.economics.conservativeNetAtomic < BigInt(toAtomic(CONFIG.minNetProfitUsdc, DECIMALS.USDC))
      || validation.economics.conservativeRoiBps < BigInt(CONFIG.minProfitBps)) {
      throw new Error('Conservative economics changed below live threshold');
    }
    const maxQuoteAgeMs = executionQuoteAgeLimit(validation.plan);
    const evidenceAt = validation.unsignedSimulation.timing.simulationResponseAt;
    const evidenceAgeMs = Date.now() - evidenceAt;
    if (evidenceAgeMs > maxQuoteAgeMs) {
      throw new Error(`Execution simulation evidence expired before manual approval: age=${evidenceAgeMs}ms limit=${maxQuoteAgeMs}ms`);
    }
    // Keep the card available for one short human reaction window. The exact
    // signed transaction still obeys its 1200/1800ms quote limit; a later
    // click receives one scoped route refresh rather than a stale broadcast.
    const expiresAt = validation.unsignedSimulation.timing.blockhashRetrievedAt + CONFIG.maxApprovedBlockhashAgeMs;
    const providers: [string, string] = isAggregator
      ? candidate.providers
      : ['orca', 'orca'];
    const view: ManualApprovalView = {
      state: 'READY_TO_EXECUTE',
      executionId: identity,
      messageHash: validation.approvedSignedExecution.messageHash,
      approvalToken: randomUUID(),
      providers,
      routeType: validation.plan.type,
      intermediateMint: validation.plan.intermediateMint,
      inputUsdc: fromAtomic(validation.plan.inputAmount, DECIMALS.USDC).toFixed(),
      expectedOutputAtomic: validation.plan.expectedOutputAmount.toString(),
      minimumOutputAtomic: validation.plan.minimumOutputAmount.toString(),
      conservativeNetUsdc: fromAtomic(validation.economics.conservativeNetAtomic, DECIMALS.USDC).toFixed(),
      roiBps: validation.economics.conservativeRoiBps.toString(),
      confidenceScore: isAggregator ? candidate.scannerObservation.confidenceScore ?? null : null,
      quoteAgeMs: Math.max(0, Date.now() - validation.plan.quoteReceivedAt),
      candidateToReadyLatencyMs: Math.max(0, Date.now() - candidate.detectedAt),
      simulation: {
        passed: validation.unsignedSimulation.passed,
        unitsConsumed: validation.unsignedSimulation.unitsConsumed,
        transactionBytes: validation.unsignedSimulation.transactionBytes,
      },
      expiresAt,
      updatedAt: Date.now(),
    };
    recordLiveCandidateOutcome({
      identity,
      outcome: 'READY_TO_EXECUTE',
      lastCompletedStage: 'FINAL_PROFITABILITY_PASS',
      candidateToOutcomeMs: Math.max(0, Date.now() - candidate.detectedAt),
      recordedAt: Date.now(),
    });
    logExecutionStage(identity, 'READY_TO_EXECUTE', candidate.detectedAt, {
      readyForUserApprovalAgeMs: Math.max(0, Date.now() - candidate.detectedAt),
      routeQuoteLimitMs: maxQuoteAgeMs,
    });
    retainLock = true;
    return {
      candidate, identity, plan: validation.plan, economics: validation.economics,
      unsignedSimulation: validation.unsignedSimulation, approved: validation.approvedSignedExecution,
      view, release, busy: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Balance/freshness failures can happen after approval but before the
    // broadcaster marks SUBMITTING. Finalize that known pre-submission state
    // immediately; never touch SUBMITTING/SUBMITTED/CONFIRMING here because
    // those require deterministic reconciliation.
    if (journal.get(identity)?.state === 'APPROVED_FOR_SUBMISSION') {
      await journal.transition(identity, 'REJECTED', { reason });
    }
    const lastStage = getLatestExecutionStage(identity);
    const expired = /stale|expired|age/i.test(reason);
    const expiryStage = expired ? classifyExecutionExpiry(reason, lastStage?.stage) : undefined;
    recordLiveCandidateOutcome({
      identity,
      outcome: expired ? 'EXPIRED' : 'REJECTED',
      reason: expiryStage ? `${expiryStage}: ${reason}` : reason,
      lastCompletedStage: lastStage?.stage,
      candidateToOutcomeMs: Math.max(0, Date.now() - candidate.detectedAt),
      recordedAt: Date.now(),
    });
    logExecutionStage(identity, 'REJECTED', candidate.detectedAt, {
      reason, expiryStage,
      lastCompletedStage: lastStage?.stage,
    });
    return undefined;
  } finally {
    if (!retainLock) await release();
  }
}

/**
 * Consumes fresh strict handoffs. The executor independently requotes every
 * candidate and accepts only an audited atomic plan.
 */
export async function startLiveExecutionWorker(
  signer: SignerContext,
  options: LiveExecutionWorkerOptions = {},
): Promise<LiveExecutionWorker> {
  const noBroadcast = options.noBroadcast === true;
  if (noBroadcast) {
    if (CONFIG.liveTradingEnabled) throw new Error('No-broadcast validation requires LIVE_TRADING_ENABLED=false');
  } else assertLiveSubmissionAllowed(EXECUTION_IMPLEMENTATION_READY);
  if (CONFIG.executionRpcUrl === CONFIG.rpcUrl) {
    log.warn('Execution RPC is shared with scanner RPC; public rate limits can prevent sub-second approval', {
      executionRpc: executionRpcEndpointLabel(),
      action: 'Configure EXECUTION_RPC_URL and optionally EXECUTION_WS_URL independently',
    });
  }
  const connection = createExecutionConnection();
  const accountStream = new ExecutionAccountStream(connection);
  const orcaLiveState = new OrcaLiveStateCache(connection, accountStream);
  await accountStream.start();
  setOrcaExecutionSnapshotProvider(orcaLiveState);
  let stopped = false;
  let priorityFeeSampler: { stop(): void } | undefined;
  const bootstrap=options.bootstrap??await bootstrapExecutor(noBroadcast);
  if(bootstrap.state!=='READY_FOR_SIGNER')throw new Error('Executor bootstrap is not ready for candidate execution');
  const journal = bootstrap.journal;
  const risk = bootstrap.risk;
  const reconciler=new SubmissionReconciler({journal,risk,observe:chainRecoveryObserver(connection,CONFIG.executionConfirmationCommitment),height:()=>connection.getBlockHeight(CONFIG.executionConfirmationCommitment),pollMs:CONFIG.liveExecutionPollMs,maxObservationAgeMs:2000,endpoint:executionRpcEndpointLabel(),commitment:CONFIG.executionConfirmationCommitment,solPriceAtomic:BigInt(toAtomic(CONFIG.executionSolPriceCeilingUsdc,DECIMALS.USDC))});
  const inbox = new OrcaHandoffInbox();
  const aggregatorInbox = new AggregatorHandoffInbox();
  log.info('Live executor journal load started');
  await journal.load();
  log.info('Live executor journal load completed', { records: journal.all().length });
  const lockRecovered = await new PersistentExecutionLock().recoverDeadOwner();
  if (lockRecovered) log.warn('Recovered execution lock owned by a dead process');
  const recovery = await journal.recoverInterruptedPreSubmission();
  for (const record of recovery.finalizedPreSubmission) {
    log.warn('Finalized interrupted pre-submission execution', {
      id: record.id, state: record.state, reason: record.reason,
    });
  }
  if (recovery.requiresReconciliation.length > 1) {
    throw new Error('Multiple submission-possible journal records require manual reconciliation');
  }
  log.info('Live executor risk state load started');
  await risk.load();
  log.info('Live executor risk state load completed');
  const warmupProfiler = new ExecutionNetworkProfiler();
  log.info('Live executor static route warmup started', { executionRpc: executionRpcEndpointLabel() });
  const warmupPromise = (async () => {
    const failures: string[] = [];
    // Public RPCs reject a burst of otherwise harmless warmup calls. Keep RPC
    // state work sequential while overlapping only the independent HTTP pool
    // index reads. A P0 handoff never waits for this task.
    const [wsolPoolsResult, usdtPoolsResult] = await Promise.allSettled([
      warmupProfiler.measure('http.orca.poolDiscovery.USDC-WSOL', 'http', () =>
        discoverOrcaPools(MINTS.USDC, MINTS.SOL)),
      warmupProfiler.measure('http.orca.poolDiscovery.USDC-USDT', 'http', () =>
        discoverOrcaPools(MINTS.USDC, MINTS.USDT)),
    ]);
    try {
      await preloadExecutionPreflight(
        connection, signer.keypair.publicKey, [MINTS.USDC, MINTS.SOL, MINTS.USDT], warmupProfiler,
      );
    } catch (error) { failures.push(String(error)); }
    try {
      const programAddresses = [...new Set([
        ...AGGREGATOR_EXECUTION_PROGRAM_ALLOWLIST,
        ...AGGREGATOR_CPI_PROGRAM_ALLOWLIST,
      ])];
      const infos = await warmupProfiler.measure(
        'rpc.prewarm.executionProgramAccounts',
        'rpc',
        () => connection.getMultipleAccountsInfo(
          programAddresses.map((address) => new PublicKey(address)), 'confirmed',
        ),
      );
      const entries = new Map(programAddresses.map((address, index) => [
        address, infos[index]?.executable === true,
      ] as const));
      seedAggregatorExecutableAccountCache(entries);
      seedMixedExecutableAccountCache(entries);
    } catch (error) { failures.push(String(error)); }
    if (wsolPoolsResult.status === 'fulfilled') {
      const selected = wsolPoolsResult.value.slice(0, 3);
      for (const direction of [MINTS.USDC, MINTS.SOL]) {
        try { await orcaLiveState.watch(selected, direction, warmupProfiler); }
        catch (error) { failures.push(String(error)); }
      }
    } else failures.push(String(wsolPoolsResult.reason));
    if (usdtPoolsResult.status === 'fulfilled') {
      try { await orcaLiveState.watch(usdtPoolsResult.value.slice(0, 3), MINTS.USDC, warmupProfiler); }
      catch (error) { failures.push(String(error)); }
    } else failures.push(String(usdtPoolsResult.reason));
    log.info('Live executor static route warmup completed', {
      requests: warmupProfiler.timings,
      failures,
    });
  })();
  // This intentionally warms only reusable metadata. Building a real route
  // requires a fresh quote and a fresh blockhash, so doing it here both wastes
  // RPC capacity and makes the next candidate wait behind stale work.
  void warmupPromise.catch((error: unknown) => {
    log.warn('Execution static warmup failed; fresh candidate validation remains available', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    if (!stopped) priorityFeeSampler = startExecutionPriorityFeeSampler(connection);
  });
  let timer: NodeJS.Timeout | undefined;
  const stateMetricsTimer = setInterval(() => {
    log.info('Execution market-state cache health', {
      ...orcaLiveState.metrics(),
      priorityFee: currentExecutionPriorityFee(),
      networkP50P90: executionNetworkMetrics(),
      hotPathP50P90: executionStageMetrics(),
    });
  }, CONFIG.providerHealthIntervalMs);
  stateMetricsTimer.unref();
  // Activated only by the no-broadcast comparison bootstrap, never production.
  comparisonBarrier.onStop(()=>{stopped=true;if(timer)clearTimeout(timer);clearInterval(stateMetricsTimer);priorityFeeSampler?.stop();});
  const attemptedCandidates = new Set<string>();
  const latestAttemptedByRoute = new Map<string, number>();
  const directCandidates: Array<OrcaAtomicHandoff | AggregatorAtomicHandoff> = [];
  let executionDisabledReason: string | undefined;
  let pending: PendingManualApproval | undefined;
  let tickInFlight = false;
  let wakeExecutor = (): void => undefined;

  const routeKey = (candidate: OrcaAtomicHandoff | AggregatorAtomicHandoff): string => candidate.schema === 'sol-arb.aggregator-execution-handoff'
    ? `${candidate.providers.join(':')}:${candidate.inputMint}:${candidate.intermediateMint}:${candidate.outputMint}:${candidate.proposedInputAmount}`
    : `orca:orca:${candidate.inputMint}:${candidate.intermediateMint}:${candidate.outputMint}:${candidate.proposedInputAmount}:${candidate.pools.join(':')}`;
  const enqueueCandidate = (value: unknown): void => {
    try {
      const candidate = typeof value === 'object' && value !== null
        && (value as { schema?: string }).schema === 'sol-arb.aggregator-execution-handoff'
        ? parseAggregatorAtomicHandoff(value)
        : parseOrcaAtomicHandoff(value);
      const key = routeKey(candidate);
      const index = directCandidates.findIndex((item) => routeKey(item) === key);
      if (index >= 0) directCandidates.splice(index, 1);
      directCandidates.push(candidate);
      directCandidates.sort((a, b) => b.detectedAt - a.detectedAt);
      directCandidates.splice(6);
      const identity = candidate.schema === 'sol-arb.aggregator-execution-handoff'
        ? aggregatorHandoffIdentity(candidate) : handoffIdentity(candidate);
      const executorReceiveAt = Date.now();
      logExecutionStage(identity, 'EXECUTOR_RECEIVED', candidate.detectedAt, {
        delivery: 'P0_IPC',
        executorReceiveAt,
        executorReceiveAtIso: new Date(executorReceiveAt).toISOString(),
        queueLatencyMs: Math.max(0, executorReceiveAt - candidate.detectedAt),
        queuedP0Candidates: directCandidates.length,
      });
      // Static policy/ATA inspection is safe to overlap with the P0 handoff.
      // The validator will reuse this cache but still obtains its own fresh
      // market quote, blockhash, and simulation before approval.
      void preloadExecutionPreflight(connection, signer.keypair.publicKey, [
        MINTS.USDC, candidate.intermediateMint,
      ]).catch((error: unknown) => {
        log.debug('P0 execution preflight warmup failed; validator will fail closed if still unavailable', {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      const hintedOrcaPools = candidate.schema === 'sol-arb.aggregator-execution-handoff'
        ? candidate.providers.flatMap((provider, providerIndex) => provider === 'orca'
          ? (candidate.scannerPools[providerIndex] ?? []).map((address) => ({
            venue: 'orca' as const,
            address,
            tokenMintA: candidate.inputMint,
            tokenMintB: candidate.intermediateMint,
            poolType: 'whirlpool',
          }))
          : [])
        : candidate.pools.map((address) => ({
          venue: 'orca' as const,
          address,
          tokenMintA: candidate.inputMint,
          tokenMintB: candidate.intermediateMint,
          poolType: 'whirlpool',
        }));
      if (hintedOrcaPools.length > 0) {
        const direction = candidate.schema === 'sol-arb.aggregator-execution-handoff'
          ? candidate.providers[0] === 'orca' ? candidate.inputMint : candidate.intermediateMint
          : undefined;
        void orcaLiveState.watch(hintedOrcaPools, direction).catch((error: unknown) => {
          log.debug('P0 Orca route-state warmup failed; validator retains bounded RPC fallback', {
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      }
      wakeExecutor();
    } catch (error) {
      log.warn('Rejected malformed fast executor handoff; durable inbox remains isolated', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const emitApproval = (view: ManualApprovalView | null): void => options.onManualApprovalUpdate?.(view);
  const response = (ok: boolean, view: ManualApprovalView | null, error?: string): ManualApprovalResponse => ({ ok, view, error });
  const releasePending = async (clearView = true): Promise<void> => {
    const current = pending;
    pending = undefined;
    if (clearView) emitApproval(null);
    if (current) await current.release();
  };
  const clearTerminalViewLater = (): void => {
    setTimeout(() => { if (!pending) emitApproval(null); }, 5_000).unref();
  };
  const updatePending = (state: ManualApprovalView['state'], patch: Partial<ManualApprovalView> = {}): void => {
    if (!pending) return;
    pending.view = { ...pending.view, ...patch, state, updatedAt: Date.now() };
    emitApproval(pending.view);
  };
  const expirePending = async (reason: string): Promise<ManualApprovalResponse> => {
    if (!pending) return response(false, null, 'No ready transaction is awaiting approval');
    const current = pending;
    if (journal.get(current.identity)?.state === 'APPROVED_FOR_SUBMISSION' || journal.get(current.identity)?.state === 'APPROVED_BY_USER') {
      await journal.transition(current.identity, 'EXPIRED', { reason });
    }
    updatePending('APPROVAL_EXPIRED', { reason });
    recordLiveCandidateOutcome({
      identity: current.identity, outcome: 'EXPIRED', reason,
      lastCompletedStage: 'READY_TO_EXECUTE',
      candidateToOutcomeMs: Math.max(0, Date.now() - current.candidate.detectedAt), recordedAt: Date.now(),
    });
    const view = pending?.view ?? current.view;
    await releasePending(false);
    clearTerminalViewLater();
    return response(false, view, reason.startsWith('OPPORTUNITY_NO_LONGER_PROFITABLE')
      ? 'OPPORTUNITY_NO_LONGER_PROFITABLE'
      : 'APPROVAL_EXPIRED');
  };
  const matchesPending = (executionId: string, messageHash: string, approvalToken: string): string | undefined => {
    if (!pending) return 'No ready transaction is awaiting approval';
    if (pending.identity !== executionId || pending.approved.messageHash !== messageHash
      || pending.view.messageHash !== messageHash || pending.view.approvalToken !== approvalToken) {
      return 'Approval does not match the currently prepared transaction';
    }
    if (pending.busy) return 'Approval is already being processed';
    if (pending.view.state !== 'READY_TO_EXECUTE') return `Transaction is not awaiting approval: ${pending.view.state}`;
    const record = journal.get(executionId);
    if (!record || record.state !== 'APPROVED_FOR_SUBMISSION' || record.messageHash !== messageHash) {
      return 'Prepared transaction journal state or fingerprint is no longer valid';
    }
    return undefined;
  };

  const rejectManual = async (executionId: string, messageHash: string, approvalToken: string): Promise<ManualApprovalResponse> => {
    const mismatch = matchesPending(executionId, messageHash, approvalToken);
    if (mismatch) return response(false, pending?.view ?? null, mismatch);
    const current = pending!;
    current.busy = true;
    await journal.transition(current.identity, 'REJECTED', { reason: 'Rejected by local dashboard user' });
    updatePending('REJECTED', { reason: 'Rejected by user' });
    const view = pending!.view;
    await releasePending(false);
    clearTerminalViewLater();
    return response(true, view);
  };

  const confirmPending = async (current: PendingManualApproval, signature: string): Promise<void> => {
    try {
      updatePending('CONFIRMING', { signature });
      const confirmationStartedAt = Date.now();
      const accounting = await confirmAndAccountForCycle(connection, {
        signature, wallet: current.plan.wallet, baseMint: MINTS.USDC,
        intermediateMint: current.plan.intermediateMint,
        commitment: CONFIG.executionConfirmationCommitment, journal, executionId: current.identity,
        onConfirmed: (accounting, failed) => chargeConfirmedRisk(risk, current.identity, accounting, failed),
      });
      const refreshed = await captureLiveExecutionBalances(connection, current.plan);
      updatePending('CONFIRMED', {
        signature,
        actualNetworkFeeLamports: accounting.actualFeeLamports.toString(),
        realizedUsdcPnl: fromAtomic(accounting.realizedBasePnlAtomic, DECIMALS.USDC).toFixed(),
        intermediateDustAtomic: accounting.intermediateDustAtomic.toString(),
        confirmationTimeMs: Date.now() - confirmationStartedAt,
      });
      logExecutionStage(current.identity, 'CONFIRMED', current.candidate.detectedAt, {
        sendToConfirmedMs: Date.now() - confirmationStartedAt,
      });
      log.warn('Live transaction confirmed', {
        signature, identity: current.identity, realizedUsdcAtomic: accounting.realizedBasePnlAtomic.toString(),
        networkFeeLamports: accounting.actualFeeLamports.toString(),
        intermediateDustAtomic: accounting.intermediateDustAtomic.toString(),
        refreshedUsdcAtomic: refreshed.baseAmount.toString(), refreshedSolLamports: refreshed.solLamports.toString(),
      });
    } catch (error) {
      // RPC timeout/ambiguous confirmation is not a confirmed transaction failure or fee.
      updatePending(error instanceof ConfirmedTransactionFailure ? 'TRANSACTION_FAILED' : 'CONFIRMING', { reason: error instanceof Error ? error.message : String(error) });
      log.error('Submitted transaction failed confirmation/accounting', { identity: current.identity, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      // Keep terminal feedback visible briefly; the approval token cannot be reused.
      setTimeout(() => { if (pending === current) void releasePending(); }, 5_000).unref();
    }
  };

  /**
   * The user authorized this specific route, not a scan restart. If the first
   * signed message aged out while waiting for a click, rebuild this same DTO
   * once from fresh execution state. Static checks remain in their caches;
   * the validator performs the one mandatory simulation for the new message.
   */
  const refreshPendingOnce = async (current: PendingManualApproval): Promise<string | undefined> => {
    const isAggregator = current.candidate.schema === 'sol-arb.aggregator-execution-handoff';
    const validation = isAggregator
      ? await validateAggregatorHandoffForApproval(current.candidate, {
        connection, journal, signer, journalAlreadyLoaded: true, refreshExistingApproval: true,
      })
      : await validateOrcaHandoffForApproval(current.candidate, {
        connection, journal, signer, journalAlreadyLoaded: true, refreshExistingApproval: true,
      });
    if (validation.status !== 'APPROVED_FOR_SUBMISSION' || !validation.plan || !validation.economics
      || !validation.unsignedSimulation || !validation.approvedSignedExecution) {
      return validation.reason ?? 'OPPORTUNITY_NO_LONGER_PROFITABLE';
    }
    if (validation.economics.conservativeNetAtomic < BigInt(toAtomic(CONFIG.minNetProfitUsdc, DECIMALS.USDC))
      || validation.economics.conservativeRoiBps < BigInt(CONFIG.minProfitBps)) {
      return 'OPPORTUNITY_NO_LONGER_PROFITABLE';
    }
    current.plan = validation.plan;
    current.economics = validation.economics;
    current.unsignedSimulation = validation.unsignedSimulation;
    current.approved = validation.approvedSignedExecution;
    current.view = {
      ...current.view,
      messageHash: validation.approvedSignedExecution.messageHash,
      expectedOutputAtomic: validation.plan.expectedOutputAmount.toString(),
      minimumOutputAtomic: validation.plan.minimumOutputAmount.toString(),
      conservativeNetUsdc: fromAtomic(validation.economics.conservativeNetAtomic, DECIMALS.USDC).toFixed(),
      roiBps: validation.economics.conservativeRoiBps.toString(),
      quoteAgeMs: Math.max(0, Date.now() - validation.plan.quoteReceivedAt),
      expiresAt: validation.unsignedSimulation.timing.blockhashRetrievedAt + CONFIG.maxApprovedBlockhashAgeMs,
      updatedAt: Date.now(),
    };
    return undefined;
  };

  const approveManual = async (executionId: string, messageHash: string, approvalToken: string): Promise<ManualApprovalResponse> => {
    if (noBroadcast) return response(false, null, 'NO_BROADCAST_VALIDATION: manual acceptance unavailable');
    const mismatch = matchesPending(executionId, messageHash, approvalToken);
    if (mismatch) return response(false, pending?.view ?? null, mismatch);
    if (Date.now() >= pending!.view.expiresAt) return expirePending('Manual approval arrived after prepared transaction expiry');
    const current = pending!;
    current.busy = true;
    try {
      await journal.transition(current.identity, 'APPROVED_BY_USER', { messageHash: current.approved.messageHash });
      logExecutionStage(current.identity, 'APPROVED_BY_USER', current.candidate.detectedAt, {
        readyToClickMs: Math.max(0, Date.now() - current.view.updatedAt),
      });
      updatePending('EXECUTING');
      const evidenceAt = (): number => current.approved.signedSimulation?.timing.simulationResponseAt
        ?? current.unsignedSimulation.timing.simulationResponseAt;
      const needsRefresh = (): boolean => Date.now() - evidenceAt() > executionQuoteAgeLimit(current.plan)
        || Date.now() - current.unsignedSimulation.timing.blockhashRetrievedAt > CONFIG.maxApprovedBlockhashAgeMs;
      let refreshed = false;
      // A click may arrive after the strict quote window. It is permitted one
      // exact-route refresh; it never broadens discovery or reuses old bytes.
      if (needsRefresh()) {
        const refreshReason = await refreshPendingOnce(current);
        if (refreshReason) {
          return expirePending(/profit|roi|net/i.test(refreshReason)
            ? 'OPPORTUNITY_NO_LONGER_PROFITABLE'
            : `APPROVAL_EXPIRED: ${refreshReason}`);
        }
        refreshed = true;
      }
      await captureAndValidateLiveBalances(connection, current.plan);
      if (current.economics.conservativeNetAtomic < BigInt(toAtomic(CONFIG.minNetProfitUsdc, DECIMALS.USDC))
        || current.economics.conservativeRoiBps < BigInt(CONFIG.minProfitBps)) {
        return expirePending('OPPORTUNITY_NO_LONGER_PROFITABLE');
      }
      // The balance read may itself consume the strict window. Use the one
      // permitted refresh if that happened; never send stale signed bytes.
      if (needsRefresh()) {
        if (refreshed) return expirePending('APPROVAL_EXPIRED: refreshed execution evidence aged out before submission');
        const refreshReason = await refreshPendingOnce(current);
        if (refreshReason) {
          return expirePending(/profit|roi|net/i.test(refreshReason)
            ? 'OPPORTUNITY_NO_LONGER_PROFITABLE'
            : `APPROVAL_EXPIRED: ${refreshReason}`);
        }
        refreshed = true;
        await captureAndValidateLiveBalances(connection, current.plan);
      }
      risk.assertCanExecute(current.identity, current.economics.conservativeNetAtomic);
      const broadcaster = createSubmissionBroadcaster(
        bootstrap.capability,()=>CONFIG.executionSubmissionTransport === 'jito'?new JitoBlockEngineSubmissionTransport():new SolanaRpcSubmissionTransport(connection), journal, risk, { readinessReady: EXECUTION_IMPLEMENTATION_READY },
      );
      const signature = await broadcaster.submit(current.approved);
      logExecutionStage(current.identity, 'SUBMITTED', current.candidate.detectedAt, { signature });
      updatePending('SUBMITTED', { signature });
      log.warn('User-approved live transaction submitted; waiting for confirmation', { signature, identity: current.identity });
      // Journal-driven reconciliation owns confirmation; pending never gates it.
      return response(true, pending!.view);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const currentState = journal.get(current.identity)?.state;
      if (currentState === 'APPROVED_BY_USER') {
        await journal.transition(current.identity, /stale|expired|age/i.test(reason) ? 'EXPIRED' : 'REJECTED', { reason });
      }
      if (currentState && SUBMISSION_POSSIBLE_STATES.has(currentState)) {
        updatePending('SUBMISSION_UNKNOWN', { reason });
        // A possible network submission is reconciled from its deterministic signature; never release/retry.
        return response(false, pending!.view, 'SUBMISSION_UNKNOWN');
      }
      updatePending(/stale|expired|age/i.test(reason) ? 'APPROVAL_EXPIRED' : 'REJECTED', { reason });
      const view = pending!.view;
      await releasePending(false);
      clearTerminalViewLater();
      return response(false, view, reason);
    }
  };

  /**
   * Autonomous execution path — replaces the manual approval gate.
   * Performs the same safety checks (freshness, balance, profitability, risk)
   * that approveManual did, then broadcasts immediately. The dashboard receives
   * real-time status updates through emitApproval just like the old flow.
   */
  const autoExecute = async (current: PendingManualApproval): Promise<void> => {
    if (noBroadcast) {
      log.info('Auto-execute skipped: noBroadcast mode', { identity: current.identity });
      await releasePending();
      return;
    }
    try {
      await journal.transition(current.identity, 'APPROVED_BY_USER', { messageHash: current.approved.messageHash });
      logExecutionStage(current.identity, 'APPROVED_BY_USER', current.candidate.detectedAt, {
        readyToClickMs: 0, autoExecuted: true,
      });
      updatePending('EXECUTING');

      const evidenceAt = (): number => current.approved.signedSimulation?.timing.simulationResponseAt
        ?? current.unsignedSimulation.timing.simulationResponseAt;
      const needsRefresh = (): boolean => Date.now() - evidenceAt() > executionQuoteAgeLimit(current.plan)
        || Date.now() - current.unsignedSimulation.timing.blockhashRetrievedAt > CONFIG.maxApprovedBlockhashAgeMs;
      let refreshed = false;

      // Refresh once if the evidence window has elapsed during preparation.
      if (needsRefresh()) {
        const refreshReason = await refreshPendingOnce(current);
        if (refreshReason) {
          await finalizeAutoReject(current, refreshReason);
          return;
        }
        refreshed = true;
      }

      await captureAndValidateLiveBalances(connection, current.plan);

      if (current.economics.conservativeNetAtomic < BigInt(toAtomic(CONFIG.minNetProfitUsdc, DECIMALS.USDC))
        || current.economics.conservativeRoiBps < BigInt(CONFIG.minProfitBps)) {
        await finalizeAutoReject(current, 'OPPORTUNITY_NO_LONGER_PROFITABLE');
        return;
      }

      // Balance read may consume the strict window; refresh once more if needed.
      if (needsRefresh()) {
        if (refreshed) {
          await finalizeAutoReject(current, 'Refreshed execution evidence aged out before submission');
          return;
        }
        const refreshReason = await refreshPendingOnce(current);
        if (refreshReason) {
          await finalizeAutoReject(current, refreshReason);
          return;
        }
        await captureAndValidateLiveBalances(connection, current.plan);
      }

      risk.assertCanExecute(current.identity, current.economics.conservativeNetAtomic);

      const broadcaster = createSubmissionBroadcaster(
        bootstrap.capability,()=>CONFIG.executionSubmissionTransport === 'jito'?new JitoBlockEngineSubmissionTransport():new SolanaRpcSubmissionTransport(connection), journal, risk, { readinessReady: EXECUTION_IMPLEMENTATION_READY },
      );
      const signature = await broadcaster.submit(current.approved);
      logExecutionStage(current.identity, 'SUBMITTED', current.candidate.detectedAt, { signature });
      updatePending('SUBMITTED', { signature });
      log.warn('Auto-executed live transaction submitted; waiting for confirmation', {
        signature, identity: current.identity,
      });
      // Journal-driven reconciliation owns confirmation; pending never gates it.
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const currentState = journal.get(current.identity)?.state;
      if (currentState === 'APPROVED_BY_USER') {
        await journal.transition(current.identity, /stale|expired|age/i.test(reason) ? 'EXPIRED' : 'REJECTED', { reason });
      }
      if (currentState && SUBMISSION_POSSIBLE_STATES.has(currentState)) {
        updatePending('SUBMISSION_UNKNOWN', { reason });
        log.error('Auto-execution submission ambiguous; requires reconciliation', { identity: current.identity, reason });
        // A possible network submission is reconciled from its deterministic signature; never release/retry.
        return;
      }
      updatePending(/stale|expired|age/i.test(reason) ? 'APPROVAL_EXPIRED' : 'REJECTED', { reason });
      log.warn('Auto-execution failed closed', { identity: current.identity, reason });
      await releasePending(false);
      clearTerminalViewLater();
    }
  };

  const finalizeAutoReject = async (current: PendingManualApproval, reason: string): Promise<void> => {
    const currentState = journal.get(current.identity)?.state;
    if (currentState === 'APPROVED_FOR_SUBMISSION' || currentState === 'APPROVED_BY_USER') {
      await journal.transition(current.identity, /profit|roi|net/i.test(reason) ? 'EXPIRED' : 'REJECTED', { reason });
    }
    recordLiveCandidateOutcome({
      identity: current.identity, outcome: 'EXPIRED', reason,
      lastCompletedStage: 'READY_TO_EXECUTE',
      candidateToOutcomeMs: Math.max(0, Date.now() - current.candidate.detectedAt), recordedAt: Date.now(),
    });
    updatePending('REJECTED', { reason });
    log.info('Auto-execution rejected candidate', { identity: current.identity, reason });
    await releasePending(false);
    clearTerminalViewLater();
  };

  const tick = async (): Promise<void> => {
    if (tickInFlight || stopped) return;
    const endComparison=comparisonBarrier.begin({id:pending?.identity??'executor-tick',sourceLane:null,stage:'EXECUTOR_TICK'});
    tickInFlight = true;
    try {
      // Durable submission truth precedes transient pending and risk circuit breakers.
      if(journal.unresolved().some(record=>SUBMISSION_POSSIBLE_STATES.has(record.state)))process.send?.({type:'LIVE_EXECUTOR_HEALTH',state:'RECONCILIATION_ONLY',reconciliation:reconciler.snapshot()});
      const recoveryState=await reconciler.tick();
      if(comparisonBarrier.stopped)return;
      if(recoveryState==='RECONCILIATION_ONLY')return;
      if(recoveryState==='SETTLED'){
        if(pending){
          const settled=journal.get(pending.identity);
          if(settled?.state==='CONFIRMED'||settled?.state==='TRANSACTION_FAILED'){
            updatePending(settled.state,{signature:settled.signature,actualNetworkFeeLamports:settled.accounting?.actualFeeLamports,realizedUsdcPnl:settled.accounting?fromAtomic(settled.accounting.usdcDelta,DECIMALS.USDC).toFixed():undefined,intermediateDustAtomic:settled.accounting?.intermediateDust});
            logExecutionStage(pending.identity,settled.state,pending.candidate.detectedAt,{signature:settled.signature});
          }else updatePending('APPROVAL_EXPIRED',{reason:'EXPIRED_UNLANDED: original signature absent after qualifying block heights'});
          await releasePending(false);
        }
        return;
      }
      if(pending){
        const state=journal.get(pending.identity)?.state;
        if(state==='CONFIRMED'||state==='TRANSACTION_FAILED'||state==='EXPIRED_UNLANDED')await releasePending(false);
        else return;
      }
      if(executionDisabledReason)return;
      const unresolved = journal.unresolved();
      if (unresolved.length > 0) {
        const recovery = await journal.recoverInterruptedPreSubmission(
          'Interrupted before submission inside the live worker',
        );
        for (const record of recovery.finalizedPreSubmission) {
          log.warn('Finalized interrupted pre-submission execution during worker recovery', {
            id: record.id, state: record.state, reason: record.reason,
          });
        }
        if (recovery.requiresReconciliation.length > 1) {
          throw new Error('Multiple submission-possible executions require manual reconciliation');
        }
        if (recovery.requiresReconciliation[0]) {
          await reconcile(connection, journal, recovery.requiresReconciliation[0], risk);
        }
        return;
      }
      risk.assertCanExecute('scheduler-preflight');
      process.send?.({type:'LIVE_EXECUTOR_HEALTH',state:noBroadcast?'NO_BROADCAST':'READY_FOR_NEW_SUBMISSIONS',reconciliation:reconciler.snapshot()});
      const selectCandidate = (items: Array<OrcaAtomicHandoff | AggregatorAtomicHandoff>) => items
        .sort((a, b) => b.detectedAt - a.detectedAt)
        .find((item) => {
          const identity = item.schema === 'sol-arb.aggregator-execution-handoff'
            ? aggregatorHandoffIdentity(item)
            : handoffIdentity(item);
          const lastAttempted = latestAttemptedByRoute.get(routeKey(item)) ?? 0;
          return !attemptedCandidates.has(identity) && !journal.get(identity) && item.detectedAt > lastAttempted;
        });
      // IPC-delivered P0 candidates bypass the filesystem mailbox entirely.
      // The disk inbox is only a crash/restart fallback and must never sit in
      // front of a fresh positive route.
      const priorityCandidates = [...directCandidates];
      let candidate = selectCandidate(priorityCandidates);
      if (candidate) {
        // Remove only the selected item. Other fresh P0 routes must not be
        // thrown away merely because a different provider is currently being
        // prepared; they remain ahead of filesystem inbox polling next tick.
        const selectedIndex = directCandidates.indexOf(candidate);
        if (selectedIndex >= 0) directCandidates.splice(selectedIndex, 1);
      }
      // A newer update for the same route replaces the earlier P0 DTO before
      // it can spend the strict quote window. Older unrelated P0 entries are
      // retained for the next worker turn.
      if (!candidate) {
        const [orcaCandidates, aggregatorCandidates] = await Promise.all([
          inbox.recent(), aggregatorInbox.recent(),
        ]);
        candidate = selectCandidate([...orcaCandidates, ...aggregatorCandidates]);
      }
      if (!candidate) return;
      const identity = candidate.schema === 'sol-arb.aggregator-execution-handoff'
        ? aggregatorHandoffIdentity(candidate)
        : handoffIdentity(candidate);
      attemptedCandidates.add(identity);
      latestAttemptedByRoute.set(routeKey(candidate), candidate.detectedAt);
      // Scanner observations are only a trigger. The executor requotes every
      // route, so a delayed signal may still produce a fresh, safe current
      // transaction. Do not discard it solely because the scanner snapshot is
      // old; the fresh executor quote/evidence age remains mandatory.
      logExecutionStage(identity, 'EXECUTOR_DEQUEUED', candidate.detectedAt, {
        signalAgeMs: Math.max(0, Date.now() - candidate.detectedAt),
      });
      const prepared = await prepareCandidate(candidate, connection, journal, risk, signer);
      if (prepared) {
        // ── AUTO-EXECUTION: bypass manual approval, broadcast immediately ──
        pending = prepared;
        emitApproval(prepared.view);
        log.warn('Auto-executing validated trade — no manual approval required', {
          identity: prepared.identity, messageHash: prepared.approved.messageHash,
          quoteAgeMs: prepared.view.quoteAgeMs,
        });
        await autoExecute(prepared);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.send?.({type:'LIVE_EXECUTOR_HEALTH',state:'NOT_READY',reconciliation:reconciler.snapshot()});
      if (/MAX_TRADES_PER_SESSION|MAX_CONSECUTIVE_FAILURES|MAX_SESSION_LOSS_USDC/.test(reason)) {
        executionDisabledReason = reason;
        log.warn('Live submission disabled by persistent risk circuit breaker; market scanning continues', { reason });
        return;
      }
      log.error('Live execution worker iteration failed closed', {
        reason,
      });
    } finally {
      tickInFlight = false;
      endComparison();
    }
  };
  const schedule = (): void => {
    if (stopped) return;
    // A fresh P0 candidate must not inherit the background mailbox polling
    // delay after an unrelated attempt finishes.  Regular durable-inbox
    // recovery remains rate-limited by LIVE_EXECUTION_POLL_MS.
    const delayMs = !pending && directCandidates.length > 0 ? 0 : CONFIG.liveExecutionPollMs;
    timer = setTimeout(() => { void tick().finally(schedule); }, delayMs);
  };
  wakeExecutor = (): void => {
    if (stopped || executionDisabledReason || tickInFlight) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    void tick().finally(schedule);
  };
  void tick().finally(schedule);
  log.warn('Autonomous live executor started — trades execute without manual approval', {
    pollMs: CONFIG.liveExecutionPollMs, maxTransactions: CONFIG.liveMaxTransactions,
    maxSessionLossUsdc: CONFIG.maxSessionLossUsdc,
  });
  return {
    get running() { return !stopped; },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(stateMetricsTimer);
      priorityFeeSampler?.stop();
      setOrcaExecutionSnapshotProvider(undefined);
      void orcaLiveState.stop().catch((error: unknown) => {
        log.warn('Execution market-state cache shutdown failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    },
    approveManual,
    rejectManual,
    enqueueCandidate,
    prewarmMints(mints: readonly string[]) {
      const valid = [...new Set(mints)].filter((mint) => {
        try { new PublicKey(mint); return true; } catch { return false; }
      });
      if (valid.length === 0) return;
      void preloadExecutionPreflight(connection, signer.keypair.publicKey, valid).catch((error: unknown) => {
        log.debug('Dynamic execution prewarm failed safely', {
          mintCount: valid.length,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}
import { comparisonBarrier } from './comparison-drain.js';

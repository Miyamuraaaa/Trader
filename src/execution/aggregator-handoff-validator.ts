import { Connection } from '@solana/web3.js';
import { CONFIG, DECIMALS, MINTS } from '../config.js';
import { toAtomic } from '../math.js';
import {
  approveSignedExecutionForSubmission,
  approveTransaction,
  signApprovedExecution,
  type ApprovedSignedExecution,
  type LocallySignedExecution,
} from './approved-transaction.js';
import { buildJupiterRaptorCycle, buildRaptorJupiterCycle } from './aggregator-cycle-builder.js';
import {
  buildJupiterOrcaCycle, buildOrcaJupiterCycle,
  buildRaptorOrcaCycle, buildOrcaRaptorCycle,
} from './mixed-cycle-builder.js';
import {
  aggregatorHandoffIdentity,
  parseAggregatorAtomicHandoff,
  type AggregatorAtomicHandoff,
} from './aggregator-handoff-dto.js';
import { PersistentExecutionJournal, type ExecutionState } from './execution-journal.js';
import {
  assertBlockhashFresh,
  assertFinalHandoffPolicy,
  calculateExecutorEconomics,
  type ExecutorEconomics,
} from './handoff-validator.js';
import { loadDedicatedSigner } from './signer.js';
import {
  fetchExecutionBlockhash, fetchExecutionBlockHeight,
  simulateAtomicTransaction, simulateSignedApprovedTransaction,
} from './simulator.js';
import { inspectAtomicTransaction } from './transaction-inspector.js';
import type { AtomicExecutionPlan, SignerContext, SimulationResult } from './types.js';
import {
  classifyExecutionExpiry,
  classifyExecutionRejection,
  getLatestExecutionStage,
  logExecutionStage,
} from './execution-diagnostics.js';
import { createExecutionConnection } from './execution-connection.js';
import { ExecutionNetworkProfiler } from './network-profiler.js';
import { executionQuoteAgeLimit } from './quote-freshness.js';
import { compareExecutionRouteAlignment } from './execution-route-alignment.js';
import { EXECUTABLE_POLICY_HASH, EXECUTABLE_POLICY_VERSION } from './executable-route-policy.js';

export interface AggregatorHandoffValidationResult {
  candidate: AggregatorAtomicHandoff;
  identity: string;
  status: 'APPROVED_FOR_SUBMISSION' | 'REJECTED';
  reason?: string;
  plan?: AtomicExecutionPlan;
  economics?: ExecutorEconomics;
  unsignedSimulation?: SimulationResult;
  signedSimulation?: SimulationResult;
  signed?: LocallySignedExecution;
  approvedSignedExecution?: ApprovedSignedExecution;
}

function reject(
  base: Pick<AggregatorHandoffValidationResult, 'candidate' | 'identity'>,
  reason: string,
): AggregatorHandoffValidationResult {
  return { ...base, status: 'REJECTED', reason };
}

export async function validateAggregatorHandoffForApproval(
  value: unknown,
  options: {
    connection?: Connection;
    journal?: PersistentExecutionJournal;
    signer?: SignerContext;
    journalAlreadyLoaded?: boolean;
    /** Rebuild exactly this already user-approved route once with fresh state. */
    refreshExistingApproval?: boolean;
  } = {},
): Promise<AggregatorHandoffValidationResult> {
  const candidate = parseAggregatorAtomicHandoff(value);
  const identity = aggregatorHandoffIdentity(candidate);
  const base = { candidate, identity };
  if (candidate.version !== 2 || !candidate.routeEvidence) return reject(base, 'POLICY_VERSION_MISMATCH: legacy handoff is discovery-only; obtain a fresh v2 candidate');
  if (candidate.routeEvidence.policyVersion !== EXECUTABLE_POLICY_VERSION || candidate.routeEvidence.policyHash !== EXECUTABLE_POLICY_HASH) return reject(base, 'POLICY_VERSION_MISMATCH');
  const journal = options.journal ?? new PersistentExecutionJournal();
  // Keep the request-level trace even when a route fails. A positive
  // candidate that expires is actionable only when we can distinguish a slow
  // provider build from a slow execution RPC or a local construction issue.
  let profiler: ExecutionNetworkProfiler | undefined;
  const transition = (state: ExecutionState, update?: Parameters<PersistentExecutionJournal['transition']>[2]) =>
    journal.transition(identity, state, update, {
      // DETECTED and terminal/final approval records are durable. Intermediate
      // pre-submission telemetry can stay in-memory in LIVE mode: a crash
      // safely recovers the persisted DETECTED record as rejected, while
      // avoiding a Windows filesystem write for every hot-path stage.
      persist: CONFIG.executionMode !== 'live'
        || ['APPROVED_FOR_SUBMISSION', 'REJECTED', 'EXPIRED', 'SIMULATION_FAILED'].includes(state),
    });
  logExecutionStage(identity, 'HANDOFF', candidate.detectedAt, { providers: candidate.providers });
  if (!options.journalAlreadyLoaded) await journal.load();
  const existing = journal.get(identity);
  const refreshing = options.refreshExistingApproval === true;
  if (refreshing) {
    if (!existing || existing.state !== 'APPROVED_BY_USER') {
      return reject(base, 'Manual refresh requires the same route to be awaiting approved-user execution');
    }
  } else {
    if (existing) return reject(base, 'Duplicate candidate identity is already journaled');
    if (journal.unresolved().length > 0) return reject(base, 'Unresolved execution journal record requires reconciliation');
    await journal.begin(identity);
  }
  try {
    if (candidate.inputMint !== MINTS.USDC || candidate.intermediateMint === MINTS.USDC
      || candidate.outputMint !== MINTS.USDC) {
      throw new Error('Aggregator executor requires a complete USDC -> intermediate -> USDC cycle');
    }
    const inputAmount = BigInt(candidate.proposedInputAmount);
    const cap = BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC));
    if (inputAmount > cap) throw new Error('Candidate exceeds FIRST_LIVE_MAX_INPUT_USDC');
    const signer = options.signer ?? await loadDedicatedSigner('dry-run');
    if (!signer) throw new Error('Dedicated signer is unavailable');
    const connection = options.connection ?? createExecutionConnection();
    profiler = new ExecutionNetworkProfiler({ identity, candidateDetectedAt: candidate.detectedAt });
    if (refreshing) {
      await transition('REVALIDATING');
    } else {
      await transition('HANDOFF_RECEIVED', {
        wallet: signer.publicKey,
        baseMint: MINTS.USDC,
        intermediateMint: candidate.intermediateMint,
        inputAmount: inputAmount.toString(),
      });
      await transition('REVALIDATING');
    }
    logExecutionStage(identity, 'EXECUTOR_VALIDATING', candidate.detectedAt, {
      intermediateMint: candidate.intermediateMint, inputAtomic: inputAmount.toString(),
    });
    const cycleBuilders: Record<string, typeof buildRaptorJupiterCycle | undefined> = {
      'raptor:jupiter': buildRaptorJupiterCycle,
      'jupiter:raptor': buildJupiterRaptorCycle,
      'jupiter:orca': buildJupiterOrcaCycle,
      'orca:jupiter': buildOrcaJupiterCycle,
      'raptor:orca': buildRaptorOrcaCycle,
      'orca:raptor': buildOrcaRaptorCycle,
    };
    const buildCycle = cycleBuilders[candidate.providers.join(':')];
    if (!buildCycle) throw new Error(`No executor for provider combination: ${candidate.providers.join(' -> ')}`);

    // Single-pass: build once with generous compute budget, inspect, simulate,
    // sign, and approve. No probe/re-build loop that wastes quote freshness.
    // The builder performs the fresh independent route quote as its first
    // operation. Record entry into that exact-quote/build phase before the
    // state advances to BUILDING; skipping QUOTED made every valid aggregator
    // handoff fail closed on an illegal journal transition.
    logExecutionStage(identity, 'QUOTE_START', candidate.detectedAt, {
      freshnessSource: 'NEW_EXECUTOR_SIDE_QUOTE_OR_POOL_STATE',
      scannerObservationAt: candidate.scannerObservation.quoteTimestamp,
    });
    await transition('QUOTED');
    await transition('BUILDING');
    logExecutionStage(identity, 'BUILD_START', candidate.detectedAt);
    const blockhashPromise = fetchExecutionBlockhash(connection, profiler).then(
      (value) => ({ value } as const), (error: unknown) => ({ error } as const),
    );
    const plan = await buildCycle({
      connection, wallet: signer.keypair.publicKey, inputAmount,
      slippageBps: CONFIG.slippageBps, computeUnitLimit: 500_000,
      intermediateMint: candidate.intermediateMint,
      profiler,
      orcaPoolHints: candidate.providers[0] === 'orca'
        ? candidate.scannerPools[0]
        : candidate.providers[1] === 'orca' ? candidate.scannerPools[1] : undefined,
    });
    const routeAlignment = compareExecutionRouteAlignment(candidate, plan);
    logExecutionStage(identity, 'BUILD_END', candidate.detectedAt, {
      freshnessEvidenceAt: plan.quoteReceivedAt,
      freshnessEvidenceAtIso: new Date(plan.quoteReceivedAt).toISOString(),
      quoteAgeMs: Date.now() - plan.quoteReceivedAt, type: plan.type,
      freshnessLimitMs: executionQuoteAgeLimit(plan),
      networkRequests: profiler.timings,
      routeAlignment: routeAlignment.code,
      scannerPools: routeAlignment.scannerPools,
      executorPools: routeAlignment.executorPools,
    });
    if (!routeAlignment.passed) {
      throw new Error(`${routeAlignment.code}: ${routeAlignment.reason}`);
    }
    await transition('INSPECTING');
    const inspection = inspectAtomicTransaction(plan);
    if (!inspection.passed) throw new Error(`Aggregator inspection failed: ${inspection.reasons.join('; ')}`);
    logExecutionStage(identity, 'INSPECTION_PASS', candidate.detectedAt, {
      instructions: inspection.instructionCount,
    });
    await transition('SIMULATING');
    logExecutionStage(identity, 'SIMULATION_START', candidate.detectedAt, {
      freshnessEvidenceAt: plan.quoteReceivedAt,
      quoteAgeMs: Date.now() - plan.quoteReceivedAt,
      freshnessLimitMs: executionQuoteAgeLimit(plan),
    });
    const preparedResult = await blockhashPromise;
    if ('error' in preparedResult) throw preparedResult.error;
    const finalBlockHeightPromise = fetchExecutionBlockHeight(connection, profiler).then(
      (value) => ({ value } as const), (error: unknown) => ({ error } as const),
    );
    const unsignedSimulation = await simulateAtomicTransaction(connection, plan, signer, {
      quoteReceivedAt: plan.quoteReceivedAt,
      maxAgeMs: executionQuoteAgeLimit(plan),
    }, profiler, preparedResult.value);
    logExecutionStage(identity, 'SIMULATION_END', candidate.detectedAt, {
      simulationRequestAt: unsignedSimulation.timing.simulationRequestAt,
      simulationResponseAt: unsignedSimulation.timing.simulationResponseAt,
      simulationRpcMs: unsignedSimulation.timing.simulationRpcMs,
      quoteAgeAtSimulationResponseMs: unsignedSimulation.timing.simulationResponseAt - plan.quoteReceivedAt,
      freshnessEvidenceAt: plan.quoteReceivedAt,
      freshnessLimitMs: executionQuoteAgeLimit(plan),
    });
    if (!unsignedSimulation.passed) throw new Error(`Aggregator unsigned simulation failed: ${JSON.stringify(unsignedSimulation.error)}`);
    logExecutionStage(identity, 'SIMULATION_PASS', candidate.detectedAt, {
      unitsConsumed: unsignedSimulation.unitsConsumed,
      executorToSimulationMs: unsignedSimulation.timing.simulationResponseAt - plan.quoteReceivedAt,
    });
    const economics = calculateExecutorEconomics(plan, unsignedSimulation);
    logExecutionStage(identity, 'FINAL_CHECK', candidate.detectedAt, {
      freshnessEvidenceAt: plan.quoteReceivedAt,
      quoteAgeMs: Date.now() - plan.quoteReceivedAt,
      freshnessLimitMs: executionQuoteAgeLimit(plan),
      inputAtomic: plan.inputAmount.toString(),
      expectedIntermediateAtomic: plan.expectedIntermediateAmount.toString(),
      expectedFinalAtomic: plan.expectedOutputAmount.toString(),
      enforceableMinimumFinalAtomic: plan.minimumOutputAmount.toString(),
      estimatedNetworkCostAtomic: economics.networkCostUsdcAtomic.toString(),
      expectedNetAtomic: economics.expectedNetAtomic.toString(),
      conservativeNetAtomic: economics.conservativeNetAtomic.toString(),
      expectedRoiBps: economics.expectedRoiBps.toString(),
      conservativeRoiBps: economics.conservativeRoiBps.toString(),
      scannerExpectedNetAtomic: candidate.scannerObservation.projectedNetAmount,
      scannerMinimumFinalAtomic: candidate.scannerObservation.minimumOutputAmount,
    });
    assertFinalHandoffPolicy(plan, unsignedSimulation, economics);
    logExecutionStage(identity, 'FINAL_PROFITABILITY_PASS', candidate.detectedAt, {
      conservativeNetAtomic: economics.conservativeNetAtomic.toString(),
      conservativeRoiBps: economics.conservativeRoiBps.toString(),
    });
    await transition('APPROVED');
    const approved = approveTransaction('validated-opportunity', plan, unsignedSimulation.transaction);
    await transition('SIGNING', { messageHash: approved.messageHash });
    const signed = signApprovedExecution(approved, signer);
    logExecutionStage(identity, 'LOCAL_SIGNING_COMPLETE', candidate.detectedAt);
    await transition('SIGNED');
    let signedSimulation: SimulationResult | undefined;
    if (CONFIG.executionMode !== 'live') {
      signedSimulation = await simulateSignedApprovedTransaction(connection, signed, profiler);
      if (!signedSimulation.passed) throw new Error(`Aggregator signed simulation failed: ${JSON.stringify(signedSimulation.error)}`);
      await transition('SIGNED_SIMULATION');
    }
    const marketEvidenceAt = signedSimulation?.timing.simulationResponseAt
      ?? unsignedSimulation.timing.simulationResponseAt;
    const marketEvidenceAgeMs = Math.max(0, Date.now() - marketEvidenceAt);
    const finalQuoteLimitMs = executionQuoteAgeLimit(plan);
    if (marketEvidenceAgeMs > finalQuoteLimitMs) {
      throw new Error(`Aggregator on-chain simulation evidence is stale: age=${marketEvidenceAgeMs}ms limit=${finalQuoteLimitMs}ms`);
    }
    const finalBlockHeightResult = await finalBlockHeightPromise;
    if ('error' in finalBlockHeightResult) throw finalBlockHeightResult.error;
    await assertBlockhashFresh(connection, unsignedSimulation, profiler, finalBlockHeightResult.value);
    const approvedSignedExecution = approveSignedExecutionForSubmission(
      identity, signed, unsignedSimulation, signedSimulation,
    );
    await transition('APPROVED_FOR_SUBMISSION', { messageHash: approved.messageHash });
    logExecutionStage(identity, 'READY_TO_EXECUTE', candidate.detectedAt, {
      candidateToExecutorMs: Math.max(0, plan.quoteReceivedAt - candidate.detectedAt),
      executorToSimulationMs: unsignedSimulation.timing.simulationResponseAt - plan.quoteReceivedAt,
      simulationToReadyMs: Date.now() - unsignedSimulation.timing.simulationResponseAt,
      totalCandidateToReadyMs: Date.now() - candidate.detectedAt,
      networkRequests: profiler.timings,
    });
    return {
      ...base, status: 'APPROVED_FOR_SUBMISSION', plan, economics,
      unsignedSimulation, signedSimulation, signed, approvedSignedExecution,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const expired = /stale|expiry|expired|quote age/i.test(reason);
    const lastStage = getLatestExecutionStage(identity);
    const category = expired
      ? classifyExecutionExpiry(reason, lastStage?.stage, profiler?.timings ?? [])
      : classifyExecutionRejection(reason);
    logExecutionStage(identity, 'REJECTED', candidate.detectedAt, {
      category, reason,
      candidateAgeMs: Math.max(0, Date.now() - candidate.detectedAt),
      networkRequests: profiler?.timings ?? [],
    });
    const record = journal.get(identity);
    if (record && !['REJECTED', 'EXPIRED', 'SIMULATION_FAILED'].includes(record.state)) {
      const terminal = expired ? 'EXPIRED'
        : /simulation/i.test(reason) ? 'SIMULATION_FAILED' : 'REJECTED';
      await transition(terminal, { reason });
    }
    return reject(base, reason);
  }
}

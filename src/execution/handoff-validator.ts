import { Connection, PublicKey } from '@solana/web3.js';
import { observeExecutorEconomics } from '../economics/executor-breakdown.js';
import { CONFIG, DECIMALS, MINTS } from '../config.js';
import { toAtomic } from '../math.js';
import {
  approveSignedExecutionForSubmission,
  approveTransaction,
  signApprovedExecution,
  type ApprovedSignedExecution,
  type LocallySignedExecution,
} from './approved-transaction.js';
import { type OrcaAtomicHandoff, handoffIdentity, parseOrcaAtomicHandoff } from './handoff-dto.js';
import { PersistentExecutionJournal, type ExecutionState } from './execution-journal.js';
import { validateFinalEconomics } from './final-validation.js';
import { buildOrcaTwoHopCycle, prepareOrcaTwoHopCycle } from './orca-two-hop-builder.js';
import { inspectAtomicTransaction } from './transaction-inspector.js';
import { loadDedicatedSigner } from './signer.js';
import {
  fetchExecutionBlockhash,
  fetchExecutionBlockHeight,
  simulateAtomicTransaction,
  simulateSignedApprovedTransaction,
} from './simulator.js';
import type { AtomicExecutionPlan, SignerContext, SimulationResult } from './types.js';
import { classifyExecutionRejection, logExecutionStage } from './execution-diagnostics.js';
import { createExecutionConnection } from './execution-connection.js';
import { ExecutionNetworkProfiler } from './network-profiler.js';
import { executionQuoteAgeLimit, quoteAgeMs } from './quote-freshness.js';

export interface ExecutorEconomics {
  expectedNetAtomic: bigint;
  conservativeNetAtomic: bigint;
  expectedRoiBps: bigint;
  conservativeRoiBps: bigint;
  totalNetworkCostLamports: bigint;
  networkCostUsdcAtomic: bigint;
  baseFeeLamports: bigint;
  priorityFeeLamports: bigint;
  ataRentLamports: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
}

export interface HandoffValidationResult {
  candidate: OrcaAtomicHandoff;
  identity: string;
  status: 'APPROVED_FOR_SUBMISSION' | 'REJECTED';
  reason?: string;
  candidateAgeAtHandoffMs: number;
  plan?: AtomicExecutionPlan;
  unsignedSimulation?: SimulationResult;
  signed?: LocallySignedExecution;
  signedSimulation?: SimulationResult;
  approvedSignedExecution?: ApprovedSignedExecution;
  economics?: ExecutorEconomics;
  finalApprovalAt?: number;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function deriveComputeLimit(units: number | undefined): number {
  if (!units || units <= 0) throw new Error('Probe did not report compute usage');
  const limit = Math.ceil(units * 1.15) + 5_000;
  if (limit > 1_400_000) throw new Error('Measured compute exceeds executor ceiling');
  return limit;
}

/**
 * Costs are kept in USDC atomic units. DEX/transfer fees are already reflected
 * in the exact quote outputs; this adds only the actual message fee estimate.
 * The SOL-to-USDC conversion uses the executor's fresh first-hop WSOL quote.
 */
export function calculateExecutorEconomics(plan: AtomicExecutionPlan, simulation: SimulationResult): ExecutorEconomics {
  if (plan.expectedIntermediateAmount <= 0n) throw new Error('Executor plan has no intermediate output');
  const computeUnitLimit = plan.computeUnitLimit ?? 0;
  const price = plan.computeUnitPriceMicroLamports ?? CONFIG.fallbackPriorityFeeMicroLamports;
  const priorityFeeLamports = ceilDivide(BigInt(computeUnitLimit) * BigInt(price), 1_000_000n);
  const transactionFeeLamports = BigInt(simulation.estimatedBaseFeeLamports);
  const ataRentLamports = BigInt(
    (plan.baseAta.exists ? 0 : plan.baseAta.creationRentLamports)
    + (plan.intermediateAta.exists || plan.aggregatorEvidence?.closesIntermediateAta
      ? 0 : plan.intermediateAta.creationRentLamports),
  );
  const totalNetworkCostLamports = transactionFeeLamports + ataRentLamports;
  const baseFeeLamports = transactionFeeLamports > priorityFeeLamports
    ? transactionFeeLamports - priorityFeeLamports : 0n;
  // A WSOL route provides a fresh implied SOL/USDC conversion. For another
  // intermediate, use an explicit conservative ceiling rather than trusting
  // scanner-supplied pricing for SOL-denominated transaction costs.
  const networkCostUsdcAtomic = plan.intermediateMint === MINTS.SOL
    ? ceilDivide(totalNetworkCostLamports * plan.inputAmount, plan.expectedIntermediateAmount)
    : ceilDivide(
      totalNetworkCostLamports * BigInt(toAtomic(CONFIG.executionSolPriceCeilingUsdc, DECIMALS.USDC)),
      1_000_000_000n,
    );
  const expectedNetAtomic = plan.expectedOutputAmount - plan.inputAmount - networkCostUsdcAtomic;
  const conservativeNetAtomic = plan.minimumOutputAmount - plan.inputAmount - networkCostUsdcAtomic;
  return {
    expectedNetAtomic,
    conservativeNetAtomic,
    expectedRoiBps: expectedNetAtomic * 10_000n / plan.inputAmount,
    conservativeRoiBps: conservativeNetAtomic * 10_000n / plan.inputAmount,
    totalNetworkCostLamports,
    networkCostUsdcAtomic,
    baseFeeLamports,
    priorityFeeLamports,
    ataRentLamports,
    computeUnitLimit,
    computeUnitPriceMicroLamports: price,
  };
}

export function assertFinalHandoffPolicy(plan: AtomicExecutionPlan, simulation: SimulationResult, economics: ExecutorEconomics): void {
  const policy = validateFinalEconomics(plan, {
    now: Date.now(), maxQuoteAgeMs: executionQuoteAgeLimit(plan),
    estimatedCostsAtomic: economics.networkCostUsdcAtomic,
    minimumNetProfitAtomic: BigInt(toAtomic(CONFIG.minNetProfitUsdc, DECIMALS.USDC)),
    minimumProfitBps: BigInt(CONFIG.minProfitBps),
  });
  if (!policy.passed) throw new Error(`Final economics rejected: ${policy.reasons.join('; ')}`);
  
  if (economics.expectedNetAtomic < 0n) {
    throw new Error('Expected net profit is negative; aborted per user instruction');
  }

  // Approval is controlled by enforceable minimum-output economics, not the
  // optimistic quote. Slippage is applied only once by the Orca quote threshold.
  if (economics.conservativeNetAtomic < BigInt(toAtomic(CONFIG.minNetProfitUsdc, DECIMALS.USDC))) {
    throw new Error('Conservative minimum-output net is below threshold');
  }
  if (economics.conservativeRoiBps < BigInt(CONFIG.minProfitBps)) {
    throw new Error('Conservative minimum-output ROI is below threshold');
  }
  if (!simulation.lastValidBlockHeight) throw new Error('Simulation did not provide blockhash validity metadata');
}

export function assertHandoffScope(candidate: OrcaAtomicHandoff): bigint {
  if (candidate.venue !== 'orca' || candidate.opportunityType !== 'ORCA_TWO_HOP_ATOMIC') throw new Error('Only Orca atomic handoffs are eligible');
  if (candidate.inputMint !== MINTS.USDC || candidate.outputMint !== MINTS.USDC
    || candidate.intermediateMint === MINTS.USDC) {
    throw new Error('Executor requires a complete USDC -> intermediate -> USDC cycle');
  }
  if (candidate.intermediateMint !== MINTS.SOL && candidate.intermediateMint !== MINTS.USDT
    && !CONFIG.allowDynamicTokenExecution) {
    throw new Error('Dynamic-token execution is disabled');
  }
  const inputAmount = BigInt(candidate.proposedInputAmount);
  const cap = BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC));
  if (inputAmount > cap) {
    throw new Error('Candidate exceeds FIRST_LIVE_MAX_INPUT_USDC');
  }
  return inputAmount;
}

export async function assertBlockhashFresh(
  connection: Connection,
  simulation: SimulationResult,
  profiler?: ExecutionNetworkProfiler,
  preparedCurrentHeight?: number,
): Promise<void> {
  if (Date.now() - simulation.timing.blockhashRetrievedAt > CONFIG.maxApprovedBlockhashAgeMs) {
    throw new Error('Approved blockhash age exceeded safety limit; rebuild required');
  }
  const loadHeight = () => connection.getBlockHeight('confirmed');
  const currentHeight = preparedCurrentHeight ?? (profiler
    ? await profiler.measure('rpc.getBlockHeight', 'rpc', loadHeight)
    : await loadHeight());
  if (!simulation.lastValidBlockHeight || simulation.lastValidBlockHeight - currentHeight < 20) {
    throw new Error('Blockhash is too close to expiry; rebuild required');
  }
}

export async function assertPoolStateFresh(connection: Connection, plan: AtomicExecutionPlan): Promise<void> {
  const slot = plan.executionTiming?.newestPoolStateSlot;
  if (slot === undefined) throw new Error('Fresh execution plan has no pool-state slot evidence');
  const current = await connection.getSlot('confirmed');
  if (current < slot || current - slot > CONFIG.maxSlotDifference) {
    throw new Error(`Pool state slot is stale (${slot}; current ${current})`);
  }
}

function reject(result: Omit<HandoffValidationResult, 'status'>, reason: string): HandoffValidationResult {
  return { ...result, status: 'REJECTED', reason };
}

/**
 * The executor treats the handoff as external input: it does not reuse scanner
 * output/profit/ROI/slot data for authorization and never accepts transaction data.
 * It stops at APPROVED_FOR_SUBMISSION; no broadcaster is linked to this module.
 */
export async function validateOrcaHandoffForApproval(
  input: unknown,
  options: {
    connection?: Connection;
    journal?: PersistentExecutionJournal;
    signer?: SignerContext;
    journalAlreadyLoaded?: boolean;
    /** Rebuild exactly this already user-approved route once with fresh state. */
    refreshExistingApproval?: boolean;
  } = {},
): Promise<HandoffValidationResult> {
  const candidate = parseOrcaAtomicHandoff(input);
  const identity = handoffIdentity(candidate);
  const candidateAgeAtHandoffMs = Date.now() - candidate.detectedAt;
  const base = { candidate, identity, candidateAgeAtHandoffMs };
  const journal = options.journal ?? new PersistentExecutionJournal();
  let profiler: ExecutionNetworkProfiler | undefined;
  const transition = (state: ExecutionState, update?: Parameters<PersistentExecutionJournal['transition']>[2]) =>
    journal.transition(identity, state, update, {
      persist: CONFIG.executionMode !== 'live'
        || ['APPROVED_FOR_SUBMISSION', 'REJECTED', 'EXPIRED', 'SIMULATION_FAILED'].includes(state),
    });
  logExecutionStage(identity, 'HANDOFF', candidate.detectedAt, { providers: ['orca', 'orca'] });
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
    if (!refreshing) {
      await transition('HANDOFF_RECEIVED', {
        baseMint: candidate.inputMint,
        intermediateMint: candidate.intermediateMint,
        inputAmount: candidate.proposedInputAmount,
      });
    }
    const inputAmount = assertHandoffScope(candidate);
    const signer = options.signer ?? await loadDedicatedSigner('dry-run');
    if (!signer) throw new Error('Dedicated signer is unavailable');
    const connection = options.connection ?? createExecutionConnection();
    profiler = new ExecutionNetworkProfiler();
    await transition('REVALIDATING');
    logExecutionStage(identity, 'EXECUTOR_VALIDATING', candidate.detectedAt, {
      intermediateMint: candidate.intermediateMint,
    });
    const prepared = await prepareOrcaTwoHopCycle({
      connection, wallet: signer.keypair.publicKey, baseMint: candidate.inputMint,
      intermediateMint: candidate.intermediateMint, inputAmount, purpose: 'validated-opportunity',
      poolAddresses: candidate.pools, profiler,
    });
    await transition('QUOTED');
    let computeUnitLimit = 90_000;
    if (CONFIG.executionMode !== 'live') {
      await transition('BUILDING');
      const probePlan = await buildOrcaTwoHopCycle({
        ...prepared.input, slippageBps: CONFIG.slippageBps, prepared, poolAddresses: candidate.pools, freshPoolState: true,
      });
      await transition('INSPECTING');
      const probeInspection = inspectAtomicTransaction(probePlan);
      if (!probeInspection.passed) throw new Error(`Probe inspection failed: ${probeInspection.reasons.join('; ')}`);
      await transition('SIMULATING');
      const probe = await simulateAtomicTransaction(connection, probePlan, signer, {
        quoteReceivedAt: probePlan.quoteReceivedAt, maxAgeMs: executionQuoteAgeLimit(probePlan),
      }, profiler);
      if (!probe.passed) throw new Error(`Unsigned probe simulation failed: ${JSON.stringify(probe.error)}`);
      computeUnitLimit = deriveComputeLimit(probe.unitsConsumed);
      await transition('FINAL_REVALIDATION');
    }
    // In live mode 90k CU is the reviewed ceiling derived from the funded
    // mainnet measurement (~59k CU). The one execution-critical simulation
    // below proves the final exact message without a duplicate RPC round trip.
    await transition('BUILDING');
    const blockhashPromise = fetchExecutionBlockhash(connection, profiler);
    const finalPlan = await buildOrcaTwoHopCycle({
      ...prepared.input, slippageBps: CONFIG.slippageBps, prepared, poolAddresses: candidate.pools,
      computeUnitLimit, freshPoolState: true,
    });
    logExecutionStage(identity, 'BUILT', candidate.detectedAt, { type: finalPlan.type });
    await transition('INSPECTING');
    const finalInspection = inspectAtomicTransaction(finalPlan);
    if (!finalInspection.passed) throw new Error(`Final inspection failed: ${finalInspection.reasons.join('; ')}`);
    logExecutionStage(identity, 'INSPECTION_PASS', candidate.detectedAt, {
      instructions: finalInspection.instructionCount,
    });
    await transition('SIMULATING');
    const finalBlockHeightPromise = fetchExecutionBlockHeight(connection, profiler);
    const unsignedSimulation = await simulateAtomicTransaction(connection, finalPlan, signer, {
      quoteReceivedAt: finalPlan.quoteReceivedAt, maxAgeMs: executionQuoteAgeLimit(finalPlan),
    }, profiler, await blockhashPromise);
    if (!unsignedSimulation.passed) throw new Error(`Final unsigned simulation failed: ${JSON.stringify(unsignedSimulation.error)}`);
    logExecutionStage(identity, 'SIMULATION_PASS', candidate.detectedAt, {
      unitsConsumed: unsignedSimulation.unitsConsumed,
    });
    const economics = calculateExecutorEconomics(finalPlan, unsignedSimulation);
    observeExecutorEconomics(finalPlan, economics, identity, candidate.detectedAt);
    await transition('FINAL_REVALIDATION');
    assertFinalHandoffPolicy(finalPlan, unsignedSimulation, economics);
    logExecutionStage(identity, 'FINAL_PROFITABILITY_PASS', candidate.detectedAt, {
      conservativeNetAtomic: economics.conservativeNetAtomic.toString(),
      conservativeRoiBps: economics.conservativeRoiBps.toString(),
    });
    await transition('APPROVED');
    const approved = approveTransaction('validated-opportunity', finalPlan, unsignedSimulation.transaction);
    await transition('SIGNING', { messageHash: approved.messageHash });
    const signed = signApprovedExecution(approved, signer);
    logExecutionStage(identity, 'LOCAL_SIGNING_COMPLETE', candidate.detectedAt);
    await transition('SIGNED');
    let signedSimulation: SimulationResult | undefined;
    if (CONFIG.executionMode !== 'live') {
      signedSimulation = await simulateSignedApprovedTransaction(connection, signed);
      if (!signedSimulation.passed) throw new Error(`Signed simulation failed: ${JSON.stringify(signedSimulation.error)}`);
      await transition('SIGNED_SIMULATION');
    }
    const signedQuoteAgeMs = quoteAgeMs(finalPlan);
    const finalQuoteLimitMs = executionQuoteAgeLimit(finalPlan);
    if (signedQuoteAgeMs > finalQuoteLimitMs) {
      throw new Error(`Signed simulation completed after the execution quote expired: age=${signedQuoteAgeMs}ms limit=${finalQuoteLimitMs}ms`);
    }
    await assertBlockhashFresh(connection, unsignedSimulation, undefined, await finalBlockHeightPromise);
    const approvalQuoteAgeMs = quoteAgeMs(finalPlan);
    if (approvalQuoteAgeMs > finalQuoteLimitMs) {
      throw new Error(`Execution quote expired during final blockhash/slot validation: age=${approvalQuoteAgeMs}ms limit=${finalQuoteLimitMs}ms`);
    }
    const approvedSignedExecution = approveSignedExecutionForSubmission(
      identity,
      signed,
      unsignedSimulation,
      signedSimulation,
    );
    const finalApprovalAt = Date.now();
    await transition('APPROVED_FOR_SUBMISSION', { messageHash: approved.messageHash });
    logExecutionStage(identity, 'READY_TO_EXECUTE', candidate.detectedAt, {
      candidateToExecutorMs: Math.max(0, finalPlan.quoteReceivedAt - candidate.detectedAt),
      executorToSimulationMs: unsignedSimulation.timing.simulationResponseAt - finalPlan.quoteReceivedAt,
      simulationToReadyMs: finalApprovalAt - unsignedSimulation.timing.simulationResponseAt,
      totalCandidateToReadyMs: finalApprovalAt - candidate.detectedAt,
      networkRequests: profiler.timings,
    });
    return {
      ...base,
      status: 'APPROVED_FOR_SUBMISSION',
      plan: finalPlan,
      unsignedSimulation,
      signed,
      signedSimulation,
      approvedSignedExecution,
      economics,
      finalApprovalAt,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logExecutionStage(identity, 'REJECTED', candidate.detectedAt, {
      category: classifyExecutionRejection(reason), reason,
      candidateAgeMs: Math.max(0, Date.now() - candidate.detectedAt),
      networkRequests: profiler?.timings ?? [],
    });
    const record = journal.get(identity);
    if (record && !['REJECTED', 'EXPIRED', 'SIMULATION_FAILED'].includes(record.state)) {
      const terminal = /stale|expiry|age/i.test(reason) ? 'EXPIRED' : /simulation/i.test(reason) ? 'SIMULATION_FAILED' : 'REJECTED';
      await transition(terminal, { reason });
    }
    return reject(base, reason);
  }
}

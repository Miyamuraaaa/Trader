import type { AggregatorAtomicHandoff } from './aggregator-handoff-dto.js';
import type { AtomicExecutionPlan, ValidatedExecutionLegEvidence } from './types.js';

export type ExecutionRouteAlignmentCode =
  | 'ALIGNED'
  | 'MISSING_EXECUTOR_ROUTE_EVIDENCE'
  | 'PROVIDER_ORDER_MISMATCH'
  | 'SCANNER_POOL_EVIDENCE_MISSING'
  | 'SCANNER_POOL_EVIDENCE_AMBIGUOUS'
  | 'EXECUTION_ROUTE_CHANGED'
  | 'MINT_PATH_MISMATCH'
  | 'AMOUNT_CHAIN_MISMATCH';

export interface ExecutionRouteAlignmentResult {
  passed: boolean;
  code: ExecutionRouteAlignmentCode;
  reason?: string;
  scannerPools: [string[], string[]];
  executorPools: [string, string] | null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function fail(
  code: Exclude<ExecutionRouteAlignmentCode, 'ALIGNED'>,
  reason: string,
  scannerPools: [string[], string[]],
  executorPools: [string, string] | null,
): ExecutionRouteAlignmentResult {
  return { passed: false, code, reason, scannerPools, executorPools };
}

function expectedLegMints(candidate: AggregatorAtomicHandoff, index: 0 | 1): [string, string] {
  return index === 0
    ? [candidate.inputMint, candidate.intermediateMint]
    : [candidate.intermediateMint, candidate.outputMint];
}

function validateLeg(
  candidate: AggregatorAtomicHandoff,
  leg: ValidatedExecutionLegEvidence,
  index: 0 | 1,
  scannerPools: [string[], string[]],
  executorPools: [string, string],
): ExecutionRouteAlignmentResult | undefined {
  const expectedProvider = candidate.providers[index];
  if (leg.provider !== expectedProvider) {
    return fail(
      'PROVIDER_ORDER_MISMATCH',
      `Executor leg ${index + 1} provider changed from ${expectedProvider} to ${leg.provider}`,
      scannerPools,
      executorPools,
    );
  }

  const [expectedInputMint, expectedOutputMint] = expectedLegMints(candidate, index);
  if (leg.inputMint !== expectedInputMint || leg.outputMint !== expectedOutputMint) {
    return fail(
      'MINT_PATH_MISMATCH',
      `Executor leg ${index + 1} mint path changed from ${expectedInputMint}->${expectedOutputMint} to ${leg.inputMint}->${leg.outputMint}`,
      scannerPools,
      executorPools,
    );
  }

  const pools = scannerPools[index];
  if (pools.length === 0) {
    return fail(
      'SCANNER_POOL_EVIDENCE_MISSING',
      `Executable scanner candidate has no pool evidence for leg ${index + 1}`,
      scannerPools,
      executorPools,
    );
  }
  if (pools.length !== 1) {
    return fail(
      'SCANNER_POOL_EVIDENCE_AMBIGUOUS',
      `Executable scanner candidate has ${pools.length} pools for leg ${index + 1}; exact liquidity identity is ambiguous`,
      scannerPools,
      executorPools,
    );
  }
  if (leg.pool !== pools[0]) {
    return fail(
      'EXECUTION_ROUTE_CHANGED',
      `Executor leg ${index + 1} rebuilt on pool ${leg.pool}, but scanner executable evidence used ${pools[0]}`,
      scannerPools,
      executorPools,
    );
  }

  return undefined;
}

/**
 * Ensures an executor refresh is still the same economic route that earned the
 * scanner-side EXECUTABLE_CANDIDATE label. Fresh amounts may change, but the
 * provider order, mint path and underlying pool identity may not silently
 * switch to different liquidity.
 *
 * This is not execution authorization by itself. The normal token policy,
 * inspection, simulation and conservative economics checks still run after it.
 */
export function compareExecutionRouteAlignment(
  candidate: AggregatorAtomicHandoff,
  plan: AtomicExecutionPlan,
): ExecutionRouteAlignmentResult {
  const scannerPools: [string[], string[]] = [
    unique(candidate.scannerPools[0]),
    unique(candidate.scannerPools[1]),
  ];
  const evidence = plan.aggregatorEvidence;
  if (!evidence) {
    return fail(
      'MISSING_EXECUTOR_ROUTE_EVIDENCE',
      'Executor-built plan is missing independently validated route evidence',
      scannerPools,
      null,
    );
  }

  const executorPools: [string, string] = [evidence.legs[0].pool, evidence.legs[1].pool];
  if (evidence.providers[0] !== candidate.providers[0]
    || evidence.providers[1] !== candidate.providers[1]) {
    return fail(
      'PROVIDER_ORDER_MISMATCH',
      `Executor provider order ${evidence.providers.join('->')} differs from scanner executable candidate ${candidate.providers.join('->')}`,
      scannerPools,
      executorPools,
    );
  }

  const firstLegFailure = validateLeg(candidate, evidence.legs[0], 0, scannerPools, executorPools);
  if (firstLegFailure) return firstLegFailure;
  const secondLegFailure = validateLeg(candidate, evidence.legs[1], 1, scannerPools, executorPools);
  if (secondLegFailure) return secondLegFailure;

  if (plan.inputAmount !== BigInt(candidate.proposedInputAmount)
    || evidence.legs[0].inputAmount !== plan.inputAmount
    || evidence.legs[1].inputAmount !== evidence.legs[0].minimumOutputAmount) {
    return fail(
      'AMOUNT_CHAIN_MISMATCH',
      'Executor amount chain no longer matches the deterministic exact-input/minimum-output cycle',
      scannerPools,
      executorPools,
    );
  }

  return { passed: true, code: 'ALIGNED', scannerPools, executorPools };
}

export function assertExecutionRouteAlignment(
  candidate: AggregatorAtomicHandoff,
  plan: AtomicExecutionPlan,
): void {
  const result = compareExecutionRouteAlignment(candidate, plan);
  if (!result.passed) {
    throw new Error(`${result.code}: ${result.reason}`);
  }
}

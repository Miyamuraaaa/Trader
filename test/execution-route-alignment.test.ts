import { describe, expect, it } from 'vitest';
import type { AggregatorAtomicHandoff } from '../src/execution/aggregator-handoff-dto.js';
import {
  compareExecutionRouteAlignment,
} from '../src/execution/execution-route-alignment.js';
import type { AtomicExecutionPlan } from '../src/execution/types.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const POOL_A = 'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q';
const POOL_B = '4HppGTweoGQ8ZZ6UcCgwJKfi5mJD9Dqwy6htCpnbfBLW';
const POOL_C = '7qbRF6YsyGuLUVs6Y1yV3raQzPq3Kj9WV7L8xJPfqL5T';

function candidate(overrides: Partial<AggregatorAtomicHandoff> = {}): AggregatorAtomicHandoff {
  return {
    schema: 'sol-arb.aggregator-execution-handoff',
    version: 1,
    opportunityId: 'route-alignment-test',
    detectedAt: 1,
    opportunityType: 'RAPTOR_JUPITER_ATOMIC',
    providers: ['raptor', 'jupiter'],
    inputMint: USDC,
    intermediateMint: WSOL,
    outputMint: USDC,
    proposedInputAmount: '50000',
    scannerPools: [[POOL_A], [POOL_B]],
    scannerObservation: {
      expectedOutputAmount: '50100',
      minimumOutputAmount: '50050',
      projectedNetAmount: '50',
      roiBps: '10',
      quoteTimestamp: 1,
    },
    ...overrides,
  };
}

function plan(overrides: Partial<AtomicExecutionPlan> = {}): AtomicExecutionPlan {
  return {
    inputMint: USDC,
    intermediateMint: WSOL,
    outputMint: USDC,
    inputAmount: 50000n,
    aggregatorEvidence: {
      providers: ['raptor', 'jupiter'],
      routeProgramIds: [],
      sourceInstructionHashes: [],
      closesIntermediateAta: false,
      legs: [{
        provider: 'raptor',
        programId: 'raptor-program',
        inputMint: USDC,
        outputMint: WSOL,
        inputAmount: 50000n,
        expectedOutputAmount: 1000n,
        minimumOutputAmount: 990n,
        pool: POOL_A,
      }, {
        provider: 'jupiter',
        programId: 'jupiter-program',
        inputMint: WSOL,
        outputMint: USDC,
        inputAmount: 990n,
        expectedOutputAmount: 50100n,
        minimumOutputAmount: 50050n,
        pool: POOL_B,
      }],
    },
    ...overrides,
  } as AtomicExecutionPlan;
}

describe('execution route alignment', () => {
  it('accepts a fresh executor rebuild on the same underlying pools', () => {
    const result = compareExecutionRouteAlignment(candidate(), plan());
    expect(result.passed).toBe(true);
    expect(result.code).toBe('ALIGNED');
  });

  it('rejects a fresh rebuild that silently switches underlying liquidity', () => {
    const changed = plan();
    changed.aggregatorEvidence!.legs[1].pool = POOL_C;
    const result = compareExecutionRouteAlignment(candidate(), changed);
    expect(result.passed).toBe(false);
    expect(result.code).toBe('EXECUTION_ROUTE_CHANGED');
  });

  it('rejects ambiguous multi-pool scanner evidence for an executable handoff', () => {
    const result = compareExecutionRouteAlignment(
      candidate({ scannerPools: [[POOL_A, POOL_C], [POOL_B]] }),
      plan(),
    );
    expect(result.passed).toBe(false);
    expect(result.code).toBe('SCANNER_POOL_EVIDENCE_AMBIGUOUS');
  });

  it('rejects provider-order divergence', () => {
    const changed = plan();
    changed.aggregatorEvidence!.providers = ['jupiter', 'raptor'];
    const result = compareExecutionRouteAlignment(candidate(), changed);
    expect(result.passed).toBe(false);
    expect(result.code).toBe('PROVIDER_ORDER_MISMATCH');
  });

  it('rejects a broken minimum-output amount chain', () => {
    const changed = plan();
    changed.aggregatorEvidence!.legs[1].inputAmount = 991n;
    const result = compareExecutionRouteAlignment(candidate(), changed);
    expect(result.passed).toBe(false);
    expect(result.code).toBe('AMOUNT_CHAIN_MISMATCH');
  });
});

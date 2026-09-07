import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { Quote } from '../aggregators/types.js';
import { EXECUTABLE_POLICY_HASH, EXECUTABLE_POLICY_VERSION, EXECUTION_ORCA_PROGRAM_ID, executionAdapterIdentity, quoteMatchesExecutableProviderPolicy } from './executable-route-policy.js';

const atomic = z.string().regex(/^(0|[1-9]\d*)$/);
const address = z.string().refine((value) => {
  try { new PublicKey(value); return true; } catch { return false; }
}, 'must be a Solana address');

const providerName = z.enum(['jupiter', 'raptor', 'orca', 'raydium', 'meteora']);
const legEvidence = z.object({ provider: providerName, poolId: address, executableProgramId: address,
  normalizedRouteLabel: z.string().min(1).max(180), inputMint: address, outputMint: address,
  inputAmount: atomic, minimumOutputAmount: atomic, quoteEvidenceAt: z.number().int().positive() }).strict();
export const RouteEvidenceSchema = z.object({ policyVersion: z.number().int().positive(), policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  leg1: legEvidence, leg2: legEvidence }).strict();
export type RouteEvidence = z.infer<typeof RouteEvidenceSchema>;
export function routeEvidenceFingerprint(value: RouteEvidence): string {
  // Schema parsing yields a stable field order and rejects unknown authority fields.
  return createHash('sha256').update(JSON.stringify(RouteEvidenceSchema.parse(value))).digest('hex');
}
export function quoteRouteEvidence(buy: Quote, sell: Quote): RouteEvidence {
  const leg = (quote: Quote): z.infer<typeof legEvidence> => {
    if (!quoteMatchesExecutableProviderPolicy(quote) || quote.poolIds.length !== 1) throw new Error('ROUTE_POLICY_REJECTED: ambiguous executable quote');
    const program = quote.routePlan[0]?.swapInfo.programId ?? (quote.provider === 'jupiter' || quote.provider === 'orca' ? EXECUTION_ORCA_PROGRAM_ID : undefined);
    if (!program) throw new Error('ROUTE_POLICY_REJECTED: missing downstream program');
    return { provider: quote.provider, poolId: quote.poolIds[0]!, executableProgramId: program,
      normalizedRouteLabel: executionAdapterIdentity(quote.provider, program), inputMint: quote.inputMint, outputMint: quote.outputMint,
      inputAmount: quote.inAmount, minimumOutputAmount: quote.otherAmountThreshold, quoteEvidenceAt: quote.responseTimestamp };
  };
  return { policyVersion: EXECUTABLE_POLICY_VERSION, policyHash: EXECUTABLE_POLICY_HASH, leg1: leg(buy), leg2: leg(sell) };
}

/** Scanner data is identification/diagnostics only; no instruction bytes are permitted. */
export const AggregatorAtomicHandoffSchema = z.object({
  schema: z.literal('sol-arb.aggregator-execution-handoff'),
  version: z.union([z.literal(1), z.literal(2)]),
  routeEvidence: RouteEvidenceSchema.optional(),
  routeFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  opportunityId: z.string().min(1).max(160),
  detectedAt: z.number().int().positive(),
  opportunityType: z.string().regex(/^[A-Z_]+_ATOMIC$/),
  providers: z.tuple([providerName, providerName]),
  inputMint: address,
  intermediateMint: address,
  outputMint: address,
  proposedInputAmount: atomic,
  scannerPools: z.tuple([z.array(address).max(8), z.array(address).max(8)]),
  scannerObservation: z.object({
    expectedOutputAmount: atomic,
    minimumOutputAmount: atomic,
    projectedNetAmount: z.string().regex(/^-?(0|[1-9]\d*)$/),
    roiBps: z.string().regex(/^-?(0|[1-9]\d*)$/),
    quoteTimestamp: z.number().int().positive(),
    confidenceScore: z.number().finite().min(0).max(100).optional(),
  }).strict(),
}).strict();

export type AggregatorAtomicHandoff = z.infer<typeof AggregatorAtomicHandoffSchema>;

function providerTypeKey(providers: [string, string]): string {
  return `${providers[0].toUpperCase()}_${providers[1].toUpperCase()}_ATOMIC`;
}

export function parseAggregatorAtomicHandoff(input: unknown): AggregatorAtomicHandoff {
  const value = AggregatorAtomicHandoffSchema.parse(input);
  const expectedType = providerTypeKey(value.providers);
  if (value.opportunityType !== expectedType) {
    throw new Error('Aggregator handoff opportunity type does not match provider order');
  }
  if (value.inputMint !== value.outputMint || value.inputMint === value.intermediateMint) {
    throw new Error('Aggregator handoff must be a complete cycle through a distinct intermediate mint');
  }
  if (BigInt(value.proposedInputAmount) <= 0n) throw new Error('Aggregator handoff input must be positive');
  if (value.version === 1 && (value.routeEvidence || value.routeFingerprint)) throw new Error('Handoff v1 cannot contain v2 route evidence');
  if (value.version === 2) {
    const evidence = value.routeEvidence;
    if (!evidence || value.routeFingerprint !== routeEvidenceFingerprint(evidence)) throw new Error('ROUTE_FINGERPRINT_MISMATCH');
    const legs = [evidence.leg1, evidence.leg2];
    if (legs.some((leg, i) => leg.provider !== value.providers[i] || value.scannerPools[i]!.length !== 1 || leg.poolId !== value.scannerPools[i]![0])
      || evidence.leg1.inputMint !== value.inputMint || evidence.leg1.outputMint !== value.intermediateMint
      || evidence.leg2.inputMint !== value.intermediateMint || evidence.leg2.outputMint !== value.outputMint
      || evidence.leg1.inputAmount !== value.proposedInputAmount || evidence.leg2.inputAmount !== evidence.leg1.minimumOutputAmount
      || evidence.leg2.minimumOutputAmount !== value.scannerObservation.minimumOutputAmount) throw new Error('ROUTE_EVIDENCE_CHAIN_MISMATCH');
  }
  return value;
}

export function aggregatorHandoffIdentity(value: AggregatorAtomicHandoff): string {
  return createHash('sha256').update([
    value.schema, value.version, value.opportunityType, ...value.providers,
    value.inputMint, value.intermediateMint, value.outputMint,
    value.proposedInputAmount, value.detectedAt, ...(value.version === 2 ? [value.routeFingerprint] : []),
  ].join(':')).digest('hex');
}

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const atomic = z.string().regex(/^(0|[1-9]\d*)$/);
const address = z.string().refine((value) => {
  try { new PublicKey(value); return true; } catch { return false; }
}, 'must be a Solana address');

const providerName = z.enum(['jupiter', 'raptor', 'orca', 'raydium', 'meteora']);

/** Scanner data is identification/diagnostics only; no instruction bytes are permitted. */
export const AggregatorAtomicHandoffSchema = z.object({
  schema: z.literal('sol-arb.aggregator-execution-handoff'),
  version: z.literal(1),
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
  return value;
}

export function aggregatorHandoffIdentity(value: AggregatorAtomicHandoff): string {
  return createHash('sha256').update([
    value.schema, value.version, value.opportunityType, ...value.providers,
    value.inputMint, value.intermediateMint, value.outputMint,
    value.proposedInputAmount, value.detectedAt,
  ].join(':')).digest('hex');
}

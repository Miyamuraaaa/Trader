import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const atomic = z.string().regex(/^(0|[1-9]\d*)$/, 'must be an unsigned atomic integer string');
const address = z.string().min(32).max(64).refine((value) => {
  try { new PublicKey(value); return true; } catch { return false; }
}, 'must be a base58 Solana address');

/** Untrusted scanner-to-executor transport. It intentionally cannot contain a transaction or signer. */
export const OrcaAtomicHandoffSchema = z.object({
  schema: z.literal('sol-arb.execution-handoff'),
  version: z.literal(1),
  opportunityId: z.string().min(1).max(160),
  detectedAt: z.number().int().positive(),
  opportunityType: z.literal('ORCA_TWO_HOP_ATOMIC'),
  venue: z.literal('orca'),
  inputMint: address,
  intermediateMint: address,
  outputMint: address,
  pools: z.tuple([address, address]).refine(([first, second]) => first !== second, 'pools must be distinct'),
  proposedInputAmount: atomic,
  scannerObservation: z.object({
    expectedOutputAmount: atomic,
    minimumOutputAmount: atomic,
    projectedNetAmount: z.string().regex(/^-?(0|[1-9]\d*)$/),
    roiBps: z.string().regex(/^-?(0|[1-9]\d*)$/),
    quoteTimestamp: z.number().int().positive(),
    stateSlots: z.array(z.string().regex(/^\d+$/)).max(8),
  }).strict(),
  discovery: z.object({
    source: z.string().min(1).max(80),
    metadata: z.record(z.string(), z.string().max(500)).default({}),
  }).strict(),
}).strict();

export type OrcaAtomicHandoff = z.infer<typeof OrcaAtomicHandoffSchema>;

export function parseOrcaAtomicHandoff(input: unknown): OrcaAtomicHandoff {
  const candidate = OrcaAtomicHandoffSchema.parse(input);
  if (candidate.inputMint !== candidate.outputMint) throw new Error('Execution handoff must be a same-mint cycle');
  if (candidate.inputMint === candidate.intermediateMint) throw new Error('Execution handoff intermediate mint must differ');
  if (BigInt(candidate.proposedInputAmount) <= 0n) throw new Error('Execution handoff input must be positive');
  return candidate;
}

/**
 * Stable identity for one detected market generation. Scanner economics never
 * affect it, but detectedAt does: a later independently observed market state
 * on the same pools/amount must not be permanently suppressed by an older
 * terminal journal record.
 */
export function handoffIdentity(candidate: OrcaAtomicHandoff): string {
  return crypto.createHash('sha256').update([
    candidate.schema, candidate.version, candidate.opportunityType, candidate.venue,
    candidate.inputMint, candidate.intermediateMint, candidate.outputMint,
    ...candidate.pools, candidate.proposedInputAmount, candidate.detectedAt,
  ].join(':')).digest('hex');
}

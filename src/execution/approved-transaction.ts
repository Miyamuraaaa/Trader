import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { getBase58Decoder } from '@solana/kit';
import { PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { inspectAtomicTransaction } from './transaction-inspector.js';
import type { AtomicExecutionPlan, InspectionResult, SignerContext, SimulationResult } from './types.js';

const submissionApprovals = new WeakSet<object>();

export interface ApprovedExecution {
  readonly purpose: 'developer-validation' | 'validated-opportunity';
  readonly plan: AtomicExecutionPlan;
  readonly transaction: VersionedTransaction;
  readonly messageHash: string;
  readonly inspection: InspectionResult;
}

export interface LocallySignedExecution extends ApprovedExecution {
  readonly signature: string;
  readonly signedMessageHash: string;
  readonly serializedSize: number;
}

export interface ApprovedSignedExecution extends LocallySignedExecution {
  readonly executionId: string;
  readonly transactionSignature: string;
  readonly serializedTransactionHash: string;
  readonly approvedForSubmissionAt: number;
  readonly unsignedSimulation: SimulationResult;
  readonly signedSimulation?: SimulationResult;
  readonly signatureVerification: 'LOCAL_ED25519' | 'LOCAL_ED25519_AND_RPC_SIGVERIFY';
}

function messageHash(transaction: VersionedTransaction): string {
  return createHash('sha256').update(transaction.message.serialize()).digest('hex');
}

function serializedHash(transaction: VersionedTransaction): string {
  return createHash('sha256').update(transaction.serialize()).digest('hex');
}

function compiledInstructions(plan: AtomicExecutionPlan, transaction: VersionedTransaction): TransactionInstruction[] {
  const message = transaction.message;
  const lookupTables = plan.lookupTableAccounts ?? [];
  const approvedTables = new Map(lookupTables.map((table) => [table.key.toBase58(), table]));
  const usedTables = message.addressTableLookups.map((lookup) => {
    const table = approvedTables.get(lookup.accountKey.toBase58());
    if (!table) throw new Error('Compiled transaction uses an unapproved lookup table');
    return table;
  });
  const accountKeys = message.getAccountKeys({ addressLookupTableAccounts: usedTables });
  const metas = (index: number) => {
    const pubkey = accountKeys.get(index);
    if (!pubkey) throw new Error('Compiled instruction references an unknown account');
    const isSigner = message.isAccountSigner(index);
    const isWritable = message.isAccountWritable(index);
    return { pubkey, isSigner, isWritable };
  };
  return message.compiledInstructions.map((instruction) => {
    const programId = accountKeys.get(instruction.programIdIndex);
    if (!programId) throw new Error('Compiled instruction references an unknown program');
    return new TransactionInstruction({
      programId,
      keys: instruction.accountKeyIndexes.map(metas),
      data: Buffer.from(instruction.data),
    });
  });
}

/** Decodes the exact compiled message that will be signed, not only its source plan. */
export function inspectCompiledTransaction(plan: AtomicExecutionPlan, transaction: VersionedTransaction): InspectionResult {
  return inspectAtomicTransaction({ ...plan, instructions: compiledInstructions(plan, transaction) });
}

export function approveTransaction(
  purpose: ApprovedExecution['purpose'],
  plan: AtomicExecutionPlan,
  transaction: VersionedTransaction,
): ApprovedExecution {
  const inspection = inspectCompiledTransaction(plan, transaction);
  if (!inspection.passed) throw new Error(`Final compiled-message inspection failed: ${inspection.reasons.join('; ')}`);
  if (transaction.message.header.numRequiredSignatures !== 1) {
    throw new Error('Initial executor requires exactly one transaction signature');
  }
  return Object.freeze({ purpose, plan, transaction, messageHash: messageHash(transaction), inspection });
}

function ed25519PublicKey(publicKey: Uint8Array) {
  // RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey)]), format: 'der', type: 'spki' });
}

/**
 * Creates a local signature only after the exact compiled message is approved.
 * It has no RPC dependency and never sends the transaction.
 */
export function signApprovedExecution(approved: ApprovedExecution, signer: SignerContext): LocallySignedExecution {
  if (approved.plan.wallet !== signer.publicKey) throw new Error('Approved message signer does not match dedicated wallet');
  if (messageHash(approved.transaction) !== approved.messageHash) throw new Error('Approved message changed before signing');
  const finalInspection = inspectCompiledTransaction(approved.plan, approved.transaction);
  if (!finalInspection.passed) throw new Error(`Compiled message changed before signing: ${finalInspection.reasons.join('; ')}`);
  approved.transaction.sign([signer.keypair]);
  const signedMessageHash = messageHash(approved.transaction);
  if (signedMessageHash !== approved.messageHash) throw new Error('SIGNED_MESSAGE_HASH does not match APPROVED_MESSAGE_HASH');
  const signature = approved.transaction.signatures[0];
  if (!signature || !verifySignature(null, approved.transaction.message.serialize(), ed25519PublicKey(signer.keypair.publicKey.toBytes()), signature)) {
    throw new Error('Local Ed25519 signature verification failed');
  }
  return Object.freeze({
    ...approved,
    inspection: finalInspection,
    signature: Buffer.from(signature).toString('base64'),
    signedMessageHash,
    serializedSize: approved.transaction.serialize().length,
  });
}

function verifyTransactionSignature(signed: LocallySignedExecution): Uint8Array {
  const signature = signed.transaction.signatures[0];
  if (!signature || signature.every((byte) => byte === 0)) throw new Error('Approved transaction has no signature');
  const wallet = new PublicKey(signed.plan.wallet);
  if (!verifySignature(null, signed.transaction.message.serialize(), ed25519PublicKey(wallet.toBytes()), signature)) {
    throw new Error('Approved transaction signature is invalid');
  }
  return signature;
}

/**
 * Creates the only object accepted by the one-shot broadcaster. The private
 * WeakSet brand cannot be reconstructed from JSON or scanner-controlled data.
 */
export function approveSignedExecutionForSubmission(
  executionId: string,
  signed: LocallySignedExecution,
  unsignedSimulation: SimulationResult,
  signedSimulation?: SimulationResult,
): ApprovedSignedExecution {
  if (signed.purpose !== 'validated-opportunity') {
    throw new Error('Developer validation transactions can never be approved for submission');
  }
  if (!unsignedSimulation.passed || unsignedSimulation.sigVerify) {
    throw new Error('A passing unsigned sigVerify=false simulation is required');
  }
  if (signedSimulation && (!signedSimulation.passed || !signedSimulation.sigVerify)) {
    throw new Error('A passing signed sigVerify=true simulation is required');
  }
  assertSignedExecutionIntegrity(signed);
  if (messageHash(unsignedSimulation.transaction) !== signed.messageHash
    || (signedSimulation && messageHash(signedSimulation.transaction) !== signed.messageHash)) {
    throw new Error('Simulation message does not match approved signed message');
  }
  const signature = verifyTransactionSignature(signed);
  const approved = Object.freeze({
    ...signed,
    executionId,
    transactionSignature: getBase58Decoder().decode(signature),
    serializedTransactionHash: serializedHash(signed.transaction),
    approvedForSubmissionAt: Date.now(),
    unsignedSimulation,
    signedSimulation,
    signatureVerification: signedSimulation
      ? 'LOCAL_ED25519_AND_RPC_SIGVERIFY'
      : 'LOCAL_ED25519',
  });
  submissionApprovals.add(approved);
  return approved;
}

/** Re-verifies all mutable transaction material immediately before submission. */
export function assertApprovedSignedExecution(value: unknown): asserts value is ApprovedSignedExecution {
  if (typeof value !== 'object' || value === null || !submissionApprovals.has(value)) {
    throw new Error('Transaction is not an in-process ApprovedSignedExecution');
  }
  const approved = value as ApprovedSignedExecution;
  if (approved.purpose !== 'validated-opportunity') throw new Error('Only validated opportunities may be submitted');
  assertSignedExecutionIntegrity(approved);
  const signature = verifyTransactionSignature(approved);
  if (getBase58Decoder().decode(signature) !== approved.transactionSignature) {
    throw new Error('Approved transaction signature changed');
  }
  if (serializedHash(approved.transaction) !== approved.serializedTransactionHash) {
    throw new Error('Approved signed transaction bytes changed');
  }
  if (!approved.unsignedSimulation.passed || approved.unsignedSimulation.sigVerify
    || (approved.signedSimulation
      && (!approved.signedSimulation.passed || !approved.signedSimulation.sigVerify))) {
    throw new Error('Required simulation evidence is invalid');
  }
}

function assertSignedExecutionIntegrity(signed: LocallySignedExecution): void {
  if (messageHash(signed.transaction) !== signed.messageHash
    || signed.signedMessageHash !== signed.messageHash) {
    throw new Error('Signed message fingerprint does not match approval');
  }
  const inspection = inspectCompiledTransaction(signed.plan, signed.transaction);
  if (!inspection.passed) throw new Error(`Approved signed transaction inspection failed: ${inspection.reasons.join('; ')}`);
  if (signed.transaction.serialize().length !== signed.serializedSize) {
    throw new Error('Signed transaction serialized size changed');
  }
}

import {
  AccountRole,
  type AccountMeta,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
} from '@solana/instructions';
import type { ReadonlyUint8Array } from '@solana/codecs-core';
import { address } from '@solana/kit';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export function kitInstructionToWeb3(instruction: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: (instruction.accounts ?? []).map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER,
      isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(instruction.data ?? new Uint8Array()),
  });
}

/**
 * The Orca client consumes this fully populated instruction shape. Keeping the
 * conversion here makes the Kit v6 -> web3 -> Orca-client boundary explicit
 * and avoids pretending that the two Kit major versions are type-compatible.
 */
export type DecodableKitInstruction = Instruction
  & InstructionWithAccounts<readonly AccountMeta[]>
  & InstructionWithData<ReadonlyUint8Array>;

export function web3InstructionToKit(instruction: TransactionInstruction): DecodableKitInstruction {
  return {
    programAddress: address(instruction.programId.toBase58()),
    accounts: instruction.keys.map((meta) => ({
      address: address(meta.pubkey.toBase58()),
      role: meta.isSigner
        ? meta.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
        : meta.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: new Uint8Array(instruction.data),
  };
}

export function assertKitWeb3InstructionRoundTrip(instruction: Instruction): void {
  const roundTripped = web3InstructionToKit(kitInstructionToWeb3(instruction));
  if (roundTripped.programAddress !== instruction.programAddress) {
    throw new Error('Kit/web3 adapter changed the Orca program address');
  }
  if (roundTripped.accounts.length !== (instruction.accounts?.length ?? 0)) {
    throw new Error('Kit/web3 adapter changed the Orca account-meta count');
  }
  for (const [index, account] of (instruction.accounts ?? []).entries()) {
    const returned = roundTripped.accounts[index];
    if (!returned || returned.address !== account.address || returned.role !== account.role) {
      throw new Error(`Kit/web3 adapter changed Orca account meta ${index}`);
    }
  }
  const sourceData = instruction.data ?? new Uint8Array();
  if (sourceData.length !== roundTripped.data.length
    || sourceData.some((value, index) => value !== roundTripped.data[index])) {
    throw new Error('Kit/web3 adapter changed Orca instruction data');
  }
}

import { Connection, PublicKey, type AccountInfo, type ParsedAccountData } from '@solana/web3.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';

/** Canonical program addresses; no SPL Token binary decoder is linked here. */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_ACCOUNT_SIZE = 165;

export interface TokenAccountPreflight {
  ata: string;
  exists: boolean;
  balance: bigint;
  creationRentLamports: number;
}

interface ParsedTokenAccountInfo {
  mint?: unknown;
  owner?: unknown;
  tokenAmount?: { amount?: unknown };
}

export function associatedTokenAddress(mint: PublicKey, wallet: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function inspectParsedAssociatedTokenAccount(
  value: AccountInfo<Buffer | ParsedAccountData> | null,
  wallet: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  creationRentLamports: number,
): TokenAccountPreflight {
  const ata = associatedTokenAddress(mint, wallet, tokenProgram);
  if (!value) {
    return { ata: ata.toBase58(), exists: false, balance: 0n, creationRentLamports };
  }
  if (!value.owner.equals(tokenProgram)) throw new Error('ATA is owned by an unexpected program');
  if (!('parsed' in value.data) || typeof value.data.parsed !== 'object' || value.data.parsed === null) {
    throw new Error('ATA RPC response is not parsed token-account data');
  }
  const parsed = (value.data.parsed as { info?: ParsedTokenAccountInfo }).info;
  if (!parsed || parsed.owner !== wallet.toBase58() || parsed.mint !== mint.toBase58()
    || typeof parsed.tokenAmount?.amount !== 'string' || !/^\d+$/.test(parsed.tokenAmount.amount)) {
    throw new Error('ATA owner, mint, or amount is malformed');
  }
  return { ata: ata.toBase58(), exists: true, balance: BigInt(parsed.tokenAmount.amount), creationRentLamports: 0 };
}

/**
 * Uses Solana RPC's maintained `jsonParsed` token parser rather than decoding
 * attacker-controlled account bytes through the vulnerable spl-token chain.
 * Token-2022 is intentionally fail-closed for execution until its extensions
 * have a separately reviewed maintained-client implementation.
 */
export async function inspectAssociatedTokenAccount(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  profiler?: ExecutionNetworkProfiler,
): Promise<TokenAccountPreflight> {
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID)) {
    throw new Error('Token-2022 accounts are not execution-supported');
  }
  const ata = associatedTokenAddress(mint, wallet, tokenProgram);
  const loadAccount = () => connection.getParsedAccountInfo(ata, 'confirmed');
  const info = profiler
    ? await profiler.measure(`rpc.ata.${mint.toBase58()}.getParsedAccountInfo`, 'rpc', loadAccount)
    : await loadAccount();
  const creationRentLamports = info.value ? 0 : profiler
    ? await profiler.measure('rpc.ata.getMinimumBalanceForRentExemption', 'rpc', () =>
      connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE))
    : await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
  return inspectParsedAssociatedTokenAccount(
    info.value, wallet, mint, tokenProgram, creationRentLamports,
  );
}

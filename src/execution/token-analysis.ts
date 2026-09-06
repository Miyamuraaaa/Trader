import { Connection, PublicKey, type AccountInfo, type ParsedAccountData } from '@solana/web3.js';
import { CONFIG, MINTS } from '../config.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './account-preflight.js';
import type { ExecutionNetworkProfiler } from './network-profiler.js';

export type TokenExecutionStatus = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';

export interface TokenProgramAnalysis {
  mint: string;
  status: TokenExecutionStatus;
  programId?: string;
  decimals?: number;
  extensions: string[];
  reasons: string[];
  transferFeeMode: 'NONE' | 'BLOCKED_UNMODELED' | 'UNKNOWN';
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}

/**
 * Execution policy for an intermediate mint. Discovery remains broader, but
 * an atomic transaction may only use a mint whose behavior is independently
 * understood by the executor. Unknown authorities fail closed.
 */
export function assertIntermediateTokenExecutionPolicy(
  analysis: TokenProgramAnalysis,
  allowDynamic = CONFIG.allowDynamicTokenExecution,
): void {
  if (analysis.status !== 'SUPPORTED' || !analysis.programId) {
    throw new Error(`Token ${analysis.mint} is not execution-supported: ${analysis.reasons.join('; ')}`);
  }
  if (analysis.mint === MINTS.SOL || analysis.mint === MINTS.USDT) return;
  if (!allowDynamic) throw new Error('Dynamic-token execution is disabled');
  if (analysis.mintAuthority !== null || analysis.freezeAuthority !== null) {
    throw new Error(`Dynamic intermediate ${analysis.mint} has active or unknown mint/freeze authority`);
  }
}

/**
 * Kept as a pure policy helper for explicit test coverage. Execution does not
 * permit any Token-2022 mint until a maintained compatible client is adopted.
 */
export function classifyToken2022Extensions(extensions: readonly string[]): Pick<
  TokenProgramAnalysis, 'status' | 'extensions' | 'reasons' | 'transferFeeMode'
> {
  const names = [...extensions];
  const hasTransferFee = names.some((name) => name.toLowerCase() === 'transferfeeconfig');
  return {
    status: 'UNSUPPORTED',
    extensions: names,
    reasons: ['Token-2022 execution is not enabled; extension parsing requires a separately reviewed maintained client.'],
    transferFeeMode: hasTransferFee ? 'BLOCKED_UNMODELED' : 'UNKNOWN',
  };
}

interface ParsedMintInfo {
  decimals?: unknown;
  extensions?: unknown;
  mintAuthority?: unknown;
  freezeAuthority?: unknown;
}

export type ParsedRpcAccount = AccountInfo<Buffer | ParsedAccountData> | null;

export function analyzeParsedTokenMint(
  mintAddress: string,
  value: ParsedRpcAccount,
): TokenProgramAnalysis {
  if (!value) {
    return { mint: mintAddress, status: 'UNKNOWN', extensions: [], reasons: ['Mint account not found'], transferFeeMode: 'UNKNOWN' };
  }
  const owner = value.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return {
      mint: mintAddress, status: 'UNSUPPORTED', programId: owner.toBase58(), extensions: [],
      reasons: ['Mint is not owned by SPL Token or Token-2022'], transferFeeMode: 'UNKNOWN',
    };
  }
  if (!('parsed' in value.data) || typeof value.data.parsed !== 'object' || value.data.parsed === null) {
    return {
      mint: mintAddress, status: 'UNKNOWN', programId: owner.toBase58(), extensions: [],
      reasons: ['Mint RPC response is not parsed mint data'], transferFeeMode: 'UNKNOWN',
    };
  }
  const parsed = (value.data.parsed as { info?: ParsedMintInfo }).info;
  if (!parsed || !Number.isInteger(parsed.decimals) || (parsed.decimals as number) < 0 || (parsed.decimals as number) > 255) {
    return {
      mint: mintAddress, status: 'UNKNOWN', programId: owner.toBase58(), extensions: [],
      reasons: ['Mint RPC response has invalid decimals'], transferFeeMode: 'UNKNOWN',
    };
  }
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const extensions = Array.isArray(parsed.extensions)
      ? parsed.extensions.flatMap((entry) => typeof entry === 'object' && entry !== null && 'extension' in entry
        && typeof (entry as { extension?: unknown }).extension === 'string'
        ? [(entry as { extension: string }).extension] : [])
      : [];
    return { mint: mintAddress, programId: owner.toBase58(), decimals: parsed.decimals as number, ...classifyToken2022Extensions(extensions) };
  }
  return {
    mint: mintAddress, status: 'SUPPORTED', programId: owner.toBase58(), decimals: parsed.decimals as number,
    extensions: [], reasons: [], transferFeeMode: 'NONE',
    mintAuthority: typeof parsed.mintAuthority === 'string' ? parsed.mintAuthority : null,
    freezeAuthority: typeof parsed.freezeAuthority === 'string' ? parsed.freezeAuthority : null,
  };
}

/**
 * Uses the RPC node's jsonParsed mint parser. The executor rejects malformed
 * responses and every Token-2022 mint, eliminating spl-token binary parsing
 * from the signer/execution path.
 */
export async function analyzeTokenMint(
  connection: Connection,
  mintAddress: string,
  profiler?: ExecutionNetworkProfiler,
): Promise<TokenProgramAnalysis> {
  const mint = new PublicKey(mintAddress);
  const loadMint = () => connection.getParsedAccountInfo(mint, 'confirmed');
  const info = profiler
    ? await profiler.measure(`rpc.mint.${mintAddress}.getParsedAccountInfo`, 'rpc', loadMint)
    : await loadMint();
  return analyzeParsedTokenMint(mintAddress, info.value);
}

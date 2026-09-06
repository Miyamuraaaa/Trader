import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG, LAMPORTS_PER_SOL, MINTS } from './config.js';
import { assertAtomicAmount } from './aggregators/types.js';
import { fromAtomic } from './math.js';
import { recordRpcRequests, rpcMetrics } from './solana.js';
import { runScannerRpc } from './scanner-rpc-limiter.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export interface WalletTokenBalance {
  mint: string;
  tokenProgram: 'spl-token' | 'token-2022';
  amountAtomic: string;
  decimals: number;
  displayAmount: string;
  tokenAccounts: string[];
}

export interface ReadOnlyWalletSnapshot {
  address: string;
  slot: number;
  solLamports: string;
  solDisplay: string;
  usdcAmountAtomic: string;
  tokenBalances: WalletTokenBalance[];
  observedAt: number;
  executionLimits: {
    configuredMaxTradeUsdc: number;
    balancePercentLimit: number;
    protectedSolReserve: number;
    solReservePass: boolean;
  };
}

export interface WalletUsdEstimate {
  solPriceUsd: number;
  solPriceObservedAt: number;
  solPriceProvider: string;
  usdcValue: number;
  solValue: number;
  totalUsd: number;
}

interface ParsedTokenAccountInfo {
  mint?: unknown;
  tokenAmount?: { amount?: unknown; decimals?: unknown; uiAmountString?: unknown };
}

function mergeTokenAccounts(
  rows: Awaited<ReturnType<Connection['getParsedTokenAccountsByOwner']>>['value'],
  program: WalletTokenBalance['tokenProgram'],
  merged: Map<string, WalletTokenBalance>,
): void {
  for (const row of rows) {
    const parsed = row.account.data;
    if (!('parsed' in parsed) || typeof parsed.parsed !== 'object' || parsed.parsed === null) continue;
    const info = (parsed.parsed as { info?: ParsedTokenAccountInfo }).info;
    if (!info || typeof info.mint !== 'string' || !info.tokenAmount) continue;
    const amount = info.tokenAmount.amount;
    const decimals = info.tokenAmount.decimals;
    if (typeof amount !== 'string' || typeof decimals !== 'number') continue;
    assertAtomicAmount(amount, `wallet token balance ${info.mint}`);
    const current = merged.get(info.mint);
    const total = (BigInt(current?.amountAtomic ?? '0') + BigInt(amount)).toString();
    merged.set(info.mint, {
      mint: info.mint,
      tokenProgram: program,
      amountAtomic: total,
      decimals,
      displayAmount: formatAtomic(total, decimals),
      tokenAccounts: [...(current?.tokenAccounts ?? []), row.pubkey.toBase58()],
    });
  }
}

function formatAtomic(amount: string, decimals: number): string {
  const padded = amount.padStart(decimals + 1, '0');
  if (decimals === 0) return padded;
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

/** Reads public on-chain state only. It never loads a keypair or creates a signer. */
export async function readBotWallet(address = CONFIG.botWalletAddress): Promise<ReadOnlyWalletSnapshot> {
  if (!address) throw new Error('BOT_WALLET_ADDRESS is not configured');
  const owner = new PublicKey(address);
  const connection = new Connection(rpcMetrics.activeEndpoint, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  recordRpcRequests(4);
  const [slot, lamports, classic, token2022] = await runScannerRpc(
    'scanner.dashboard.walletSnapshot',
    () => Promise.all([
      connection.getSlot('confirmed'),
      connection.getBalance(owner, 'confirmed'),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed'),
    ]),
    'LOW',
  );
  const balances = new Map<string, WalletTokenBalance>();
  mergeTokenAccounts(classic.value, 'spl-token', balances);
  mergeTokenAccounts(token2022.value, 'token-2022', balances);
  const tokenBalances = [...balances.values()].sort((a, b) => a.mint.localeCompare(b.mint));
  const usdcAmountAtomic = balances.get(MINTS.USDC)?.amountAtomic ?? '0';
  const sol = lamports / LAMPORTS_PER_SOL;
  return {
    address: owner.toBase58(),
    slot,
    solLamports: String(lamports),
    solDisplay: formatAtomic(String(lamports), 9),
    usdcAmountAtomic,
    tokenBalances,
    observedAt: Date.now(),
    executionLimits: {
      configuredMaxTradeUsdc: CONFIG.maxTradeUsdc,
      balancePercentLimit: CONFIG.maxTradePercent,
      protectedSolReserve: CONFIG.minSolFeeReserve,
      solReservePass: sol >= CONFIG.minSolFeeReserve,
    },
  };
}

/** Adds a display-only estimate; it never changes the on-chain wallet snapshot. */
export function withWalletUsdEstimate(
  snapshot: ReadOnlyWalletSnapshot,
  solQuote: { priceUsd: number; observedAt: number; provider: string } | null,
): ReadOnlyWalletSnapshot & { usdEstimate: WalletUsdEstimate | null } {
  if (!solQuote) return { ...snapshot, usdEstimate: null };
  const usdcValue = fromAtomic(snapshot.usdcAmountAtomic, 6).toNumber();
  const solValue = fromAtomic(snapshot.solLamports, 9).mul(solQuote.priceUsd).toNumber();
  return {
    ...snapshot,
    usdEstimate: {
      solPriceUsd: solQuote.priceUsd,
      solPriceObservedAt: solQuote.observedAt,
      solPriceProvider: solQuote.provider,
      usdcValue,
      solValue,
      totalUsd: usdcValue + solValue,
    },
  };
}

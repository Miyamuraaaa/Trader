/**
 * QUARANTINED PROTOTYPE — NOT REACHABLE FROM THE LIVE EXECUTOR.
 *
 * This Gemini-added implementation extracts instructions from Raydium's
 * API-owned serialized transaction wrapper. That does not satisfy this
 * project's independent pool-type decoder/inspection policy. Keep it outside
 * every live capability map until replaced by an audited direct SDK builder.
 */
import { createHash } from 'node:crypto';
import {
  AddressLookupTableAccount,
  Connection,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { z } from 'zod';
import { CONFIG } from '../config.js';
import { inspectAssociatedTokenAccount, TOKEN_PROGRAM_ID } from './account-preflight.js';
import { analyzeTokenMint, type TokenProgramAnalysis } from './token-analysis.js';
import type { TokenAccountPreflight } from './account-preflight.js';

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

const AtomicString = z.string().regex(/^(0|[1-9]\d*)$/);

const RaydiumComputeSchema = z.object({
  id: z.string(),
  success: z.literal(true),
  data: z.object({
    swapType: z.string(),
    inputMint: z.string(),
    inputAmount: AtomicString,
    outputMint: z.string(),
    outputAmount: AtomicString,
    otherAmountThreshold: AtomicString,
    slippageBps: z.number(),
    routePlan: z.array(z.object({
      poolId: z.string(),
      inputMint: z.string(),
      outputMint: z.string(),
    }).passthrough()),
  }).passthrough(),
});

const RaydiumTransactionSchema = z.object({
  success: z.literal(true),
  data: z.array(z.object({
    transaction: z.string(),
  })),
});

const mintAnalysisCache = new Map<string, ReturnType<typeof analyzeTokenMint>>();

function analyzeMintCached(connection: Connection, mint: string): ReturnType<typeof analyzeTokenMint> {
  const cached = mintAnalysisCache.get(mint);
  if (cached) return cached;
  const pending = analyzeTokenMint(connection, mint).catch((error) => {
    mintAnalysisCache.delete(mint);
    throw error;
  });
  mintAnalysisCache.set(mint, pending);
  return pending;
}

async function responseJson(url: string | URL, init: RequestInit, label: string): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(CONFIG.httpTimeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}

export interface RaydiumSwapLeg {
  instructions: TransactionInstruction[];
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  expectedOutput: bigint;
  minimumOutput: bigint;
  programId: string;
  instructionHash: string;
  inputAta: string;
  outputAta: string;
  quoteReceivedAt: number;
  pool: string;
  addressLookupTableAddresses: string[];
}

export interface RaydiumSwapLegInput {
  connection: Connection;
  wallet: PublicKey;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  slippageBps: number;
  inputToken?: TokenProgramAnalysis;
  outputToken?: TokenProgramAnalysis;
  inputAta?: TokenAccountPreflight;
  outputAta?: TokenAccountPreflight;
}

/**
 * Builds a single-swap Raydium instruction set for use as one leg of a
 * mixed-provider atomic cycle. Calls the Raydium Transaction API to obtain
 * a serialized transaction, then extracts swap instructions from it.
 */
export async function buildRaydiumSwapLeg(input: RaydiumSwapLegInput): Promise<RaydiumSwapLeg> {
  if (input.inputAmount <= 0n) throw new Error('Raydium swap leg input must be positive');
  if (input.inputMint === input.outputMint) throw new Error('Raydium swap leg mints must differ');

  const [inputToken, outputToken] = await Promise.all([
    input.inputToken ?? analyzeMintCached(input.connection, input.inputMint),
    input.outputToken ?? analyzeMintCached(input.connection, input.outputMint),
  ]);
  if (inputToken.status !== 'SUPPORTED' || !inputToken.programId
    || inputToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error(`Raydium swap input mint ${input.inputMint} is not a supported classic SPL token`);
  }
  if (outputToken.status !== 'SUPPORTED' || !outputToken.programId
    || outputToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error(`Raydium swap output mint ${input.outputMint} is not a supported classic SPL token`);
  }

  const [inputAta, outputAta] = await Promise.all([
    input.inputAta ?? inspectAssociatedTokenAccount(
      input.connection, input.wallet, new PublicKey(input.inputMint), TOKEN_PROGRAM_ID,
    ),
    input.outputAta ?? inspectAssociatedTokenAccount(
      input.connection, input.wallet, new PublicKey(input.outputMint), TOKEN_PROGRAM_ID,
    ),
  ]);

  // Step 1: Get compute/quote from Raydium
  const computeUrl = new URL(CONFIG.raydiumBaseUrl.replace(/\/$/, '') + '/compute/swap-base-in');
  computeUrl.searchParams.set('inputMint', input.inputMint);
  computeUrl.searchParams.set('outputMint', input.outputMint);
  computeUrl.searchParams.set('amount', input.inputAmount.toString());
  computeUrl.searchParams.set('slippageBps', String(input.slippageBps));
  computeUrl.searchParams.set('txVersion', 'V0');

  const quoteReceivedAt = Date.now();
  const computeRaw = await responseJson(computeUrl, { method: 'GET' }, 'Raydium compute');
  const compute = RaydiumComputeSchema.parse(computeRaw);
  const q = compute.data;

  if (q.inputMint !== input.inputMint || q.outputMint !== input.outputMint) {
    throw new Error('Raydium compute returned mismatched mints');
  }
  if (BigInt(q.outputAmount) <= 0n || q.routePlan.length === 0) {
    throw new Error('Raydium returned zero output or empty route');
  }

  // Step 2: Get serialized transaction from Raydium
  const txUrl = CONFIG.raydiumBaseUrl.replace(/\/$/, '') + '/transaction/swap-base-in';
  const txBody = {
    computeUnitPriceMicroLamports: '0',
    swapResponse: computeRaw,
    txVersion: 'V0',
    wallet: input.wallet.toBase58(),
    wrapSol: false,
    unwrapSol: false,
  };

  const txRaw = await responseJson(txUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(txBody),
  }, 'Raydium transaction');
  const txParsed = RaydiumTransactionSchema.parse(txRaw);

  if (txParsed.data.length === 0) throw new Error('Raydium transaction API returned no transactions');
  const txBase64 = txParsed.data[0]!.transaction;

  // Step 3: Deserialize the versioned transaction
  const versionedTx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));

  // Step 4: Resolve address lookup tables to decompile the message
  const altAddresses = versionedTx.message.addressTableLookups.map(
    (lookup) => lookup.accountKey.toBase58(),
  );
  const altAccounts: AddressLookupTableAccount[] = [];
  if (altAddresses.length > 0) {
    const altResults = await Promise.all(
      altAddresses.map((addr) => input.connection.getAddressLookupTable(new PublicKey(addr))),
    );
    for (const result of altResults) {
      if (result.value) altAccounts.push(result.value);
      else throw new Error('Raydium transaction references an unresolvable address lookup table');
    }
  }

  // Step 5: Decompile message to get individual instructions
  const decompiled = TransactionMessage.decompile(versionedTx.message, {
    addressLookupTableAccounts: altAccounts,
  });

  // Step 6: Filter out compute budget instructions (we set our own)
  const swapInstructions = decompiled.instructions.filter(
    (ix) => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID,
  );

  if (swapInstructions.length === 0) {
    throw new Error('Raydium transaction contained no swap instructions after filtering');
  }

  // Build instruction hash for deduplication/audit
  const hash = createHash('sha256');
  for (const ix of swapInstructions) {
    hash.update(ix.programId.toBuffer());
    for (const key of ix.keys) hash.update(key.pubkey.toBuffer());
    hash.update(ix.data);
  }

  const poolId = q.routePlan[0]?.poolId ?? 'unknown';
  // Determine primary program from the largest instruction
  const primaryProgramId = swapInstructions.reduce((best, ix) =>
    ix.data.length > best.data.length ? ix : best, swapInstructions[0]!,
  ).programId.toBase58();

  return {
    instructions: swapInstructions,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inputAmount: input.inputAmount,
    expectedOutput: BigInt(q.outputAmount),
    minimumOutput: BigInt(q.otherAmountThreshold),
    programId: primaryProgramId,
    instructionHash: hash.digest('hex'),
    inputAta: inputAta.ata,
    outputAta: outputAta.ata,
    quoteReceivedAt,
    pool: poolId,
    addressLookupTableAddresses: altAddresses,
  };
}

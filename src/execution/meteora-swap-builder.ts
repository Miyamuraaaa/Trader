/**
 * QUARANTINED PROTOTYPE — NOT REACHABLE FROM THE LIVE EXECUTOR.
 * Meteora setup/cleanup and DLMM instruction data are not yet decoded deeply
 * enough for the strict signer-process inspector.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type MeteoraDlmm from '@meteora-ag/dlmm';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { z } from 'zod';
import { CONFIG } from '../config.js';
import { getJson } from '../http.js';
import { PoolRegistry, type PoolMetadata } from '../pool-registry.js';
import { inspectAssociatedTokenAccount, TOKEN_PROGRAM_ID } from './account-preflight.js';
import { analyzeTokenMint, type TokenProgramAnalysis } from './token-analysis.js';
import type { TokenAccountPreflight } from './account-preflight.js';

const require = createRequire(import.meta.url);
function loadMeteoraSdk(): typeof MeteoraDlmm {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args[0] === 'bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)') return;
    originalWarn(...args);
  };
  try {
    return require('@meteora-ag/dlmm') as typeof MeteoraDlmm;
  } finally {
    console.warn = originalWarn;
  }
}
const DLMM = loadMeteoraSdk();

const MeteoraTokenSchema = z.object({
  address: z.string(),
  decimals: z.number(),
  symbol: z.string().optional(),
});

const MeteoraPoolSchema = z.object({
  address: z.string(),
  name: z.string(),
  token_x: MeteoraTokenSchema,
  token_y: MeteoraTokenSchema,
  tvl: z.number(),
  is_blacklisted: z.boolean(),
  pool_config: z.object({
    bin_step: z.number(),
    base_fee_pct: z.number().optional(),
  }),
});

const MeteoraPoolsResponseSchema = z.object({ data: z.array(MeteoraPoolSchema) });
const meteoraPoolRegistry = new PoolRegistry(CONFIG.poolCacheTtlMs);

async function discoverMeteoraPools(inputMint: string, outputMint: string): Promise<PoolMetadata[]> {
  return meteoraPoolRegistry.getOrLoad('meteora', inputMint, outputMint, async () => {
    const url = new URL(CONFIG.meteoraApiBaseUrl.replace(/\/$/, '') + '/pools');
    url.searchParams.set('page', '1');
    url.searchParams.set('page_size', String(Math.max(10, CONFIG.meteoraMaxPoolsPerPair * 5)));
    url.searchParams.set('query', inputMint);
    url.searchParams.set('sort_by', 'tvl:desc');
    url.searchParams.set(
      'filter_by',
      `is_blacklisted=false && tvl>${CONFIG.directPoolMinTvlUsdc}`,
    );
    const raw = await getJson<unknown>(url.toString(), {}, {
      provider: 'Meteora pool discovery',
      maxRetries: Math.min(CONFIG.httpMaxRetries, 2),
    });
    const parsed = MeteoraPoolsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Unexpected Meteora pool list shape: ${parsed.error.message}`);
    }
    return parsed.data.data
      .filter((pool) => {
        const pair = new Set([pool.token_x.address, pool.token_y.address]);
        return !pool.is_blacklisted
          && pool.tvl >= CONFIG.directPoolMinTvlUsdc
          && pair.has(inputMint)
          && pair.has(outputMint);
      })
      .slice(0, CONFIG.meteoraMaxPoolsPerPair)
      .map((pool) => ({
        venue: 'meteora' as const,
        address: pool.address,
        tokenMintA: pool.token_x.address,
        tokenMintB: pool.token_y.address,
        feeRate: pool.pool_config.base_fee_pct,
        poolType: `dlmm-bin-${pool.pool_config.bin_step}`,
        tvlUsdc: String(pool.tvl),
      }));
  });
}

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

export interface MeteoraSwapLeg {
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
}

export interface MeteoraSwapLegInput {
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

export async function buildMeteoraSwapLeg(input: MeteoraSwapLegInput): Promise<MeteoraSwapLeg> {
  if (input.inputAmount <= 0n) throw new Error('Meteora swap leg input must be positive');
  if (input.inputMint === input.outputMint) throw new Error('Meteora swap leg mints must differ');

  const [inputToken, outputToken] = await Promise.all([
    input.inputToken ?? analyzeMintCached(input.connection, input.inputMint),
    input.outputToken ?? analyzeMintCached(input.connection, input.outputMint),
  ]);
  if (inputToken.status !== 'SUPPORTED' || !inputToken.programId
    || inputToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error(`Meteora swap input mint ${input.inputMint} is not a supported classic SPL token`);
  }
  if (outputToken.status !== 'SUPPORTED' || !outputToken.programId
    || outputToken.programId !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error(`Meteora swap output mint ${input.outputMint} is not a supported classic SPL token`);
  }

  const [inputAta, outputAta] = await Promise.all([
    input.inputAta ?? inspectAssociatedTokenAccount(
      input.connection, input.wallet, new PublicKey(input.inputMint), TOKEN_PROGRAM_ID,
    ),
    input.outputAta ?? inspectAssociatedTokenAccount(
      input.connection, input.wallet, new PublicKey(input.outputMint), TOKEN_PROGRAM_ID,
    ),
  ]);

  const poolsMetadata = await discoverMeteoraPools(input.inputMint, input.outputMint);
  if (poolsMetadata.length === 0) throw new Error('No Meteora DLMM pool found for the swap leg pair');

  const requestTimestamp = Date.now();
  const pools = await DLMM.createMultiple(
    input.connection,
    poolsMetadata.map(p => new PublicKey(p.address)),
    { cluster: 'mainnet-beta' }
  );

  const candidates: Array<{
    pool: MeteoraDlmm;
    metadata: PoolMetadata;
    quote: any;
    binArrays: any;
  }> = [];

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i]!;
    const metadata = poolsMetadata[i]!;
    try {
      const swapForY = pool.tokenX.publicKey.toBase58() === input.inputMint;
      const binArrays = await pool.getBinArrayForSwap(swapForY, 4);
      const quote = pool.swapQuote(
        new BN(input.inputAmount.toString()),
        swapForY,
        new BN(input.slippageBps),
        binArrays,
        true
      );
      if (quote.outAmount.lte(new BN(0))) continue;
      candidates.push({ pool, metadata, quote, binArrays });
    } catch {
      // skip
    }
  }

  if (candidates.length === 0) throw new Error('No Meteora pool could produce a quote for the swap leg');
  candidates.sort((a, b) => b.quote.outAmount.cmp(a.quote.outAmount));
  const best = candidates[0]!;

  const { pool, metadata, quote } = best;

  const tx = await pool.swap({
    inToken: new PublicKey(input.inputMint),
    binArraysPubkey: quote.binArraysPubkey,
    inAmount: new BN(input.inputAmount.toString()),
    lbPair: pool.pubkey,
    user: input.wallet,
    minOutAmount: quote.minOutAmount,
    outToken: new PublicKey(input.outputMint)
  });

  const instructions = tx.instructions;

  const hash = createHash('sha256');
  for (const ix of instructions) {
    hash.update(ix.programId.toBuffer());
    for (const key of ix.keys) hash.update(key.pubkey.toBuffer());
    hash.update(ix.data);
  }

  return {
    instructions,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inputAmount: input.inputAmount,
    expectedOutput: BigInt(quote.outAmount.toString()),
    minimumOutput: BigInt(quote.minOutAmount.toString()),
    programId: pool.program.programId.toBase58(),
    instructionHash: hash.digest('hex'),
    inputAta: inputAta.ata,
    outputAta: outputAta.ata,
    quoteReceivedAt: requestTimestamp,
    pool: metadata.address,
  };
}

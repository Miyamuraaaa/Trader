import { Connection, PublicKey } from '@solana/web3.js';
import { getProviderQuote } from '../aggregators/index.js';
import { isFullFillQuote, type Quote, type QuoteProviderName } from '../aggregators/types.js';
import { CONFIG, DECIMALS, LAMPORTS_PER_SOL, MINTS } from '../config.js';
import { fromAtomic } from '../math.js';
import { calculateEstimatedRoundTripProfit, type EstimatedCostInput } from '../profit.js';
import {
  categorizeProfit,
  classifyRoute,
  classifyValidationTier,
  type RoundTripResult,
} from '../routes.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './account-preflight.js';
import {
  getCachedExecutionAta,
  getCachedExecutionMintAnalysis,
  preloadExecutionPreflight,
} from './execution-preflight-cache.js';
import {
  executableQuoteConstraints,
  isExecutableProviderPair,
  quoteMatchesExecutableProviderPolicy,
} from './executable-route-policy.js';
import { assertIntermediateTokenExecutionPolicy } from './token-analysis.js';

export type ExecutablePrefilterStatus =
  | 'EXECUTABLE_CANDIDATE'
  | 'RAW_NOT_POSITIVE'
  | 'UNSUPPORTED_PROVIDER_PAIR'
  | 'DISCOVERY_ONLY_TOKEN_2022'
  | 'TOKEN_POLICY_REJECTED'
  | 'ROUTE_POLICY_REJECTED'
  | 'ECONOMICS_DIVERGED'
  | 'QUOTE_FAILED';

export interface ScannerExecutableCostSnapshot {
  referenceSolPriceUsdc: number;
  estimatedNetworkCostsUsdc: {
    baseNetworkFeeUsdc: number;
    priorityFeeUsdc: number;
  };
}

export interface ExecutablePrefilterResult {
  status: ExecutablePrefilterStatus;
  route?: RoundTripResult;
  reason?: string;
}

// Scanner-side policy reads use the scanner RPC. The isolated executor keeps
// its own dedicated connection and repeats every execution-authorizing check.
const scannerPolicyConnection = new Connection(CONFIG.rpcUrl, 'confirmed');

function poolOverlap(a: Quote, b: Quote): boolean | null {
  const aPools = new Set(a.poolIds);
  const bPools = new Set(b.poolIds);
  if (aPools.size === 0 || bPools.size === 0) return null;
  return [...aPools].some((pool) => bPools.has(pool));
}

function scannerExecutionCosts(
  snapshot: ScannerExecutableCostSnapshot,
  missingIntermediateAtaRentLamports: number,
  intermediateMint: string,
): EstimatedCostInput {
  // Live builders currently request a 500k-CU ceiling. Charge its bounded
  // priority cost in the prefilter rather than the scanner's generic 200k-CU
  // assumption. The provider/DEX fees and price impact are already reflected
  // in the two constrained quote outputs.
  const priorityScale = Math.max(1, 500_000 / Math.max(1, CONFIG.assumedComputeUnits));
  const refundableWsolRent = intermediateMint === MINTS.SOL;
  const ataRentUsdc = refundableWsolRent ? 0
    : missingIntermediateAtaRentLamports / LAMPORTS_PER_SOL * snapshot.referenceSolPriceUsdc;
  return {
    baseNetworkFeeUsdc: snapshot.estimatedNetworkCostsUsdc.baseNetworkFeeUsdc,
    priorityFeeUsdc: snapshot.estimatedNetworkCostsUsdc.priorityFeeUsdc * priorityScale,
    ataRentUsdc,
  };
}

export async function prewarmScannerExecutionMints(mints: readonly string[]): Promise<void> {
  if (!CONFIG.botWalletAddress || mints.length === 0) return;
  await preloadExecutionPreflight(
    scannerPolicyConnection,
    new PublicKey(CONFIG.botWalletAddress),
    [MINTS.USDC, ...mints],
  );
}

async function classifyIntermediate(mint: string): Promise<{
  status: 'SUPPORTED' | 'TOKEN_2022' | 'REJECTED';
  rentLamports: number;
  reason?: string;
}> {
  if (!CONFIG.botWalletAddress) return {
    status: 'REJECTED', rentLamports: 0, reason: 'BOT_WALLET_ADDRESS is required for executable prefiltering',
  };
  const wallet = new PublicKey(CONFIG.botWalletAddress);
  const [analysis, ata] = await Promise.all([
    getCachedExecutionMintAnalysis(scannerPolicyConnection, mint),
    getCachedExecutionAta(scannerPolicyConnection, wallet, mint),
  ]);
  if (analysis.programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
    return { status: 'TOKEN_2022', rentLamports: ata.creationRentLamports };
  }
  try {
    if (analysis.programId !== TOKEN_PROGRAM_ID.toBase58()) {
      throw new Error('Intermediate mint is not classic SPL Token');
    }
    assertIntermediateTokenExecutionPolicy(analysis);
    return { status: 'SUPPORTED', rentLamports: ata.exists ? 0 : ata.creationRentLamports };
  } catch (error) {
    return {
      status: 'REJECTED', rentLamports: ata.creationRentLamports,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function constrainedQuote(
  provider: QuoteProviderName,
  inputMint: string,
  outputMint: string,
  amountAtomic: string,
): Promise<Quote> {
  const quote = await getProviderQuote(provider, {
    inputMint,
    outputMint,
    amountAtomic,
    slippageBps: CONFIG.slippageBps,
    priority: 'HIGH',
    ...executableQuoteConstraints(provider),
  });
  if (!isFullFillQuote(quote)) throw new Error(`${provider} returned a partial executable-prefilter fill`);
  if (!quoteMatchesExecutableProviderPolicy(quote)) {
    throw new Error(`${provider} quote escaped the audited executor route policy`);
  }
  return quote;
}

/**
 * Requotes a broad positive observation using the exact provider surface and
 * deterministic min-output propagation used by the live executor.
 */
export async function buildExecutableCandidateFromRaw(
  raw: RoundTripResult,
  costs: ScannerExecutableCostSnapshot,
): Promise<ExecutablePrefilterResult> {
  if (!raw.profit.estimatedNetProfitUsdc.gt(0) || !raw.profit.worstCaseNetProfitUsdc.gt(0)) {
    return { status: 'RAW_NOT_POSITIVE' };
  }
  const buyProvider = raw.buyQuote.provider;
  const sellProvider = raw.sellQuote.provider;
  if (!isExecutableProviderPair(buyProvider, sellProvider)) {
    return { status: 'UNSUPPORTED_PROVIDER_PAIR' };
  }
  let tokenPolicy: Awaited<ReturnType<typeof classifyIntermediate>>;
  try { tokenPolicy = await classifyIntermediate(raw.buyQuote.outputMint); }
  catch (error) {
    return { status: 'QUOTE_FAILED', reason: error instanceof Error ? error.message : String(error) };
  }
  if (tokenPolicy.status === 'TOKEN_2022') return { status: 'DISCOVERY_ONLY_TOKEN_2022' };
  if (tokenPolicy.status !== 'SUPPORTED') return { status: 'TOKEN_POLICY_REJECTED', reason: tokenPolicy.reason };

  try {
    const buy = await constrainedQuote(
      buyProvider, MINTS.USDC, raw.buyQuote.outputMint, raw.buyQuote.inAmount,
    );
    // The executor's second instruction consumes the first instruction's
    // enforceable minimum. This is deliberately not the optimistic outAmount.
    const sell = await constrainedQuote(
      sellProvider, raw.buyQuote.outputMint, MINTS.USDC, buy.otherAmountThreshold,
    );
    if (sell.inAmount !== buy.otherAmountThreshold) {
      return { status: 'ROUTE_POLICY_REJECTED', reason: 'Executable prefilter lost exact minimum-output propagation' };
    }
    const quoteSkewMs = Math.abs(sell.responseTimestamp - buy.responseTimestamp);
    const stale = quoteSkewMs > CONFIG.maxQuoteAgeMs;
    const liquidityOverlap = poolOverlap(buy, sell);
    if (liquidityOverlap === true) {
      return { status: 'ROUTE_POLICY_REJECTED', reason: 'Executable legs resolve to the same pool' };
    }
    const profit = calculateEstimatedRoundTripProfit(
      fromAtomic(buy.inAmount, DECIMALS.USDC).toString(),
      sell,
      scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint),
      'conservative',
    );
    const category = categorizeProfit(profit);
    const validationTier = classifyValidationTier(category, stale, liquidityOverlap, profit);
    const route: RoundTripResult = {
      buyQuote: buy,
      sellQuote: sell,
      classification: classifyRoute(buy, sell),
      liquidityOverlap,
      quoteSkewMs,
      stale,
      profit,
      category,
      validationTier,
      opportunityScope: 'EXECUTABLE_CANDIDATE',
    };
    if (validationTier !== 'CONSERVATIVE_CANDIDATE'
      || !profit.estimatedNetProfitUsdc.gt(0)
      || !profit.worstCaseNetProfitUsdc.gt(0)) {
      return { status: 'ECONOMICS_DIVERGED', route, reason: 'Executor-constrained route is not conservatively profitable' };
    }
    return { status: 'EXECUTABLE_CANDIDATE', route };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const policy = /escaped the audited|partial executable|same pool|propagation/i.test(reason);
    return { status: policy ? 'ROUTE_POLICY_REJECTED' : 'QUOTE_FAILED', reason };
  }
}

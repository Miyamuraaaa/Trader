import type { Quote } from './aggregators/types.js';
import { CONFIG, DECIMALS } from './config.js';
import { exact, fromAtomic, type ExactNumber } from './math.js';

export interface EstimatedRoundTripProfit {
  startingUsdc: ExactNumber;
  quotedFinalUsdc: ExactNumber;
  estimatedFinalUsdc: ExactNumber;
  grossProfitUsdc: ExactNumber;
  estimatedFeesUsdc: ExactNumber;
  estimatedBaseNetworkFeeUsdc: ExactNumber;
  estimatedPriorityFeeUsdc: ExactNumber;
  estimatedSlippageUsdc: ExactNumber;
  estimatedNetProfitUsdc: ExactNumber;
  worstCaseNetProfitUsdc: ExactNumber;
  profitPct: ExactNumber;
  profitBps: ExactNumber;
  mode: 'quote' | 'conservative';
}

export interface EstimatedCostInput {
  diagnosticSource?: Readonly<{ baseFeeLamports: string; priorityFeeLamports: string; ataRentLamports?: string; solPriceMicrounits: string; capturedAtWallMs: number }>;
  baseNetworkFeeUsdc: string | number;
  priorityFeeUsdc: string | number;
  ataRentUsdc?: string | number;
  otherKnownCostsUsdc?: string | number;
}

/** All values are estimates; no transaction is built, simulated, signed, or submitted. */
export function calculateEstimatedRoundTripProfit(
  startingUsdc: string | number,
  sellQuote: Quote,
  estimatedFeesUsdc: string | number | EstimatedCostInput,
  mode: 'quote' | 'conservative' = CONFIG.profitMode,
): EstimatedRoundTripProfit {
  const start = exact(startingUsdc);
  const quotedFinal = fromAtomic(sellQuote.outAmount, DECIMALS.USDC);
  const minimumFinal = fromAtomic(sellQuote.otherAmountThreshold, DECIMALS.USDC);
  const baseNetworkFee = typeof estimatedFeesUsdc === 'object'
    ? exact(estimatedFeesUsdc.baseNetworkFeeUsdc)
    : exact(estimatedFeesUsdc);
  const priorityFee = typeof estimatedFeesUsdc === 'object'
    ? exact(estimatedFeesUsdc.priorityFeeUsdc)
    : exact(0);
  const fees = baseNetworkFee.plus(priorityFee)
    .plus(typeof estimatedFeesUsdc === 'object' ? estimatedFeesUsdc.ataRentUsdc ?? 0 : 0)
    .plus(typeof estimatedFeesUsdc === 'object' ? estimatedFeesUsdc.otherKnownCostsUsdc ?? 0 : 0);
  const rawSlippageAllowance = quotedFinal.minus(minimumFinal);
  const slippageAllowance = rawSlippageAllowance.isNegative()
    ? exact(0)
    : rawSlippageAllowance;

  // outAmount already includes venue fees and price impact. In conservative mode
  // use the provider's slippage-adjusted minimum once; never subtract it twice.
  const estimatedSlippage = slippageAllowance;
  const estimatedFinal = mode === 'conservative' ? minimumFinal : quotedFinal;
  const grossProfit = quotedFinal.minus(start);
  const estimatedNet = estimatedFinal.minus(start).minus(fees);
  const worstCaseNet = minimumFinal.minus(start).minus(fees);
  const profitPct = start.isZero() ? exact(0) : estimatedNet.div(start).mul(100);
  const profitBps = profitPct.mul(100);

  return {
    startingUsdc: start,
    quotedFinalUsdc: quotedFinal,
    estimatedFinalUsdc: estimatedFinal,
    grossProfitUsdc: grossProfit,
    estimatedFeesUsdc: fees,
    estimatedBaseNetworkFeeUsdc: baseNetworkFee,
    estimatedPriorityFeeUsdc: priorityFee,
    estimatedSlippageUsdc: estimatedSlippage,
    estimatedNetProfitUsdc: estimatedNet,
    worstCaseNetProfitUsdc: worstCaseNet,
    profitPct,
    profitBps,
    mode,
  };
}

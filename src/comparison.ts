import type { ProviderQuoteResult } from './aggregators/index.js';
import { getPoolIds, getRouteLabels, isFullFillQuote } from './aggregators/types.js';
import { exact, fromAtomic } from './math.js';
import { tokenByMint } from './tokens.js';
import { getDynamicTokens } from './dynamic-token-universe.js';

function tokenInfo(mint: string): { symbol: string; decimals: number } {
  const token = tokenByMint(mint);
  if (token) return token;
  const dynamic = getDynamicTokens().find((candidate) => candidate.mint === mint);
  if (dynamic) return { symbol: dynamic.symbol, decimals: dynamic.decimals };
  return { symbol: mint.slice(0, 6) + '…', decimals: 0 };
}

export function successfulQuotes(results: ProviderQuoteResult[]) {
  return results.flatMap((result) => result.quote ? [result.quote] : []);
}

export function printQuoteComparison(
  inputMint: string,
  outputMint: string,
  amountAtomic: string,
  results: ProviderQuoteResult[],
): void {
  const input = tokenInfo(inputMint);
  const output = tokenInfo(outputMint);
  const inputAmount = fromAtomic(amountAtomic, input.decimals);
  const quotes = successfulQuotes(results);

  console.log('\n=== QUOTE COMPARISON (READ-ONLY) ===');
  console.log(`Pair: ${input.symbol} -> ${output.symbol}`);
  console.log(`Amount: ${inputAmount.toFixed()} ${input.symbol}`);

  for (const result of results) {
    const label = result.provider[0]!.toUpperCase() + result.provider.slice(1);
    console.log(`\n${label}:`);
    if (!result.quote) {
      console.log(`  Unavailable: ${result.error?.message ?? 'unknown error'}`);
      continue;
    }
    const q = result.quote;
    const outputAmount = fromAtomic(q.outAmount, output.decimals);
    const effectivePrice = inputAmount.isZero()
      ? exact(0)
      : outputAmount.div(inputAmount);
    console.log(`  Input: ${inputAmount.toFixed()} ${input.symbol}`);
    console.log(`  Output: ${outputAmount.toFixed()} ${output.symbol}`);
    console.log(`  Effective price: ${effectivePrice.toSignificantDigits(12).toString()} ${output.symbol}/${input.symbol}`);
    console.log(`  Latency: ${q.latencyMs} ms`);
    console.log(`  Route: ${getRouteLabels(q).join(' -> ') || 'direct'}`);
    const pools = getPoolIds(q);
    if (pools.length > 0) console.log(`  Pool(s): ${pools.join(', ')}`);
    if (q.feeAmount) console.log(`  Venue fee (already reflected): ${q.feeAmount} raw ${q.feeMint ?? 'units'}`);
    if (q.priceImpactPct !== undefined) console.log(`  Price impact: ${q.priceImpactPct}%`);
    if (!isFullFillQuote(q)) {
      console.log(`  PARTIAL FILL: consumed ${q.consumedInAmount} of ${q.inAmount} raw units (excluded from ranking)`);
    }
  }

  const comparable = quotes.filter(isFullFillQuote);
  if (comparable.length > 0) {
    const ranked = [...comparable].sort((a, b) => exact(b.outAmount).cmp(a.outAmount));
    const best = ranked[0]!;
    console.log(`\nBest quote: ${best.provider[0]!.toUpperCase() + best.provider.slice(1)}`);
    if (ranked.length > 1) {
      const worst = ranked[ranked.length - 1]!;
      const difference = fromAtomic(
        exact(best.outAmount).minus(worst.outAmount).toFixed(0),
        output.decimals,
      );
      console.log(`Best/worst spread: +${difference.toFixed()} ${output.symbol}`);
    } else {
      console.log('Difference: unavailable (only one provider returned a quote)');
    }
  } else {
    console.log('\nBest quote: unavailable (no full-fill quote)');
  }
  console.log('====================================\n');
}

import { CONFIG } from './config.js';
import { log } from './logger.js';
import { insertRiskRejection, type RiskRejectionRow } from './db.js';
import { type Quote, getRouteLabels, routeMatchesDexes } from './aggregators/types.js';
import { isProviderRateLimited } from './aggregators/index.js';
import type { RouteClassification } from './routes.js';

/**
 * Centralized Risk Engine (§7).
 *
 * Every paper trade must pass ALL gates. If ANY gate fails, the opportunity
 * is REJECTED — not partially accepted.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Opportunity {
  id: string;
  scanId: string;
  timestamp: string;
  buyQuote: Quote;
  sellQuote: Quote;
  tradeSizeUsdc: string;
  expectedProfitUsdc: string;
  conservativeProfitUsdc: string;
  worstCaseProfitUsdc: string;
  estimatedFeesUsdc: string;
  confidenceScore: number;
  classification?: RouteClassification;
  liquidityOverlap?: boolean | null;
}

export interface GateResult {
  gate: string;
  passed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Risk Engine
// ---------------------------------------------------------------------------

export class RiskEngine {
  /**
   * Runs ALL safety gates. Returns the list of gate results.
   * The opportunity passes ONLY if every gate passes.
   */
  static evaluate(opp: Opportunity): GateResult[] {
    const results: GateResult[] = [];
    const expectedProfit = Number(opp.expectedProfitUsdc);
    const conservativeProfit = Number(opp.conservativeProfitUsdc);
    const worstCaseProfit = Number(opp.worstCaseProfitUsdc);
    const tradeSize = Number(opp.tradeSizeUsdc);
    const now = Date.now();

    // Gate 1: Expected net profit >= minimum threshold (User explicitly requested not negative)
    // To ensure "not negative", we require expectedProfit >= 0. But we also require >= CONFIG.minNetProfitUsdc.
    const minRequiredProfit = Math.max(0, CONFIG.minNetProfitUsdc);
    results.push({
      gate: 'MIN_EXPECTED_PROFIT',
      passed: expectedProfit >= minRequiredProfit,
      reason: 'Expected profit ' + expectedProfit.toFixed(6) + ' vs min ' + minRequiredProfit,
    });

    // Gate 1.5: High confidence requested by user
    results.push({
      gate: 'MIN_CONFIDENCE',
      passed: opp.confidenceScore >= CONFIG.minConfidenceScore,
      reason: 'Confidence score ' + opp.confidenceScore.toFixed(0) + ' vs min ' + CONFIG.minConfidenceScore,
    });

    // Gate 2: Conservative net profit > configured minimum profit
    results.push({
      gate: 'MIN_CONSERVATIVE_PROFIT',
      passed: CONFIG.profitMode === 'quote' || conservativeProfit > CONFIG.minNetProfitUsdc,
      reason: CONFIG.profitMode === 'quote'
        ? 'Quote-mode paper research: conservative result remains informational: '
          + conservativeProfit.toFixed(6)
        : 'Conservative profit ' + conservativeProfit.toFixed(6) + ' vs min > ' + CONFIG.minNetProfitUsdc,
    });

    // Gate 3: Worst-case must not wipe out more than 2x the expected profit
    results.push({
      gate: 'WORST_CASE_TOLERABLE',
      passed: CONFIG.profitMode === 'quote' || worstCaseProfit >= -(expectedProfit * 2),
      reason: CONFIG.profitMode === 'quote'
        ? 'Quote-mode paper research: worst case remains displayed: ' + worstCaseProfit.toFixed(6)
        : 'Worst-case profit: ' + worstCaseProfit.toFixed(6),
    });

    // Gate 4: Conservative ROI >= configured minimum ROI
    const conservativeRoi = tradeSize > 0 ? (conservativeProfit / tradeSize) * 100 : 0;
    const conservativeRoiBps = conservativeRoi * 100;
    results.push({
      gate: 'MIN_CONSERVATIVE_ROI',
      passed: conservativeRoiBps >= CONFIG.minProfitBps,
      reason: 'Conservative ROI: ' + conservativeRoi.toFixed(4) + '% (' + conservativeRoiBps.toFixed(4)
        + ' bps) vs min ' + CONFIG.minProfitBps + ' bps',
    });

    // Gate 5: Trade size within limits
    results.push({
      gate: 'TRADE_SIZE_LIMIT',
      passed: tradeSize <= CONFIG.maxTradeSizeUsdc && tradeSize > 0,
      reason: 'Trade size ' + tradeSize + ' vs max ' + CONFIG.maxTradeSizeUsdc,
    });

    // Gate 6: Buy quote age
    const buyAge = now - opp.buyQuote.responseTimestamp;
    results.push({
      gate: 'BUY_QUOTE_FRESHNESS',
      passed: buyAge <= CONFIG.maxQuoteAgeMs,
      reason: 'Buy quote age: ' + buyAge + 'ms vs max ' + CONFIG.maxQuoteAgeMs + 'ms',
    });

    // Gate 7: Sell quote age
    const sellAge = now - opp.sellQuote.responseTimestamp;
    results.push({
      gate: 'SELL_QUOTE_FRESHNESS',
      passed: sellAge <= CONFIG.maxQuoteAgeMs,
      reason: 'Sell quote age: ' + sellAge + 'ms vs max ' + CONFIG.maxQuoteAgeMs + 'ms',
    });

    // Gate 8: Quote latency reasonable
    const maxLatency = CONFIG.httpTimeoutMs;
    results.push({
      gate: 'API_LATENCY',
      passed: opp.buyQuote.latencyMs <= maxLatency && opp.sellQuote.latencyMs <= maxLatency,
      reason: 'Buy latency: ' + opp.buyQuote.latencyMs + 'ms, Sell latency: ' + opp.sellQuote.latencyMs + 'ms',
    });

    // Gate 9: Price impact check (max 2% — tighter for arb)
    const buyImpact = opp.buyQuote.priceImpactPct === undefined
      ? undefined
      : Number(opp.buyQuote.priceImpactPct);
    const sellImpact = opp.sellQuote.priceImpactPct === undefined
      ? undefined
      : Number(opp.sellQuote.priceImpactPct);
    const impactsKnown = buyImpact !== undefined && sellImpact !== undefined;
    results.push({
      gate: 'PRICE_IMPACT',
      passed: !impactsKnown || (buyImpact <= 2 && sellImpact <= 2),
      reason: impactsKnown
        ? 'Buy impact: ' + buyImpact + '%, Sell impact: ' + sellImpact + '%'
        : 'Price impact unavailable from at least one direct venue; no precision inferred',
    });

    // Gate 10: Fee estimate available
    const feesAvailable = Number(opp.estimatedFeesUsdc) >= 0;
    results.push({
      gate: 'FEE_ESTIMATE_AVAILABLE',
      passed: feesAvailable,
      reason: 'Estimated fees: ' + opp.estimatedFeesUsdc,
    });

    // Gate 11: The providers selected for this paper route are not cooling down.
    const selectedProviderRateLimited = isProviderRateLimited(opp.buyQuote.provider)
      || isProviderRateLimited(opp.sellQuote.provider);
    results.push({
      gate: 'NO_RATE_LIMIT',
      passed: !selectedProviderRateLimited,
      reason: selectedProviderRateLimited
        ? 'A selected quote provider is currently rate-limited'
        : 'Selected providers have no active rate limit',
    });

    // Gate 12: Route validity — buy dex restriction
    if (CONFIG.buyDexes.length > 0) {
      const buyMatch = routeMatchesDexes(opp.buyQuote, CONFIG.buyDexes);
      results.push({
        gate: 'BUY_ROUTE_VALID',
        passed: buyMatch === true,
        reason: 'Buy route labels: ' + getRouteLabels(opp.buyQuote).join(', ') + ' vs required: ' + CONFIG.buyDexes.join(', '),
      });
    }

    // Gate 13: Route validity — sell dex restriction
    if (CONFIG.sellDexes.length > 0) {
      const sellMatch = routeMatchesDexes(opp.sellQuote, CONFIG.sellDexes);
      results.push({
        gate: 'SELL_ROUTE_VALID',
        passed: sellMatch === true,
        reason: 'Sell route labels: ' + getRouteLabels(opp.sellQuote).join(', ') + ' vs required: ' + CONFIG.sellDexes.join(', '),
      });
    }

    // Gate 14: Cross-venue overlap check (§13)
    if (CONFIG.buyDexes.length > 0 && CONFIG.sellDexes.length > 0) {
      const buyLabels = new Set(getRouteLabels(opp.buyQuote).map(l => l.toLowerCase()));
      const sellLabels = getRouteLabels(opp.sellQuote).map(l => l.toLowerCase());
      const hasOverlap = sellLabels.some(l => buyLabels.has(l));
      results.push({
        gate: 'CROSS_VENUE_NO_OVERLAP',
        passed: !hasOverlap,
        reason: hasOverlap ? 'Buy and sell routes share venues — not genuine cross-DEX' : 'Venues are distinct',
      });
    }

    if (opp.classification !== undefined && opp.classification !== 'DIRECT_CROSS_DEX') {
      results.push({
        gate: 'AGGREGATOR_LIQUIDITY_OVERLAP',
        passed: opp.liquidityOverlap !== true,
        reason: opp.liquidityOverlap === true
          ? 'Aggregator route overlaps the other leg liquidity venue'
          : opp.liquidityOverlap === null
            ? 'Liquidity independence is unknown; permitted for PAPER research and labeled UNKNOWN'
            : 'No venue overlap detected from route metadata',
      });
    }

    return results;
  }

  /**
   * Validate: runs evaluate() and returns true only if ALL gates pass.
   * Logs and persists rejections.
   */
  static validate(opp: Opportunity): { passed: boolean; gates: GateResult[] } {
    const gates = RiskEngine.evaluate(opp);
    const failures = gates.filter(g => !g.passed);

    if (failures.length > 0) {
      log.warn('Risk rejection for opportunity ' + opp.id, {
        failedGates: failures.map(f => f.gate),
      });

      for (const f of failures) {
        const row: RiskRejectionRow = {
          opportunityId: opp.id,
          scanId: opp.scanId,
          timestamp: new Date().toISOString(),
          gate: f.gate,
          reason: f.reason,
          details: null,
        };
        insertRiskRejection(row);
      }

      return { passed: false, gates };
    }

    return { passed: true, gates };
  }
}

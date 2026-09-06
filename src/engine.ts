import { type Opportunity, RiskEngine } from './risk.js';
import { getProviderQuote } from './aggregators/index.js';
import { type Quote, getRouteLabels } from './aggregators/types.js';
import {
  db, confirmPaperQuote, insertQuote, insertPaperTrade, updateOpportunityState, updatePaperTrade,
  insertTradeEvent, type QuoteRow,
} from './db.js';
import { log } from './logger.js';
import { CONFIG, MINTS, DECIMALS } from './config.js';
import { calculateEstimatedRoundTripProfit } from './profit.js';

/**
 * Live quote confirmation engine (§10–§11).
 *
 * Paper trading does NOT simply assume the opportunity executes.
 * It follows a full lifecycle: DETECTED → VALIDATING → REQUOTE → RISK_CHECK
 * → CONFIRMED_QUOTE (or EXPIRED). No execution result is simulated.
 */

function quoteToRow(q: Quote, scanId: string, leg: string): QuoteRow {
  return {
    id: q.id,
    scanId,
    leg,
    provider: q.provider,
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    otherAmountThreshold: q.otherAmountThreshold,
    priceImpactPct: q.priceImpactPct ?? '',
    slippageBps: q.slippageBps,
    platformFeeAmount: q.platformFee?.amount ?? null,
    platformFeeBps: q.platformFee?.feeBps ?? null,
    routeLabels: JSON.stringify(getRouteLabels(q)),
    rawResponse: q.rawResponse,
    requestTimestamp: q.requestTimestamp.toString(),
    responseTimestamp: q.responseTimestamp.toString(),
    latencyMs: q.latencyMs,
  };
}

export interface ExecutionEngine {
  confirmQuote(opp: Opportunity): Promise<'CONFIRMED_QUOTE' | 'EXPIRED' | 'RISK_REJECTED'>;
  getBalance(): number;
  getStartingBalance(): number;
  getPnl(): number;
  reset(): void;
}

/**
 * Non-paper runtimes deliberately receive an inert ledger. This prevents live
 * and dry-run startup from recovering or mutating historical paper state while
 * leaving the scanner's read-only market-data path unchanged.
 */
export class DisabledPaperExecutionEngine implements ExecutionEngine {
  async confirmQuote(_opp: Opportunity): Promise<'CONFIRMED_QUOTE' | 'EXPIRED' | 'RISK_REJECTED'> {
    throw new Error('Paper execution is disabled outside EXECUTION_MODE=paper');
  }

  getBalance(): number {
    return 0;
  }

  getStartingBalance(): number {
    return 0;
  }

  getPnl(): number {
    return 0;
  }

  reset(): void {
    // Intentionally inert: live/dry-run must never mutate the paper ledger.
  }
}

export class PaperExecutionEngine implements ExecutionEngine {
  private startingBalanceUsdc: number;
  private balanceUsdc: number;

  constructor() {
    this.startingBalanceUsdc = CONFIG.paperStartingBalanceUsdc;
    this.balanceUsdc = this.startingBalanceUsdc;
    this.recover();
  }

  reset(): void {
    this.balanceUsdc = this.startingBalanceUsdc;
  }

  getBalance(): number {
    return this.balanceUsdc;
  }

  getStartingBalance(): number {
    return this.startingBalanceUsdc;
  }

  getPnl(): number {
    return this.balanceUsdc - this.startingBalanceUsdc;
  }

  private recover(): void {
    const row = db.prepare(
      "SELECT COALESCE(SUM(CAST(realized_pnl_usdc AS REAL)), 0) AS total FROM paper_trades WHERE status = 'COMPLETED' AND realized_pnl_usdc IS NOT NULL",
    ).get() as { total: number } | undefined;
    if (row) this.balanceUsdc = this.startingBalanceUsdc + row.total;

    // Mark interrupted quote confirmations. Historical random simulation rows
    // are deliberately not recovered into the live detector.
    db.prepare(
      "UPDATE paper_trades SET status = 'EXPIRED', rejection_reason = 'Process restart — quote confirmation was in-flight' WHERE status NOT IN ('COMPLETED', 'CONFIRMED_QUOTE', 'RISK_REJECTED', 'EXPIRED')"
    ).run();

    log.info('Paper reference balance recovered (confirmed quotes are not realized P&L)', {
      balance: this.balanceUsdc.toFixed(4),
      pnl: this.getPnl().toFixed(4),
    });
  }

  private transition(tradeId: string, from: string | null, to: string, details: string | null): void {
    insertTradeEvent(tradeId, new Date().toISOString(), from, to, details);
  }

  async confirmQuote(opp: Opportunity): Promise<'CONFIRMED_QUOTE' | 'EXPIRED' | 'RISK_REJECTED'> {
    const tradeId = opp.id + '-pt';
    const tradeSize = Number(opp.tradeSizeUsdc);

    // DETECTED
    insertPaperTrade(tradeId, opp.id, new Date().toISOString(), 'LIVE_QUOTED', opp.tradeSizeUsdc);
    this.transition(tradeId, null, 'LIVE_QUOTED', null);

    // VALIDATING — require a separate market observation after a short delay.
    this.transition(tradeId, 'LIVE_QUOTED', 'VALIDATING', 'Waiting ' + CONFIG.confirmationDelayMs + 'ms before independent requote');
    await new Promise(r => setTimeout(r, CONFIG.confirmationDelayMs));

    // REQUOTE — fetch fresh quotes (§8, §11)
    this.transition(tradeId, 'VALIDATING', 'REQUOTE', 'Fetching fresh quotes');

    let freshBuy: Quote | undefined;
    let freshSell: Quote | undefined;
    let requoteError: string | null = null;

    // Bounded requote loop. Each provider also applies its own pacing/backoff.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        freshBuy = await getProviderQuote(opp.buyQuote.provider, {
          inputMint: opp.buyQuote.inputMint,
          outputMint: opp.buyQuote.outputMint,
          amountAtomic: opp.buyQuote.inAmount,
          slippageBps: CONFIG.slippageBps,
          dexes: CONFIG.buyDexes.length > 0 ? CONFIG.buyDexes : undefined,
          priority: 'HIGH',
        });
        insertQuote(quoteToRow(freshBuy, opp.scanId, 'BUY_REQUOTE'));

        freshSell = await getProviderQuote(opp.sellQuote.provider, {
          inputMint: freshBuy.outputMint,
          outputMint: opp.sellQuote.outputMint,
          amountAtomic: freshBuy.outAmount, // exact SOL output from buy leg (§4)
          slippageBps: CONFIG.slippageBps,
          dexes: CONFIG.sellDexes.length > 0 ? CONFIG.sellDexes : undefined,
          priority: 'HIGH',
        });
        insertQuote(quoteToRow(freshSell, opp.scanId, 'SELL_REQUOTE'));
        
        requoteError = null; // Success!
        break; // Exit retry loop
      } catch (err: unknown) {
        requoteError = err instanceof Error ? err.message : String(err);
        if (requoteError.includes('429') || requoteError.includes('rate-limited')) {
          const waitMs = Math.min(8000, 1000 * 2 ** (attempt - 1));
          log.warn(`Requote rate-limited (attempt ${attempt}/3), backing off for ${waitMs}ms...`, { tradeId });
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          break; // Don't retry non-429 errors
        }
      }
    }

    if (!freshBuy || !freshSell || requoteError) {
      updatePaperTrade(tradeId, 'EXPIRED', 'Requote failed: ' + requoteError, null, null, null, null);
      this.transition(tradeId, 'REQUOTE', 'EXPIRED', requoteError);
      log.warn('Paper trade expired during requote: ' + tradeId, { error: requoteError });
      const expiredAt = new Date().toISOString();
      updateOpportunityState(opp.id, 'EXPIRED', null, expiredAt, Date.now() - Date.parse(opp.timestamp));
      return 'EXPIRED';
    }

    const freshProfit = calculateEstimatedRoundTripProfit(
      tradeSize,
      freshSell,
      Number(opp.estimatedFeesUsdc),
    );
    const freshExpected = freshProfit.estimatedNetProfitUsdc.toNumber();

    // RISK_CHECK — verify requoted prices still show profit (§7, §8)
    // The full risk engine already validated the initial opportunity.
    // On requote, we only check that the trade is still net-positive.
    // This matches real-world behavior: you commit after the initial check,
    // and only abort if the requote shows the opportunity completely vanished.
    this.transition(tradeId, 'REQUOTE', 'RISK_CHECK', 'freshExpected: ' + freshExpected.toFixed(6));

    if (freshExpected <= 0) {
      updatePaperTrade(tradeId, 'EXPIRED', 'Opportunity disappeared after requote (expected: ' + freshExpected.toFixed(6) + ')', null, null, null, null);
      this.transition(tradeId, 'RISK_CHECK', 'EXPIRED', 'Negative profit after requote: ' + freshExpected.toFixed(6));
      const expiredAt = new Date().toISOString();
      updateOpportunityState(opp.id, 'EXPIRED', null, expiredAt, Date.now() - Date.parse(opp.timestamp));
      return 'EXPIRED';
    }

    const confirmedAt = new Date().toISOString();
    const confirmationLatencyMs = Date.now() - Date.parse(opp.timestamp);
    confirmPaperQuote(
      tradeId,
      freshProfit.estimatedNetProfitUsdc.toString(),
      confirmationLatencyMs,
      freshBuy.id,
      freshSell.id,
    );
    updateOpportunityState(opp.id, 'CONFIRMED_QUOTE', confirmedAt, null, confirmationLatencyMs);
    this.transition(tradeId, 'RISK_CHECK', 'CONFIRMED_QUOTE', 'Quoted net: ' + freshExpected.toFixed(6));
    log.info('Live quote independently confirmed (READ-ONLY)', {
      tradeId,
      confirmedQuotedNet: freshExpected.toFixed(6),
      confirmationLatencyMs,
    });
    return 'CONFIRMED_QUOTE';
  }
}

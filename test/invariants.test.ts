import { describe, it, expect } from 'vitest';
import { exact, toAtomic, fromAtomic } from '../src/math.js';
import { type Opportunity, RiskEngine } from '../src/risk.js';
import { CONFIG } from '../src/config.js';

describe('Decimal Math', () => {
    it('does not lose precision with large lamport values', () => {
        const largeVal = '1000000000000000000';
        const decimals = 9;
        const atomic = toAtomic(largeVal, decimals);
        expect(atomic).toBe('1000000000000000000000000000');
        const back = fromAtomic(atomic, decimals);
        expect(back.toString()).toBe('1000000000000000000');
    });
});

describe('Risk Engine Invariants', () => {
    const mockQuote = {
        provider: 'jupiter' as const,
        id: '1', requestTimestamp: 1000, responseTimestamp: 1000, latencyMs: 0, rawResponse: '',
        inputMint: 'a', outputMint: 'b', inAmount: '10', outAmount: '20', otherAmountThreshold: '19',
        consumedInAmount: '10', isPartialFill: false, poolIds: [],
        swapMode: 'ExactIn' as const, slippageBps: 50, priceImpactPct: '0.01', platformFee: null, routePlan: []
    };

    it('rejects stale quotes', () => {
        const opp: Opportunity = {
            id: 'opp1',
            scanId: 'scan1',
            timestamp: new Date().toISOString(),
            buyQuote: { ...mockQuote, responseTimestamp: Date.now() - 50000 }, 
            sellQuote: { ...mockQuote, responseTimestamp: Date.now() },
            tradeSizeUsdc: '100',
            expectedProfitUsdc: '5',
            conservativeProfitUsdc: '2',
            worstCaseProfitUsdc: '1',
            estimatedFeesUsdc: '0.01',
            confidenceScore: 50
        };

        const result = RiskEngine.validate(opp);
        expect(result.passed).toBe(false); 
    });

    it('treats conservative profit according to PROFIT_MODE', () => {
        const opp: Opportunity = {
            id: 'opp2',
            scanId: 'scan2',
            timestamp: new Date().toISOString(),
            buyQuote: { ...mockQuote, responseTimestamp: Date.now() }, 
            sellQuote: { ...mockQuote, responseTimestamp: Date.now() },
            tradeSizeUsdc: '100',
            expectedProfitUsdc: '1',
            conservativeProfitUsdc: '-0.1', 
            worstCaseProfitUsdc: '-1',
            estimatedFeesUsdc: '0.01',
            confidenceScore: 50
        };

        const gates = RiskEngine.evaluate(opp);
        const conservativeGate = gates.find((gate) => gate.gate === 'MIN_CONSERVATIVE_PROFIT');
        expect(conservativeGate?.passed).toBe(CONFIG.profitMode === 'quote');
    });

    it('rejects trade size above hard limit', () => {
        const opp: Opportunity = {
            id: 'opp3',
            scanId: 'scan3',
            timestamp: new Date().toISOString(),
            buyQuote: { ...mockQuote, responseTimestamp: Date.now() }, 
            sellQuote: { ...mockQuote, responseTimestamp: Date.now() },
            tradeSizeUsdc: '15000', 
            expectedProfitUsdc: '100',
            conservativeProfitUsdc: '50', 
            worstCaseProfitUsdc: '10',
            estimatedFeesUsdc: '0.01',
            confidenceScore: 50
        };

        const result = RiskEngine.validate(opp);
        expect(result.passed).toBe(false);
    });
});

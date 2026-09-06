import { CONFIG } from './config.js';
import { getDynamicTokens, type TokenUniverseTier } from './dynamic-token-universe.js';
import { TOKENS, type TokenSymbol } from './tokens.js';

export interface ScanCycle {
  startingToken: 'USDC';
  intermediateToken: string;
  inputMint: string;
  intermediateMint: string;
  outputMint: string;
  path: string[];
  key: string;
  tier: 'CORE' | TokenUniverseTier;
  decimals: number;
}

/**
 * Conservative, trusted token universe. Expanded discovery intentionally
 * falls back to these canonical assets until a trustworthy liquidity and
 * token-risk feed is configured; it never guesses or scrapes random mints.
 */
export function getScanCycles(): ScanCycle[] {
  if (!CONFIG.scanTokens.includes('USDC')) return [];
  const core: ScanCycle[] = CONFIG.scanTokens
    .filter((symbol): symbol is Exclude<TokenSymbol, 'USDC'> => symbol !== 'USDC')
    .map((symbol) => ({
      startingToken: 'USDC' as const,
      intermediateToken: symbol,
      inputMint: TOKENS.USDC.mint,
      intermediateMint: TOKENS[symbol].mint,
      outputMint: TOKENS.USDC.mint,
      path: ['USDC', symbol, 'USDC'],
      key: `USDC:${symbol}:USDC`,
      tier: 'CORE' as const,
      decimals: TOKENS[symbol].decimals,
    }));
  if (CONFIG.discoveryMode !== 'expanded' && CONFIG.scanMode !== 'hot') return core;
  const dynamic = getDynamicTokens().map((token) => ({
    startingToken: 'USDC' as const,
    intermediateToken: token.symbol,
    inputMint: TOKENS.USDC.mint,
    intermediateMint: token.mint,
    outputMint: TOKENS.USDC.mint,
    path: ['USDC', token.symbol, 'USDC'],
    key: `USDC:${token.mint}:USDC`,
    tier: token.tier,
    decimals: token.decimals,
  }));
  return [...core, ...dynamic];
}

export function cycleForPair(inputMint: string, outputMint: string): ScanCycle | undefined {
  return getScanCycles().find((cycle) =>
    (cycle.inputMint === inputMint && cycle.intermediateMint === outputMint)
    || (cycle.inputMint === outputMint && cycle.intermediateMint === inputMint),
  );
}

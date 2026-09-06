export const TOKENS = {
  SOL: {
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
  },
  USDC: {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  },
  USDT: {
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
  },
} as const;

export type TokenSymbol = keyof typeof TOKENS;

export const MINTS = {
  SOL: TOKENS.SOL.mint,
  USDC: TOKENS.USDC.mint,
  USDT: TOKENS.USDT.mint,
} as const;

export const DECIMALS = {
  SOL: TOKENS.SOL.decimals,
  USDC: TOKENS.USDC.decimals,
  USDT: TOKENS.USDT.decimals,
} as const;

const BY_MINT = new Map<string, { symbol: TokenSymbol; mint: string; decimals: number }>(
  Object.values(TOKENS).map((token) => [token.mint, token]),
);

export function tokenByMint(mint: string): { symbol: TokenSymbol; mint: string; decimals: number } | undefined {
  return BY_MINT.get(mint);
}

export function parseTokenAllowlist(symbols: string[]): TokenSymbol[] {
  return symbols.map((value) => {
    const symbol = value.toUpperCase();
    if (!(symbol in TOKENS)) {
      throw new Error(`Unsupported SCAN_TOKENS entry ${value}; supported: ${Object.keys(TOKENS).join(',')}`);
    }
    return symbol as TokenSymbol;
  });
}

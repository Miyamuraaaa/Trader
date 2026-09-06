import { PublicKey, Connection } from '@solana/web3.js';
import { z } from 'zod';
import { CONFIG } from './config.js';
import { getJupiterJson } from './jupiter.js';
import { log } from './logger.js';
import { recordRpcRequests, rpcMetrics } from './solana.js';
import { runScannerRpc } from './scanner-rpc-limiter.js';
import { MINTS } from './tokens.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SUPPORTED_TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

const StatsSchema = z.object({
  priceChange: z.number().nullish(),
  volumeChange: z.number().nullish(),
  buyVolume: z.number().nullish(),
  sellVolume: z.number().nullish(),
  numTraders: z.number().nullish(),
}).passthrough();

const DiscoveredTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(18),
  tokenProgram: z.string(),
  liquidity: z.number().nullish(),
  organicScore: z.number().nullish(),
  organicScoreLabel: z.enum(['high', 'medium', 'low']).nullish(),
  isVerified: z.boolean().nullish(),
  mintAuthority: z.string().nullish(),
  freezeAuthority: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  audit: z.object({
    mintAuthorityDisabled: z.boolean().nullish(),
    freezeAuthorityDisabled: z.boolean().nullish(),
    isSus: z.boolean().nullish(),
  }).passthrough().nullish(),
  stats5m: StatsSchema.nullish(),
  stats24h: StatsSchema.nullish(),
  updatedAt: z.string().nullish(),
}).passthrough();

const DiscoveredTokenArraySchema = z.array(DiscoveredTokenSchema);
type RawDiscoveredToken = z.infer<typeof DiscoveredTokenSchema>;

export type TokenUniverseTier = 'HOT' | 'WARM' | 'DISCOVERY';

export interface DynamicToken {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  tokenProgram: string;
  tier: TokenUniverseTier;
  discoveryScore: number;
  liquidityUsdc: number;
  volume24hUsdc: number;
  organicScore: number;
  traders5m: number;
  verified: boolean;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  executionPrecheck: 'PASS' | 'FAIL' | 'UNKNOWN';
  sources: string[];
  discoveredAt: number;
}

const tokens = new Map<string, DynamicToken>();
let refreshTimer: NodeJS.Timeout | undefined;
let refreshPromise: Promise<DynamicToken[]> | undefined;

export const dynamicUniverseStats = {
  lastRefreshAt: 0,
  refreshes: 0,
  failures: 0,
  sourceRequests: 0,
};

function volume24h(token: RawDiscoveredToken): number {
  return Math.max(0, token.stats24h?.buyVolume ?? 0) + Math.max(0, token.stats24h?.sellVolume ?? 0);
}

function logScale(value: number, ceilingPower: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, Math.log10(value + 1) / ceilingPower);
}

/**
 * Deterministic market-quality score. Social fields are deliberately excluded.
 * It weights usable liquidity and real trading activity most heavily, followed
 * by Jupiter's organic score, recent trader breadth, and verified metadata.
 * This is a discovery priority only; it never grants execution permission.
 */
function discoveryScore(token: RawDiscoveredToken): number {
  const liquidity = Math.max(0, token.liquidity ?? 0);
  const volume = volume24h(token);
  const organic = Math.max(0, Math.min(100, token.organicScore ?? 0)) / 100;
  const traders = Math.max(0, token.stats5m?.numTraders ?? 0);
  return 100 * (
    0.30 * logScale(liquidity, 8)
    + 0.30 * logScale(volume, 9)
    + 0.25 * organic
    + 0.10 * logScale(traders, 5)
    + 0.05 * (token.isVerified === true ? 1 : 0)
  );
}

function isDenied(token: RawDiscoveredToken): boolean {
  const denied = new Set(CONFIG.tokenDenylist.map((value) => value.toLowerCase()));
  return denied.has(token.id.toLowerCase())
    || denied.has(token.symbol.toLowerCase())
    || token.tags?.some((tag) => tag.toLowerCase() === 'banned') === true
    || token.audit?.isSus === true;
}

function isAllowed(token: RawDiscoveredToken): boolean {
  if (CONFIG.tokenAllowlist.length === 0) return true;
  const allowed = new Set(CONFIG.tokenAllowlist.map((value) => value.toLowerCase()));
  return allowed.has(token.id.toLowerCase()) || allowed.has(token.symbol.toLowerCase());
}

async function fetchCategory(category: 'toptrending' | 'toptraded' | 'toporganicscore') {
  const url = new URL(`https://api.jup.ag/tokens/v2/${category}/5m`);
  url.searchParams.set('limit', String(CONFIG.dynamicDiscoverySourceLimit));
  dynamicUniverseStats.sourceRequests++;
  const raw = await getJupiterJson<unknown>(url.toString(), `tokens:${category}`);
  return DiscoveredTokenArraySchema.parse(raw);
}

async function verifyOnChain(candidates: RawDiscoveredToken[]): Promise<RawDiscoveredToken[]> {
  if (candidates.length === 0) return [];
  const connection = new Connection(rpcMetrics.activeEndpoint, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  recordRpcRequests();
  const accounts = await runScannerRpc(
    'scanner.discovery.verifyDynamicMints',
    () => connection.getMultipleAccountsInfo(
      candidates.map((token) => new PublicKey(token.id)),
      'confirmed',
    ),
    'LOW',
  );
  return candidates.filter((token, index) => {
    const account = accounts[index];
    if (!account || account.data.length < 45) return false;
    const owner = account.owner.toBase58();
    return SUPPORTED_TOKEN_PROGRAMS.has(owner)
      && owner === token.tokenProgram
      && account.data[44] === token.decimals;
  });
}

function preliminaryExecutionStatus(token: RawDiscoveredToken): 'PASS' | 'FAIL' | 'UNKNOWN' {
  if (!SUPPORTED_TOKEN_PROGRAMS.has(token.tokenProgram)) return 'FAIL';
  if (token.audit?.isSus === true || token.isVerified === false) return 'FAIL';
  if (token.mintAuthority !== null && token.mintAuthority !== undefined) return 'FAIL';
  if (token.freezeAuthority !== null && token.freezeAuthority !== undefined) return 'FAIL';
  if (token.audit?.mintAuthorityDisabled !== true || token.audit?.freezeAuthorityDisabled !== true) {
    return 'UNKNOWN';
  }
  // Token-2022 extensions still require instruction-level inspection later.
  return token.tokenProgram === TOKEN_2022_PROGRAM_ID ? 'UNKNOWN' : 'PASS';
}

export async function refreshDynamicTokenUniverse(): Promise<DynamicToken[]> {
  if (CONFIG.discoveryMode !== 'expanded' && CONFIG.scanMode !== 'hot') return [];
  if (!CONFIG.jupiterApiKey) {
    log.warn('Dynamic discovery requires the configured Jupiter API key; retaining core tokens');
    return [];
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const settled = await Promise.allSettled([
        fetchCategory('toptrending'),
        fetchCategory('toptraded'),
        fetchCategory('toporganicscore'),
      ]);
      if (!settled.some((result) => result.status === 'fulfilled')) {
        const reasons = settled.map((result) => result.status === 'rejected'
          ? result.reason instanceof Error ? result.reason.message : String(result.reason)
          : 'ok');
        throw new Error(`All Jupiter discovery feeds failed: ${reasons.join(' | ')}`);
      }
      const merged = new Map<string, { token: RawDiscoveredToken; sources: Set<string> }>();
      const sourceNames = ['toptrending', 'toptraded', 'toporganicscore'];
      settled.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        for (const token of result.value) {
          const existing = merged.get(token.id);
          if (existing) existing.sources.add(sourceNames[index]!);
          else merged.set(token.id, { token, sources: new Set([sourceNames[index]!]) });
        }
      });

      const coreMints = new Set(Object.values(MINTS));
      const filtered = [...merged.values()]
        .filter(({ token }) => !coreMints.has(token.id as (typeof MINTS)[keyof typeof MINTS]))
        .filter(({ token }) => {
          try { new PublicKey(token.id); return true; } catch { return false; }
        })
        .filter(({ token }) => isAllowed(token) && !isDenied(token))
        .filter(({ token }) => SUPPORTED_TOKEN_PROGRAMS.has(token.tokenProgram))
        .filter(({ token }) => (token.liquidity ?? 0) >= CONFIG.minTokenLiquidityUsdc)
        .filter(({ token }) => volume24h(token) >= CONFIG.minTokenVolume24hUsdc)
        .sort((a, b) => discoveryScore(b.token) - discoveryScore(a.token));

      const verified = await verifyOnChain(filtered.map((entry) => entry.token));
      const verifiedMints = new Set(verified.map((token) => token.id));
      const selected = filtered.filter((entry) => verifiedMints.has(entry.token.id))
        .slice(0, CONFIG.dynamicDiscoveryLimit);
      tokens.clear();
      selected.forEach(({ token, sources }, index) => {
        const tier: TokenUniverseTier = index < Math.max(2, Math.ceil(selected.length / 3))
          ? 'HOT'
          : index < Math.max(4, Math.ceil(selected.length * 2 / 3)) ? 'WARM' : 'DISCOVERY';
        tokens.set(token.id, {
          mint: token.id,
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals,
          tokenProgram: token.tokenProgram,
          tier,
          discoveryScore: discoveryScore(token),
          liquidityUsdc: token.liquidity ?? 0,
          volume24hUsdc: volume24h(token),
          organicScore: token.organicScore ?? 0,
          traders5m: token.stats5m?.numTraders ?? 0,
          verified: token.isVerified === true,
          mintAuthorityDisabled: token.audit?.mintAuthorityDisabled ?? null,
          freezeAuthorityDisabled: token.audit?.freezeAuthorityDisabled ?? null,
          executionPrecheck: preliminaryExecutionStatus(token),
          sources: [...sources],
          discoveredAt: Date.now(),
        });
      });
      dynamicUniverseStats.lastRefreshAt = Date.now();
      dynamicUniverseStats.refreshes++;
      log.info('Dynamic token universe refreshed from live Jupiter market data', {
        candidates: merged.size,
        selected: tokens.size,
        hot: [...tokens.values()].filter((token) => token.tier === 'HOT').length,
      });
      return getDynamicTokens();
    } catch (error) {
      dynamicUniverseStats.failures++;
      log.warn('Dynamic token discovery failed; retaining the existing/core universe', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return getDynamicTokens();
    } finally {
      refreshPromise = undefined;
    }
  })();
  return refreshPromise;
}

export function getDynamicTokens(): DynamicToken[] {
  return [...tokens.values()].sort((a, b) => b.discoveryScore - a.discoveryScore);
}

export function startDynamicTokenDiscovery(): void {
  if (refreshTimer || (CONFIG.discoveryMode !== 'expanded' && CONFIG.scanMode !== 'hot')) return;
  refreshTimer = setInterval(() => {
    void refreshDynamicTokenUniverse();
  }, CONFIG.dynamicDiscoveryRefreshMs);
  refreshTimer.unref();
}

export function stopDynamicTokenDiscovery(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
}

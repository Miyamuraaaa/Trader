import { CONFIG } from '../config.js';
import {
  getQuote as getJupiterQuote,
  isRateLimited as isJupiterRateLimited,
  jupiterStats,
} from '../jupiter.js';
import { log } from '../logger.js';
import { raptorProvider } from '../raptor.js';
import { raydiumProvider } from '../raydium.js';
import { orcaProvider } from '../orca.js';
import { meteoraProvider } from '../meteora.js';
import type { Quote, QuoteParams, QuoteProvider, QuoteProviderName } from './types.js';

const jupiterProvider: QuoteProvider = {
  name: 'jupiter',
  kind: 'aggregator',
  capabilities: {
    quote: true,
    dryRun: false,
    execution: false,
    streaming: false,
    atomicCycle: false,
  },
  supportsPair: async (inputMint, outputMint) => inputMint !== outputMint,
  health: () => ({
    state: isJupiterRateLimited()
      ? 'COOLDOWN'
      : jupiterStats.otherErrors > 0 && jupiterStats.successfulRequests === 0
        ? 'UNAVAILABLE'
        : jupiterStats.otherErrors > 0 ? 'DEGRADED' : 'HEALTHY',
    requests: jupiterStats.requestsSinceStartup,
    successes: jupiterStats.successfulRequests,
    failures: jupiterStats.otherErrors,
    rateLimits429: jupiterStats.rateLimits429,
    averageLatencyMs: jupiterStats.avgLatencyMs,
    circuitOpen: isJupiterRateLimited(),
  }),
  getQuote: getJupiterQuote,
  isRateLimited: isJupiterRateLimited,
};

export interface ProviderQuoteResult {
  provider: QuoteProviderName;
  quote?: Quote;
  error?: Error;
}

export function getEnabledProviders(): QuoteProvider[] {
  const providers: QuoteProvider[] = [];
  if (CONFIG.enableJupiter) providers.push(jupiterProvider);
  if (CONFIG.enableRaptor) providers.push(raptorProvider);
  if (CONFIG.enableRaydium) providers.push(raydiumProvider);
  if (CONFIG.enableOrca) providers.push(orcaProvider);
  if (CONFIG.enableMeteora) providers.push(meteoraProvider);
  return providers;
}

export function getProvider(name: QuoteProviderName): QuoteProvider {
  const providers: Record<QuoteProviderName, QuoteProvider | undefined> = {
    jupiter: jupiterProvider,
    raptor: raptorProvider,
    raydium: raydiumProvider,
    orca: orcaProvider,
    meteora: meteoraProvider,
  };
  const enabledByName: Record<QuoteProviderName, boolean> = {
    jupiter: CONFIG.enableJupiter,
    raptor: CONFIG.enableRaptor,
    raydium: CONFIG.enableRaydium,
    orca: CONFIG.enableOrca,
    meteora: CONFIG.enableMeteora,
  };
  const provider = providers[name];
  if (!provider) throw new Error(`${name} quote provider is not installed`);
  const enabled = enabledByName[name];
  if (!enabled) throw new Error(`${name} quote provider is disabled`);
  return provider;
}

export async function getProviderQuote(
  provider: QuoteProviderName,
  params: QuoteParams,
): Promise<Quote> {
  return getProvider(provider).getQuote(params);
}

export async function getQuotesFromEnabledProviders(
  params: QuoteParams,
): Promise<ProviderQuoteResult[]> {
  const providers = getEnabledProviders();
  return getQuotesFromProviders(providers, params);
}

export async function getQuotesFromProviders(
  providers: QuoteProvider[],
  params: QuoteParams,
): Promise<ProviderQuoteResult[]> {
  const settled = await Promise.allSettled(providers.map(async (provider) => {
    // A provider already in cooldown cannot contribute a fresh discovery quote.
    // Skip it before pair discovery so one degraded direct provider cannot hold
    // the entire five-provider first-leg Promise.allSettled open.
    if (provider.isRateLimited()) {
      throw new Error(`${provider.name} provider is cooling down`);
    }
    if (!await provider.supportsPair(params.inputMint, params.outputMint)) {
      throw new Error(`${provider.name} does not support this pair`);
    }
    return provider.getQuote(params);
  }));

  return settled.map((result, index) => {
    const provider = providers[index]!;
    if (result.status === 'fulfilled') {
      return { provider: provider.name, quote: result.value };
    }
    const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    const expectedBackpressure = /cooling down|scanner rpc backpressure/i.test(error.message);
    (expectedBackpressure ? log.debug : log.warn)(
      `${provider.name} quote unavailable; continuing with other providers`,
      { reason: error.message },
    );
    return { provider: provider.name, error };
  });
}

export function isProviderRateLimited(name: QuoteProviderName): boolean {
  return getProvider(name).isRateLimited();
}

export function getProviderCapabilities() {
  return getEnabledProviders().map((provider) => ({
    provider: provider.name,
    type: provider.kind,
    ...provider.capabilities,
  }));
}

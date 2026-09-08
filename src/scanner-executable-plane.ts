import type { QuoteProvider, QuoteParams } from './aggregators/types.js';
import { executableQuoteConstraints, isExecutableProviderPair } from './execution/executable-route-policy.js';

/** Scheduling restriction only. Never confers execution authority or substitutes for fresh validation. */
export function executableSurfaceProvider(provider: QuoteProvider, peers: readonly QuoteProvider[], eligibleMetadata: boolean): QuoteProvider {
  const supported = eligibleMetadata && peers.some((peer) => isExecutableProviderPair(provider.name, peer.name));
  return { ...provider, getQuote: (params: QuoteParams) => provider.getQuote(supported
    ? { ...params, ...executableQuoteConstraints(provider.name), priority: 'DISCOVERY_HIGH' }
    : { ...params, priority: 'DISCOVERY_LOW' }) };
}

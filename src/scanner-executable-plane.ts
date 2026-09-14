import type { QuoteProvider, QuoteParams } from './aggregators/types.js';
import { executableQuoteConstraints, isExecutableProviderPair } from './execution/executable-route-policy.js';
import { measuredProviderCall } from './economics/opportunity-quality.js';
import type { SourceLane } from './execution/source-lane.js';

/** Scheduling restriction only. Never confers execution authority or substitutes for fresh validation. */
export function executableSurfaceProvider(provider: QuoteProvider, peers: readonly QuoteProvider[], eligibleMetadata: boolean, sourceLane: SourceLane = eligibleMetadata ? 'EXECUTABLE_FAST_LANE' : 'BROAD_MATRIX'): QuoteProvider {
  const supported = eligibleMetadata && peers.some((peer) => isExecutableProviderPair(provider.name, peer.name));
  return { ...provider, getQuote: (params: QuoteParams) => measuredProviderCall(sourceLane, provider.name, () => provider.getQuote(supported
    ? { ...params, ...executableQuoteConstraints(provider.name), priority: 'DISCOVERY_HIGH' }
    : { ...params, priority: 'DISCOVERY_LOW' })) };
}

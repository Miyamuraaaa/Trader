/** Exact, deliberately bounded first direct-Ray­dium capability; never generic venue support. */
export const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
export const RAYDIUM_CAPABILITY = Object.freeze({
  providerPair: 'raptor:raydium', family: 'CLMM', programId: RAYDIUM_CLMM_PROGRAM,
  instruction: 'swap', builderVersion: 1, inspectorVersion: 1, planSchemaVersion: 1,
  fingerprintVersion: 2, tokenPolicy: 'classic-spl-only', mode: 'ExactIn', pools: 1,
  mathSurface: 'static-input-fee-current-spacing-cell-no-crossing',
  firstLegAdapter: 'raptor-v1-single-raydium-clmm-no-fee-no-proxy',
  accountSetup: 'existing-non-native-atas-only',
});
export const RAYDIUM_ADAPTER_ID = 'raydium:clmm:swap:static-cell:builder1:inspector1:plan1:fp2';

// Bounded advisory family hints only; never pool state/quote/authority caching.
const hints=new Map<string,number>();
export function rememberRaydiumClmmPool(pool:string,now=Date.now()):void{
  hints.delete(pool);hints.set(pool,now);while(hints.size>256)hints.delete(hints.keys().next().value!);
}
export function raydiumClmmHint(pool:string,now=Date.now()):string|undefined{
  const at=hints.get(pool);if(at===undefined)return undefined;
  if(now<at||now-at>60000){hints.delete(pool);return undefined;}return RAYDIUM_CLMM_PROGRAM;
}

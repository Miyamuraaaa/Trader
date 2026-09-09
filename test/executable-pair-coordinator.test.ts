import { afterEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({quote:vi.fn(),policy:vi.fn(),forecast:vi.fn()}));
vi.mock('../src/aggregators/index.js',()=>({getProviderQuote:mocks.quote}));
vi.mock('../src/execution/scanner-executable-prefilter.js',()=>({classifyIntermediate:mocks.policy}));
vi.mock('../src/jupiter.js',()=>({jupiterAdmission:{forecast:mocks.forecast}}));
vi.mock('../src/raptor.js',()=>({raptorAdmission:{forecast:mocks.forecast}}));
import { ExecutablePairCoordinator } from '../src/executable-pair-coordinator.js';
import { CONFIG,MINTS } from '../src/config.js';
import type { RoundTripResult } from '../src/routes.js';
import type { Quote } from '../src/aggregators/types.js';
const costs={referenceSolPriceUsdc:150,estimatedNetworkCostsUsdc:{baseNetworkFeeUsdc:.001,priorityFeeUsdc:0}};
function fixture():RoundTripResult {
  const q=(provider:'jupiter'|'raptor'):Quote=>({provider,id:provider,inputMint:provider==='jupiter'?MINTS.USDC:MINTS.SOL,outputMint:provider==='jupiter'?MINTS.SOL:MINTS.USDC,
    inAmount:provider==='jupiter'?'50000':'1000',outAmount:provider==='jupiter'?'1000':'70000',otherAmountThreshold:provider==='jupiter'?'990':'69000',isPartialFill:false,swapMode:'ExactIn',slippageBps:5,
    poolIds:[provider],routePlan:[{swapInfo:{label:provider==='jupiter'?'Whirlpool':'Raydium CLMM',programId:provider==='jupiter'?'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'}}],requestTimestamp:Date.now()-1600,responseTimestamp:Date.now()-(provider==='jupiter'?1500:100),latencyMs:0,rawResponse:'TEST'});
  return {buyQuote:q('jupiter'),sellQuote:q('raptor'),diagnosticSignalId:'old'} as RoundTripResult;
}
const originalCap=CONFIG.firstLiveMaxInputUsdc;
afterEach(()=>{CONFIG.firstLiveMaxInputUsdc=originalCap;vi.restoreAllMocks();vi.clearAllMocks();});
it('refreshes older evidence, preserves exact chain, creates new identity and suppresses repeated triggers',async()=>{
  CONFIG.firstLiveMaxInputUsdc=.05;mocks.policy.mockResolvedValue({status:'SUPPORTED'});
  mocks.forecast.mockReturnValue({predictedCompletionMono:0});const raw=fixture();const original=raw.buyQuote.responseTimestamp;
  mocks.quote.mockImplementation(async(provider,params)=>({...provider==='jupiter'?raw.buyQuote:raw.sellQuote,id:'new-'+provider,inAmount:params.amountAtomic,consumedInAmount:params.amountAtomic,responseTimestamp:Date.now()}));
  const coordinator=new ExecutablePairCoordinator(),result=await coordinator.refresh(raw,costs);
  expect(result?.previousSignalId).toBe('old');expect(result?.refreshIdentity).toBeTruthy();expect(result?.diagnosticSignalId).toBeUndefined();
  expect(raw.buyQuote.responseTimestamp).toBe(original);expect(mocks.quote.mock.calls[1]?.[1].amountAtomic).toBe('990');
  expect(result?.opportunityScope).toBe('RAW_MARKET_OPPORTUNITY');
  await coordinator.refresh(raw,costs);expect(mocks.quote).toHaveBeenCalledTimes(2);
});
it('above-cap signals and Token-2022 never launch refresh quotes',async()=>{
  CONFIG.firstLiveMaxInputUsdc=.01;const raw=fixture();await new ExecutablePairCoordinator().refresh(raw,costs);expect(mocks.quote).not.toHaveBeenCalled();
  CONFIG.firstLiveMaxInputUsdc=.05;mocks.policy.mockResolvedValue({status:'TOKEN_2022'});await new ExecutablePairCoordinator().refresh(raw,costs);expect(mocks.quote).not.toHaveBeenCalled();
});

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { measuredProviderCall } from './economics/opportunity-quality.js';
import { CONFIG, DECIMALS, MINTS } from './config.js';
import { fromAtomic, toAtomic } from './math.js';
import { getProviderQuote } from './aggregators/index.js';
import { isFullFillQuote, type Quote } from './aggregators/types.js';
import { calculateEstimatedRoundTripProfit } from './profit.js';
import { categorizeProfit, classifyValidationTier, type RoundTripResult } from './routes.js';
import { classifyIntermediate, type ScannerExecutableCostSnapshot } from './execution/scanner-executable-prefilter.js';
import { executableQuoteConstraints, quoteMatchesExecutableProviderPolicy } from './execution/executable-route-policy.js';
import { jupiterAdmission } from './jupiter.js';
import { raptorAdmission } from './raptor.js';
/** One bounded, non-authorizing refresh of a stale signal; never changes its old evidence. */
export class ExecutablePairCoordinator {
  private active=false;
  private last=new Map<string,number>();
  private counters:Record<string,number>={};
  private count(name:string){this.counters[name]=(this.counters[name]??0)+1;}
  snapshot(){return {...this.counters,active:this.active,keys:this.last.size};}
  async refresh(raw:RoundTripResult,costs:ScannerExecutableCostSnapshot):Promise<RoundTripResult|undefined>{
    const providers=[raw.buyQuote.provider,raw.sellQuote.provider];
    if(raw.previousSignalId||providers.some((p)=>p!=='jupiter'&&p!=='raptor')||providers[0]===providers[1]
      ||BigInt(raw.buyQuote.inAmount)>BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc,DECIMALS.USDC)))return;
    const key=JSON.stringify([providers,raw.buyQuote.inputMint,raw.buyQuote.outputMint,raw.buyQuote.inAmount]);
    if(this.active||performance.now()-(this.last.get(key)??-Infinity)<5000){this.count('REFRESH_COALESCED_OR_COOLDOWN');return;}
    this.active=true;this.last.set(key,performance.now());while(this.last.size>64)this.last.delete(this.last.keys().next().value!);
    this.count('REFRESH_STARTED');
    try{
      if((await classifyIntermediate(raw.buyQuote.outputMint)).status!=='SUPPORTED'){this.count('TOKEN_POLICY_REJECTED');return;}
      const quote=async(q:Quote,amount:string,retainedEvidenceAt?:number)=>measuredProviderCall('PAIR_REFRESH',q.provider,()=>getProviderQuote(q.provider,{inputMint:q.inputMint,outputMint:q.outputMint,amountAtomic:amount,slippageBps:CONFIG.slippageBps,
        priority:'DISCOVERY_HIGH',...executableQuoteConstraints(q.provider),scheduling:{deadlineMono:performance.now()+CONFIG.raptorExecutionQuoteAgeMs-(retainedEvidenceAt===undefined?0:Math.max(0,Date.now()-retainedEvidenceAt)),traceId:'refresh:'+raw.diagnosticSignalId}}));
      // Refresh buy first whenever it is older; retaining sell requires identical exact input.
      let buy=raw.buyQuote,sell=raw.sellQuote;
      if(buy.responseTimestamp<=sell.responseTimestamp||Date.now()-buy.responseTimestamp>CONFIG.raptorExecutionQuoteAgeMs/2){
        buy=await quote(buy,buy.inAmount);
        if(sell.inAmount!==buy.otherAmountThreshold||Date.now()-sell.responseTimestamp>CONFIG.raptorExecutionQuoteAgeMs/2)sell=await quote(sell,buy.otherAmountThreshold,buy.responseTimestamp);
      }else sell=await quote(sell,buy.otherAmountThreshold,buy.responseTimestamp);
      if(![buy,sell].every((q)=>isFullFillQuote(q)&&quoteMatchesExecutableProviderPolicy(q)&&q.poolIds.length===1)
        ||sell.inAmount!==buy.otherAmountThreshold||buy.inputMint!==MINTS.USDC||sell.outputMint!==MINTS.USDC||buy.outputMint!==sell.inputMint){this.count('PAIR_SEMANTICS_REJECTED');return;}
      const age=Date.now()-Math.min(buy.responseTimestamp,sell.responseTimestamp),skew=Math.abs(buy.responseTimestamp-sell.responseTimestamp);
      if(age<0||age>CONFIG.raptorExecutionQuoteAgeMs||skew>CONFIG.maxQuoteAgeMs){this.count('REFRESH_STALE');return;}
      const parentDeadline=performance.now()+CONFIG.raptorExecutionQuoteAgeMs-age;
      const governor=(provider:string)=>provider==='jupiter'?jupiterAdmission:raptorAdmission;
      const first=governor(buy.provider).forecast(CONFIG.raptorExecutionQuoteAgeMs);
      const second=governor(sell.provider).forecast(CONFIG.raptorExecutionQuoteAgeMs,first.predictedCompletionMono);
      if(second.predictedCompletionMono+45>parentDeadline){this.count('REFRESH_WORKFLOW_INFEASIBLE');return;}
      const profit=calculateEstimatedRoundTripProfit(fromAtomic(buy.inAmount,DECIMALS.USDC).toString(),sell,costs.estimatedNetworkCostsUsdc);
      if(!profit.estimatedNetProfitUsdc.gt(0)||!profit.worstCaseNetProfitUsdc.gt(0)){this.count('REFRESH_SPREAD_ENDED');return;}
      const category=categorizeProfit(profit);this.count('FRESH_POSITIVE_PAIR');
      return {...raw,buyQuote:buy,sellQuote:sell,profit,category,stale:false,quoteSkewMs:skew,
        validationTier:classifyValidationTier(category,false,raw.liquidityOverlap,profit),opportunityScope:'RAW_MARKET_OPPORTUNITY',
        sourceLane:'PAIR_REFRESH',advisoryBreakdown:undefined,diagnosticSignalId:undefined,previousSignalId:raw.diagnosticSignalId,refreshIdentity:randomUUID()};
    }catch{this.count('REFRESH_FAILED');return;}finally{this.active=false;}
  }
}
export const executablePairCoordinator=new ExecutablePairCoordinator();

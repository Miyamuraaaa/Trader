/** Pure domain validation. Errors identify settings, never their supplied values. */
export function validateLiveCriticalConfig(c:Readonly<Record<string,unknown>>):void {
  const check=(key:string,min:number,max=Number.MAX_SAFE_INTEGER,integer=false)=>{
    const v=c[key];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isSafeInteger(v)))throw new Error(`Invalid safety setting: ${key}`);
  };
  for(const key of ['maxTradeUsdc','maxDailyLossUsdc','maxSingleTradeLossUsdc','maxSessionLossUsdc','firstLiveMaxInputUsdc','executionSolPriceCeilingUsdc'])check(key,Number.MIN_VALUE);
  for(const key of ['minNetProfitUsdc','minSolFeeReserve','executionPriorityFeeMinMicroLamports','executionPriorityFeeMaxMicroLamports'])check(key,0);
  for(const key of ['minProfitBps','slippageBps'])check(key,0,10000,true);
  check('maxTradePercent',Number.MIN_VALUE,100);check('executionPriorityFeePercentile',0,100);
  for(const key of ['maxTradesPerSession','liveMaxTransactions'])check(key,1,100,true);
  check('maxExecutionConsecutiveFailures',1,10,true);check('maxConcurrentExecutions',1,1,true);
  for(const key of ['liveExecutionPollMs','maxExecutionQuoteAgeMs','raptorExecutionQuoteAgeMs','executionRpcTimeoutMs','executionProviderTimeoutMs','jitoSubmissionTimeoutMs','httpTimeoutMs','maxApprovedBlockhashAgeMs'])check(key,Number.MIN_VALUE);
  for(const key of ['jupiterMaxRps','jupiterSafetyIntervalMs','raptorSafetyIntervalMs','raydiumSafetyIntervalMs','orcaSafetyIntervalMs','meteoraSafetyIntervalMs'])check(key,Number.MIN_VALUE);
  for(const key of ['raydiumQuoteConcurrency','orcaQuoteConcurrency','meteoraQuoteConcurrency'])check(key,1,4,true);
  if(Number(c.executionPriorityFeeMinMicroLamports)>Number(c.executionPriorityFeeMaxMicroLamports))throw new Error('Invalid safety setting: executionPriorityFeeMinMicroLamports / executionPriorityFeeMaxMicroLamports');
  if(c.executionMode==='live'){
    if(c.maxTradesPerSession!==c.liveMaxTransactions)throw new Error('MAX_TRADES_PER_SESSION must equal LIVE_MAX_TRANSACTIONS');
    if(Number(c.liveExecutionPollMs)>=Math.min(Number(c.maxExecutionQuoteAgeMs),Number(c.raptorExecutionQuoteAgeMs)))throw new Error('LIVE_EXECUTION_POLL_MS must be below execution quote age');
  }
}

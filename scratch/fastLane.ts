export async function buildExecutableFastLane(
  buy: Quote,
  sellProvider: QuoteProviderName,
  costs: ScannerExecutableCostSnapshot,
  options: { traceId?: string; now?: () => number; monotonicNow?: () => number; policy?: typeof classifyIntermediate; quote?: typeof constrainedQuote } = {},
): Promise<ExecutablePrefilterResult> {
  const now = options.now ?? Date.now;
  const mono = options.monotonicNow ?? options.now ?? (() => performance.now());
  const startedMono = mono();
  const trace: PrefilterTrace = { rawPositiveDetectedAt: buy.responseTimestamp, rawQuoteEvidenceAt: buy.responseTimestamp, rawQuoteAgeAtDetectionMs: 0, executablePrefilterQueuedAt: now(), executablePrefilterStartedAt: now(), rawAgeAtPrefilterStartMs: Math.max(0, now() - buy.responseTimestamp), prefilterQueueMs: 0 };
  
  const timed = async <T>(stage: 'tokenPolicy' | 'constrainedLeg1' | 'constrainedLeg2', work: () => Promise<T>): Promise<T> => {
    trace[`${stage}StartedAt`] = now();
    const stageMono = mono();
    try { return await work(); } finally { trace[`${stage}FinishedAt`] = now(); trace[`${stage}Ms`] = Math.max(0, mono() - stageMono); }
  };
  const finish = (result: ExecutablePrefilterResult): ExecutablePrefilterResult => {
    trace.prefilterFinishedAt = now(); trace.totalPrefilterMs = Math.max(0, mono() - startedMono);
    return { ...result, trace };
  };

  if (BigInt(buy.inAmount) > BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC))) return finish({ status: 'ABOVE_LIVE_CAP' });
  const buyProvider = buy.provider as QuoteProviderName;
  const quote = options.quote ?? ((provider, input, output, amount, scheduling) => constrainedQuote(provider, input, output, amount, scheduling, false));
  const windowMs = [buyProvider, sellProvider].includes('raptor') ? CONFIG.raptorExecutionQuoteAgeMs : CONFIG.maxExecutionQuoteAgeMs;
  let parentDeadline: number;
  try { parentDeadline = workflowParentDeadline(performance.now(), now(), buy.responseTimestamp, windowMs); }
  catch { return finish({ status: 'PREFILTER_STALE', reason: 'INVALID_OR_FUTURE_MARKET_EVIDENCE' }); }
  
  const scheduling: NonNullable<QuoteParams['scheduling']> = { deadlineMono: parentDeadline, traceId: options.traceId };
  const admission = (provider: QuoteProviderName) => provider === 'jupiter' ? jupiterAdmission : provider === 'raptor' ? raptorAdmission : undefined;
  const secondGovernor = admission(sellProvider);
  const localReserveMs = 45;
  let releaseDownstream: (() => void) | undefined;
  let downstreamClaim: import('../provider-entitlement.js').EntitlementClaim | undefined;

  if (!options.quote && secondGovernor) {
      const second = secondGovernor.forecast(windowMs);
      const completedAt = performance.now();
      recordWorkflowProjection(options.traceId, 'BEFORE_LEG2', projectWorkflow(parentDeadline,
        { provider: buyProvider, serviceMs: 0, predictedStartMono: completedAt, predictedCompletionMono: completedAt, cooldownUntilMono: 0 },
        second, localReserveMs)); // Leg 1 is complete
      if (second.predictedCompletionMono > scheduling.deadlineMono) return finish({ status: 'PREFILTER_QUEUE_DEADLINE_EXCEEDED',
        reason: second.cooldownUntilMono > scheduling.deadlineMono ? 'PROVIDER_RATE_LIMIT_OR_MANDATORY_COOLDOWN' : 'PROVIDER_SERVICE_TOO_SLOW_FOR_REMAINING_BUDGET' });
        
      try {
        downstreamClaim = secondGovernor.reserveOwnedWorkflow(scheduling.deadlineMono,completedAt,second.serviceMs,options.traceId??buy.id,
          {inputMint:buy.outputMint,outputMint:MINTS.USDC,amountAtomic:'UNBOUND',slippageBps:CONFIG.slippageBps,priority:'EXEC_PREFILTER_HIGH',...executableQuoteConstraints(sellProvider)});
        releaseDownstream=()=>secondGovernor.releaseOwnedWorkflow(downstreamClaim!);
      }
      catch { return finish({ status: 'PREFILTER_QUEUE_DEADLINE_EXCEEDED', reason: 'DOWNSTREAM_RESERVATION_UNAVAILABLE' }); }
  }

  const [policyResult, sellResult] = await Promise.allSettled([
    timed('tokenPolicy', () => scannerRpcContext.run({label:'prefilter.tokenPolicy',priority:'RPC_P0_EXECUTION_CRITICAL',traceId:options.traceId,deadlineMono:scheduling.deadlineMono,liveDependency:true},()=>(options.policy ?? classifyIntermediate)(buy.outputMint,'RPC_P0_EXECUTION_CRITICAL'))),
    (async () => {
       scheduling.deadlineMono = parentDeadline - (options.quote ? 0 : localReserveMs);
       scheduling.entitlement = downstreamClaim;
       return timed('constrainedLeg2', () => quote(sellProvider, buy.outputMint, MINTS.USDC, buy.otherAmountThreshold, scheduling));
    })()
  ]).finally(() => releaseDownstream?.());

  let tokenPolicy: Awaited<ReturnType<typeof classifyIntermediate>>;
  try { if (policyResult.status === 'rejected') throw policyResult.reason; tokenPolicy = policyResult.value; }
  catch (error) { return finish({ status: 'QUOTE_FAILED', reason: 'TOKEN_POLICY:' + providerFailureReason(error) }); }
  
  if (tokenPolicy.status === 'TOKEN_2022') return finish({ status: 'DISCOVERY_ONLY_TOKEN_2022' });
  if (tokenPolicy.status !== 'SUPPORTED') return finish({ status: 'TOKEN_POLICY_REJECTED', reason: tokenPolicy.reason });

  try {
    if (sellResult.status === 'rejected') throw sellResult.reason;
    const sell = sellResult.value;
    if (!options.quote && performance.now() > parentDeadline) return finish({ status: 'PREFILTER_STALE', reason: 'PARENT_WORKFLOW_DEADLINE_EXCEEDED' });
    if (!isFullFillQuote(sell) || !quoteMatchesExecutableProviderPolicy(sell)) return finish({ status: 'ROUTE_POLICY_REJECTED', reason: 'Constrained quotes escaped audited route policy' });
    if (sell.inputMint !== buy.outputMint || sell.outputMint !== MINTS.USDC || sell.inAmount !== buy.otherAmountThreshold) return finish({ status: 'ROUTE_POLICY_REJECTED', reason: 'Executable prefilter lost exact minimum-output propagation' });
    const buyPools = exactPoolEvidence(buy); const sellPools = exactPoolEvidence(sell);
    if (buyPools.length !== 1 || sellPools.length !== 1) return finish({ status: 'ROUTE_POLICY_REJECTED', reason: `Executable prefilter requires exactly one auditable pool per leg` });
    
    const quoteSkewMs = Math.abs(sell.responseTimestamp - buy.responseTimestamp);
    const stale = quoteSkewMs > CONFIG.maxQuoteAgeMs || now() - Math.min(buy.responseTimestamp, sell.responseTimestamp) > CONFIG.maxQuoteAgeMs;
    if (stale) return finish({ status: 'PREFILTER_STALE', reason: 'Constrained quote evidence exceeded scanner freshness' });
    
    const liquidityOverlap = poolOverlap(buy, sell);
    if (liquidityOverlap === true) return finish({ status: 'ROUTE_POLICY_REJECTED', reason: 'Executable legs resolve to the same pool' });
    
    const profit = calculateEstimatedRoundTripProfit(fromAtomic(buy.inAmount, DECIMALS.USDC).toString(), sell, scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint), 'conservative');
    const category = categorizeProfit(profit);
    const validationTier = classifyValidationTier(category, stale, liquidityOverlap, profit);
    const route: RoundTripResult = { buyQuote: buy, sellQuote: sell, classification: classifyRoute(buy, sell), liquidityOverlap, quoteSkewMs, stale, profit, category, validationTier, opportunityScope: 'EXECUTABLE_CANDIDATE' };
    
    if (validationTier !== 'CONSERVATIVE_CANDIDATE' || !profit.estimatedNetProfitUsdc.gt(0) || !profit.worstCaseNetProfitUsdc.gt(0)) {
      return finish({ status: 'ECONOMICS_DIVERGED', route, costs: scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint), estimatedAtaRentUsdc: Number(scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint).ataRentUsdc), reason: 'Executor-constrained route is not conservatively profitable' });
    }
    return finish({ status: 'EXECUTABLE_CANDIDATE', route, costs: scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint), estimatedAtaRentUsdc: Number(scannerExecutionCosts(costs, tokenPolicy.rentLamports, buy.outputMint).ataRentUsdc) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const policy = /escaped the audited|partial executable|same pool|propagation|exactly one auditable pool/i.test(reason);
    return finish({ status: /QUEUE_DEADLINE|QUEUE_CANCELLED/.test(reason) ? 'PREFILTER_QUEUE_DEADLINE_EXCEEDED' : /QUOTE_RESULT_STALE/.test(reason) ? 'PREFILTER_STALE' : /429|backpressure|cooldown|capacity|rate.?limit|OVERFLOW/i.test(reason) ? 'PREFILTER_RATE_LIMITED' : policy ? 'ROUTE_POLICY_REJECTED' : 'QUOTE_FAILED', reason: providerFailureReason(error) });
  }
}

import { PublicKey, type Connection } from '@solana/web3.js';
import { CONFIG, DECIMALS, MINTS } from '../config.js';
import { toAtomic } from '../math.js';
import { parseAggregatorAtomicHandoff } from './aggregator-handoff-dto.js';
import { EXECUTABLE_POLICY_HASH, EXECUTABLE_POLICY_VERSION } from './executable-route-policy.js';
import { buildRaptorRaydiumCycle } from './raptor-raydium-cycle-builder.js';
import { compareExecutionRouteAlignment } from './execution-route-alignment.js';
import { inspectAtomicTransaction } from './transaction-inspector.js';
import { simulateAtomicTransaction } from './simulator.js';
import { executionQuoteAgeLimit } from './quote-freshness.js';
import { calculateExecutorEconomics, assertFinalHandoffPolicy } from './handoff-validator.js';

export function noBroadcastRaydiumConnection(connection:Connection){
  const counters={submissionAttempts:0};
  const guarded=new Proxy(connection,{get(target,key){
    if(['sendTransaction','sendRawTransaction','sendEncodedTransaction'].includes(String(key)))return ()=>{counters.submissionAttempts++;throw new Error('NO_BROADCAST_CAPABILITY');};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return {connection:guarded,counters};
}

/** Public wallet only. No signer, approval, journal write, broadcaster or submission construction. */
export async function validateRaptorRaydiumReadOnly(value:unknown,wallet:PublicKey,connection:Connection){
  const candidate=parseAggregatorAtomicHandoff(value);
  if(candidate.providers.join(':')!=='raptor:raydium'||candidate.version!==2||candidate.routeEvidence?.policyVersion!==EXECUTABLE_POLICY_VERSION||candidate.routeEvidence.policyHash!==EXECUTABLE_POLICY_HASH)throw new Error('RAYDIUM_VALIDATION_CAPABILITY_MISMATCH');
  const input=BigInt(candidate.proposedInputAmount);
  if(candidate.inputMint!==MINTS.USDC||candidate.outputMint!==MINTS.USDC||input>BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc,DECIMALS.USDC)))throw new Error('RAYDIUM_VALIDATION_SCOPE');
  const noBroadcast=noBroadcastRaydiumConnection(connection);
  const plan=await buildRaptorRaydiumCycle({connection:noBroadcast.connection,wallet,inputAmount:input,intermediateMint:candidate.intermediateMint,raydiumPoolHints:candidate.scannerPools[1],slippageBps:CONFIG.slippageBps,computeUnitLimit:500000});
  const alignment=compareExecutionRouteAlignment(candidate,plan);if(!alignment.passed)throw new Error(alignment.code);
  const inspection=inspectAtomicTransaction(plan);if(!inspection.passed)throw new Error(inspection.reasons[0]??'INSPECTION_FAILED');
  const simulation=await simulateAtomicTransaction(noBroadcast.connection,plan,{publicKey:wallet.toBase58()},{quoteReceivedAt:plan.quoteReceivedAt,maxAgeMs:executionQuoteAgeLimit(plan)});
  if(!simulation.passed)throw new Error('SIMULATION_FAILED');
  const economics=calculateExecutorEconomics(plan,simulation);
  let economicsPassed=true;
  try{assertFinalHandoffPolicy(plan,simulation,economics);}catch{economicsPassed=false;}
  return {mode:'NO_BROADCAST' as const,executionAuthority:false,independentRebuild:true,exactInputChain:plan.expectedIntermediateAmount===plan.raydiumEvidence!.leg.inputAmount,
    inspectionPassed:true,unsignedSimulationPassed:true,simulationEffectsPassed:true,finalEconomicsPassed:economicsPassed,
    wouldBeReadyAfterMarketChecks:economicsPassed,remainingAuthorityGates:['LIVE_BALANCE_RESERVE','PERSISTENT_RISK','JOURNAL','FINAL_FRESHNESS','SUBMISSION_CAPABILITY'],
    pools:plan.pools,family:'CLMM',raptorMinimumAtomic:String(plan.expectedIntermediateAmount),raydiumInputAtomic:String(plan.raydiumEvidence!.leg.inputAmount),minimumFinalAtomic:String(plan.minimumOutputAmount),
    expectedNetAtomic:String(economics.expectedNetAtomic),conservativeNetAtomic:String(economics.conservativeNetAtomic),networkCostAtomic:String(economics.networkCostUsdcAtomic),conservativeRoiBps:String(economics.conservativeRoiBps),
    broadcasterConstructed:0,transportConstructed:0,broadcasterSubmits:0,transportSends:0,submittedSignatures:0,submissionAttempts:noBroadcast.counters.submissionAttempts};
}

import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import { CONFIG, MINTS } from '../config.js';
import { TOKEN_PROGRAM_ID, associatedTokenAddress } from './account-preflight.js';
import { analyzeTokenMint, assertIntermediateTokenExecutionPolicy } from './token-analysis.js';
import { RaptorQuoteSchema, InstructionBundleSchema, toInstruction, instructionHash } from './mixed-cycle-builder.js';
import { RAPTOR_PROGRAM_ID, type BuildRaptorJupiterCycleInput } from './aggregator-cycle-builder.js';
import { buildRaydiumSwapLeg, loadRaydiumState, validateClassicTokenAccount, type RaydiumLegEvidence, type RaydiumState } from './raydium-swap-builder.js';
import { RAYDIUM_CLMM_PROGRAM } from './raydium-capability.js';
import { inspectRaptorClmmSwap } from './raptor-instruction-inspector.js';
import { currentExecutionPriorityFee } from './priority-fee-oracle.js';
import type { AtomicExecutionPlan } from './types.js';

const ALT_PROGRAM = new PublicKey('AddressLookupTab1e1111111111111111111111111');
const U64_MAX=(1n<<64n)-1n;
export interface RaydiumCycleEvidence {
  leg: RaydiumLegEvidence;
  firstPool: RaydiumState['pool'];
  /** Fresh account graph, not API account-role authority. Never serialized into handoff. */
  writableAccounts: string[];
  readonlyAccounts: string[];
}
async function json(url:string|URL,init:RequestInit):Promise<unknown>{
  // No response bodies/URLs in errors: either can contain credentials/payloads.
  const response=await fetch(url,{...init,signal:AbortSignal.timeout(CONFIG.executionProviderTimeoutMs)});
  if(!response.ok)throw new Error(`RAPTOR_EXECUTION_HTTP_${response.status}`);
  try{return await response.json();}catch{throw new Error('RAPTOR_EXECUTION_MALFORMED_RESPONSE');}
}
function poolWritable(p:RaydiumState['pool']):string[]{return [p.address,p.vault0,p.vault1,p.observation,p.tickArray].map(x=>x.toBase58());}
function poolReadonly(p:RaydiumState['pool']):string[]{return [p.config,p.mint0,p.mint1].map(x=>x.toBase58());}

export async function loadRaydiumLookupTables(connection:BuildRaptorJupiterCycleInput['connection'],addresses:readonly string[]):Promise<AddressLookupTableAccount[]>{
  const keys=[...new Set(addresses)].map(x=>new PublicKey(x));
  if(keys.length>4)throw new Error('RAYDIUM_ALT_COUNT_UNSUPPORTED');
  if(!keys.length)return [];
  const result=await connection.getMultipleAccountsInfoAndContext(keys,'confirmed');
  return keys.map((key,i)=>{
    const info=result.value[i];
    if(!info || info.executable || !info.owner.equals(ALT_PROGRAM))throw new Error('RAYDIUM_ALT_OWNER_OR_MISSING');
    const state=AddressLookupTableAccount.deserialize(info.data);
    if(state.deactivationSlot!==U64_MAX || state.lastExtendedSlot>=result.context.slot
      || new Set(state.addresses.map(a=>a.toBase58())).size!==state.addresses.length)throw new Error('RAYDIUM_ALT_STATE');
    return new AddressLookupTableAccount({key,state});
  });
}

/** A narrower first-leg adapter subset does not change any existing Raptor pair. */
export async function buildRaptorRaydiumCycle(input:BuildRaptorJupiterCycleInput):Promise<AtomicExecutionPlan>{
  const mint=input.intermediateMint, pools=input.raydiumPoolHints;
  if(!mint || mint===MINTS.USDC || mint===MINTS.SOL || pools?.length!==1)throw new Error('RAYDIUM_REQUIRES_NON_NATIVE_SINGLE_POOL');
  if(input.inputAmount<=0n || input.inputAmount>U64_MAX || (input.computeUnitLimit??500000)!==500000)throw new Error('RAYDIUM_INPUT_OR_COMPUTE_LIMIT');
  // Public RPC analysis is intentionally fresh; scanner/prewarm entries are not authority.
  const [baseToken,intermediateToken]=await Promise.all([analyzeTokenMint(input.connection,MINTS.USDC),analyzeTokenMint(input.connection,mint)]);
  if([baseToken,intermediateToken].some(x=>x.status!=='SUPPORTED'||x.programId!==TOKEN_PROGRAM_ID.toBase58()))throw new Error('RAYDIUM_CLASSIC_SPL_ONLY');
  assertIntermediateTokenExecutionPolicy(intermediateToken);
  const source=associatedTokenAddress(new PublicKey(MINTS.USDC),input.wallet,TOKEN_PROGRAM_ID);
  const destination=associatedTokenAddress(new PublicKey(mint),input.wallet,TOKEN_PROGRAM_ID);
  const accounts=await input.connection.getMultipleAccountsInfo([source,destination],'confirmed');
  // Initial capability has no setup/cleanup at all. Missing ATA is a rejection,
  // never a silent rent omission or automatic trade resize.
  const baseBalance=validateClassicTokenAccount(accounts[0]??null,new PublicKey(MINTS.USDC),input.wallet);
  const intermediateBalance=validateClassicTokenAccount(accounts[1]??null,new PublicKey(mint),input.wallet);
  if(accounts.some(a=>!a||a.data.readUInt32LE(109)!==0))throw new Error('RAYDIUM_NATIVE_ACCOUNT_UNSUPPORTED');
  const raptorProgram=await input.connection.getAccountInfo(RAPTOR_PROGRAM_ID,'confirmed');
  if(!raptorProgram?.executable)throw new Error('RAPTOR_PROGRAM_NOT_EXECUTABLE');
  if(baseBalance<input.inputAmount)throw new Error('RAYDIUM_INSUFFICIENT_BASE_BALANCE');
  const url=new URL(`${CONFIG.raptorBaseUrl.replace(/\/$/,'')}/quote`);
  for(const [key,value] of Object.entries({inputMint:MINTS.USDC,outputMint:mint,amount:String(input.inputAmount),slippageBps:String(input.slippageBps),maxHops:'1',onlyDirectRoutes:'true',dexes:'Raydium CLMM'}))url.searchParams.set(key,value);
  const firstEvidenceAt=Date.now();
  const quote=RaptorQuoteSchema.parse(await json(url,{method:'GET',headers:{accept:'application/json'}}));
  const numbers=[quote.amountIn,quote.amountOut,quote.minAmountOut];
  if(numbers.some(x=>!/^[1-9]\d*$/.test(x)||BigInt(x)>U64_MAX)||quote.inputMint!==MINTS.USDC||quote.outputMint!==mint
    ||quote.amountIn!==String(input.inputAmount)||quote.slippageBps!==input.slippageBps||BigInt(quote.minAmountOut)>BigInt(quote.amountOut)
    ||quote.routePlan.length!==1||quote.routePlan[0]!.programId!==RAYDIUM_CLMM_PROGRAM||!quote.routePlan[0]!.pool)throw new Error('RAPTOR_RAYDIUM_FIRST_LEG_POLICY');
  const firstPoolId=quote.routePlan[0]!.pool!;
  if(firstPoolId===pools[0])throw new Error('RAYDIUM_POOL_OVERLAP');
  const exactMinimum=BigInt(quote.minAmountOut);
  const [bundle,firstState,second]=await Promise.all([
    json(`${CONFIG.raptorBaseUrl.replace(/\/$/,'')}/swap-instructions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userPublicKey:input.wallet.toBase58(),quoteResponse:quote,wrapUnwrapSol:false,txVersion:'V0'})}).then(x=>InstructionBundleSchema.strict().parse(x)),
    loadRaydiumState(input.connection,firstPoolId,MINTS.USDC,mint),
    buildRaydiumSwapLeg({connection:input.connection,wallet:input.wallet,poolId:pools[0]!,inputMint:mint,outputMint:MINTS.USDC,inputAmount:exactMinimum,slippageBps:input.slippageBps}),
  ]);
  if(bundle.tokenLedgerInstruction||bundle.setupInstructions.length||bundle.cleanupInstruction)throw new Error('RAPTOR_RAYDIUM_UNEXPECTED_SETUP_CLEANUP');
  const raptor=toInstruction(bundle.swapInstruction);
  inspectRaptorClmmSwap(raptor,{wallet:input.wallet.toBase58(),sourceAta:source.toBase58(),destinationAta:destination.toBase58(),inputMint:MINTS.USDC,outputMint:mint,input:input.inputAmount,minimum:exactMinimum,expected:BigInt(quote.amountOut)});
  const writable=[input.wallet.toBase58(),source.toBase58(),destination.toBase58(),...poolWritable(firstState.pool),second.evidence.pool,second.evidence.inputVault,second.evidence.outputVault,second.evidence.observation,second.evidence.tickArray];
  const readonly=[...poolReadonly(firstState.pool),second.evidence.config,RAYDIUM_CLMM_PROGRAM,RAPTOR_PROGRAM_ID.toBase58(),TOKEN_PROGRAM_ID.toBase58(),
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','11111111111111111111111111111111'];
  const firstWritable=[input.wallet.toBase58(),source.toBase58(),destination.toBase58(),...poolWritable(firstState.pool)];
  for(const k of raptor.keys){const address=k.pubkey.toBase58();if((k.isWritable&&!firstWritable.includes(address))||(!firstWritable.includes(address)&&!readonly.includes(address))||(k.isSigner&&address!==input.wallet.toBase58()))throw new Error('RAPTOR_UNMODELED_ACCOUNT_ROLE');}
  const lookupTableAccounts=await loadRaydiumLookupTables(input.connection,bundle.addressLookupTableAddresses);
  const price=currentExecutionPriorityFee().microLamportsPerCu;
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:input.computeUnitLimit??500000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:price}),raptor,second.instruction];
  return {id:`raptor-raydium-${Date.now()}`,type:'RAPTOR_RAYDIUM_CYCLE',atomic:true,wallet:input.wallet.toBase58(),inputMint:MINTS.USDC,intermediateMint:mint,outputMint:MINTS.USDC,inputAmount:input.inputAmount,
    expectedIntermediateAmount:exactMinimum,expectedOutputAmount:second.evidence.expectedOutput,minimumOutputAmount:second.evidence.minimumOutput,pools:[firstPoolId,pools[0]!],quoteReceivedAt:Math.min(firstEvidenceAt,firstState.evidenceAt,second.evidence.quoteReceivedAt),
    baseToken,intermediateToken,baseAta:{ata:source.toBase58(),exists:true,balance:baseBalance,creationRentLamports:0},intermediateAta:{ata:destination.toBase58(),exists:true,balance:intermediateBalance,creationRentLamports:0},
    instructions,lookupTableAccounts,computeUnitLimit:input.computeUnitLimit??500000,computeUnitPriceMicroLamports:price,
    raydiumEvidence:{leg:second.evidence,firstPool:firstState.pool,writableAccounts:writable,readonlyAccounts:readonly},
    aggregatorEvidence:{providers:['raptor','raydium'],routeProgramIds:[RAYDIUM_CLMM_PROGRAM],sourceInstructionHashes:[instructionHash(raptor),instructionHash(second.instruction)],closesIntermediateAta:false,
      legs:[{provider:'raptor',programId:RAPTOR_PROGRAM_ID.toBase58(),downstreamProgramId:RAYDIUM_CLMM_PROGRAM,inputMint:MINTS.USDC,outputMint:mint,inputAmount:input.inputAmount,expectedOutputAmount:BigInt(quote.amountOut),minimumOutputAmount:exactMinimum,pool:firstPoolId},
        {provider:'raydium',programId:RAYDIUM_CLMM_PROGRAM,downstreamProgramId:RAYDIUM_CLMM_PROGRAM,inputMint:mint,outputMint:MINTS.USDC,inputAmount:exactMinimum,expectedOutputAmount:second.evidence.expectedOutput,minimumOutputAmount:second.evidence.minimumOutput,pool:pools[0]!}]}};
}

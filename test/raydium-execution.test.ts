import { readFile } from 'node:fs/promises';
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, type AccountInfo, type SimulatedTransactionResponse } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const installEnvironment = vi.hoisted(() => {
  const install = () => {
    vi.stubEnv('EXECUTION_MODE', 'paper');
    vi.stubEnv('LIVE_TRADING_ENABLED', 'false');
  };
  install(); // Must precede every config-dependent static import (MODE may be test).
  return install;
});
vi.mock('dotenv/config',()=>({}));
beforeEach(installEnvironment);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, associatedTokenAddress } from '../src/execution/account-preflight.js';
import { RAYDIUM_CAPABILITY, RAYDIUM_CLMM_PROGRAM, RAYDIUM_ADAPTER_ID, rememberRaydiumClmmPool, raydiumClmmHint } from '../src/execution/raydium-capability.js';
import { raydiumDiscriminator, decodeRaydiumPool, raydiumSqrtAtTick, quoteRaydiumCell, quoteRaydiumExecutablePool, raydiumInstruction, raydiumInstructionHash, inspectRaydiumInstruction, validateClassicTokenAccount, type RaydiumLegEvidence } from '../src/execution/raydium-swap-builder.js';
import { decodeRaptorClmmSwap, inspectRaptorClmmSwap } from '../src/execution/raptor-instruction-inspector.js';
import { RAPTOR_PROGRAM_ID } from '../src/execution/aggregator-cycle-builder.js';
import { instructionHash } from '../src/execution/mixed-cycle-builder.js';
import { inspectAtomicTransaction } from '../src/execution/transaction-inspector.js';
import { inspectRaydiumSimulationEffects, type RaydiumSimulationSnapshot } from '../src/execution/raydium-simulation-effects.js';
import { loadRaydiumLookupTables } from '../src/execution/raptor-raydium-cycle-builder.js';
import { noBroadcastRaydiumConnection } from '../src/execution/raptor-raydium-validation.js';
import { EXECUTABLE_PROVIDER_PAIRS, quoteMatchesExecutableProviderPolicy } from '../src/execution/executable-route-policy.js';
import { EXECUTABLE_POLICY_HASH, EXECUTABLE_POLICY_VERSION, executionAdapterIdentity } from '../src/execution/executable-route-policy.js';
import { parseAggregatorAtomicHandoff, quoteRouteEvidence, routeEvidenceFingerprint, type AggregatorAtomicHandoff, type RouteEvidence } from '../src/execution/aggregator-handoff-dto.js';
import { compareExecutionRouteAlignment } from '../src/execution/execution-route-alignment.js';
import { simulateAtomicTransaction } from '../src/execution/simulator.js';
import { calculateExecutorEconomics } from '../src/execution/handoff-validator.js';
import type { AtomicExecutionPlan, SimulationResult } from '../src/execution/types.js';
import type { Quote } from '../src/aggregators/types.js';

const program=new PublicKey(RAYDIUM_CLMM_PROGRAM);
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n));
const wallet=key(90),mint0=key(1),mint1=key(2);
const pda=(seed:string,...parts:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...parts],program)[0];
const info=(data:Buffer,owner=program):AccountInfo<Buffer>=>({data,owner,lamports:2000000,executable:false,rentEpoch:0});
function poolFixture(index:number){
  const indexBytes=Buffer.alloc(2);indexBytes.writeUInt16BE(index);
  const config=pda('amm_config',indexBytes),address=pda('pool',config.toBuffer(),mint0.toBuffer(),mint1.toBuffer());
  const data=Buffer.alloc(1544);raydiumDiscriminator('account:PoolState').copy(data);
  for(const [offset,k]of [[9,config],[73,mint0],[105,mint1],[137,pda('pool_vault',address.toBuffer(),mint0.toBuffer())],[169,pda('pool_vault',address.toBuffer(),mint1.toBuffer())],[201,pda('observation',address.toBuffer())]] as const)k.toBuffer().copy(data,offset);
  data.writeUInt16LE(10,235);data.writeInt32LE(5,269);data.writeBigUInt64LE(1000000000000n,237);
  const sqrt=raydiumSqrtAtTick(5);data.writeBigUInt64LE(sqrt&((1n<<64n)-1n),253);data.writeBigUInt64LE(sqrt>>64n,261);
  data[968]=1;
  return {data,address,pool:decodeRaydiumPool(info(data),address)};
}
function token(mint:PublicKey,owner:PublicKey,amount=1000n){const data=Buffer.alloc(165);mint.toBuffer().copy(data);owner.toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);data[108]=1;return info(data,TOKEN_PROGRAM_ID);}
function scannerClmmRpcFixture() {
  const f=poolFixture(2),p=f.pool;
  const config=Buffer.alloc(117);raydiumDiscriminator('account:AmmConfig').copy(config);
  config.writeUInt16LE(2,9);config.writeUInt32LE(2500,47);config.writeUInt16LE(p.spacing,51);
  const observation=Buffer.alloc(4483);raydiumDiscriminator('account:ObservationState').copy(observation);p.address.toBuffer().copy(observation,19);
  const ticks=Buffer.alloc(10240);raydiumDiscriminator('account:TickArrayState').copy(ticks);p.address.toBuffer().copy(ticks,8);ticks.writeInt32LE(p.start,40);
  for(let i=0;i<2;i++){ticks.writeInt32LE(i*p.spacing,44+i*168);ticks.writeBigUInt64LE(1n,64+i*168);}ticks[10124]=2;
  const mint=Buffer.alloc(82);mint[45]=1;
  const values=[info(f.data),info(config),token(mint0,p.address),token(mint1,p.address),info(observation),info(ticks),info(Buffer.from(mint),TOKEN_PROGRAM_ID),info(Buffer.from(mint),TOKEN_PROGRAM_ID),{...info(Buffer.alloc(0)),executable:true}];
  const connection={getAccountInfoAndContext:vi.fn(async()=>({context:{slot:123},value:values[0]})),getMultipleAccountsInfoAndContext:vi.fn(async()=>({context:{slot:123},value:values}))} as unknown as Connection;
  return {pool:p,values,connection};
}
function evidence():RaydiumLegEvidence{
  const p=poolFixture(2).pool;
  const q=quoteRaydiumCell(100n,p.liquidity,p.sqrtPrice,p.tick,p.spacing,2500,false,50);
  const e:Omit<RaydiumLegEvidence,'instructionHash'>={capability:RAYDIUM_CAPABILITY,family:'CLMM',pool:p.address.toBase58(),config:p.config.toBase58(),inputMint:mint1.toBase58(),outputMint:mint0.toBase58(),inputAmount:100n,expectedOutput:q.expected,minimumOutput:q.minimum,wallet:wallet.toBase58(),sourceAta:associatedTokenAddress(mint1,wallet,TOKEN_PROGRAM_ID).toBase58(),destinationAta:associatedTokenAddress(mint0,wallet,TOKEN_PROGRAM_ID).toBase58(),inputVault:p.vault1.toBase58(),outputVault:p.vault0.toBase58(),observation:p.observation.toBase58(),tickArray:p.tickArray.toBase58(),tickArrayStart:0,quoteReceivedAt:1000,slot:123,stateHash:'a'.repeat(64),tickCurrent:p.tick,tickSpacing:p.spacing,sqrtPrice:p.sqrtPrice,liquidity:p.liquidity,feeRate:2500,slippageBps:50};
  return {...e,instructionHash:raydiumInstructionHash(raydiumInstruction(e))};
}
function raptorData(){const d=Buffer.alloc(76);Buffer.from([248,198,158,145,225,117,135,200]).copy(d);d.writeBigUInt64LE(80n,8);d.writeBigUInt64LE(110n,16);d.writeBigUInt64LE(100n,24);for(const o of [32,44,48,52,57])d.writeUInt32LE(1,o);d.writeBigUInt64LE(80n,36);d[56]=6;d[61]=100;return d;}
function planFixture():AtomicExecutionPlan{
  const e=evidence(),first=poolFixture(1).pool;
  const raptorKeys=[wallet,new PublicKey(e.destinationAta),new PublicKey(e.sourceAta),mint0,mint1,...Array.from({length:8},()=>RAPTOR_PROGRAM_ID)].map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:i<3}));
  const raptor=new TransactionInstruction({programId:RAPTOR_PROGRAM_ID,data:raptorData(),keys:[...raptorKeys,...[first.address,first.config,first.vault0,first.vault1,first.observation,first.tickArray].map(pubkey=>({pubkey,isSigner:false,isWritable:!pubkey.equals(first.config)}))]});
  const ray=raydiumInstruction(e),instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),raptor,ray];
  const writable=[wallet.toBase58(),e.sourceAta,e.destinationAta,...[first.address,first.vault0,first.vault1,first.observation,first.tickArray].map(x=>x.toBase58()),e.pool,e.inputVault,e.outputVault,e.observation,e.tickArray];
  const readonly=[mint0.toBase58(),mint1.toBase58(),first.config.toBase58(),e.config,RAYDIUM_CLMM_PROGRAM,RAPTOR_PROGRAM_ID.toBase58(),TOKEN_PROGRAM_ID.toBase58()];
  const analysis=(mint:string)=>({mint,status:'SUPPORTED' as const,programId:TOKEN_PROGRAM_ID.toBase58(),decimals:6,extensions:[],reasons:[],transferFeeMode:'NONE' as const,mintAuthority:null,freezeAuthority:null});
  return {id:'fixture',type:'RAPTOR_RAYDIUM_CYCLE',atomic:true,wallet:wallet.toBase58(),inputMint:mint0.toBase58(),intermediateMint:mint1.toBase58(),outputMint:mint0.toBase58(),inputAmount:80n,expectedIntermediateAmount:100n,expectedOutputAmount:e.expectedOutput,minimumOutputAmount:e.minimumOutput,pools:[first.address.toBase58(),e.pool],quoteReceivedAt:1000,
    baseToken:analysis(mint0.toBase58()),intermediateToken:analysis(mint1.toBase58()),baseAta:{ata:e.destinationAta,exists:true,balance:1000n,creationRentLamports:0},intermediateAta:{ata:e.sourceAta,exists:true,balance:1000n,creationRentLamports:0},instructions,computeUnitLimit:500000,computeUnitPriceMicroLamports:0,
    raydiumEvidence:{leg:e,firstPool:first,writableAccounts:writable,readonlyAccounts:readonly},aggregatorEvidence:{providers:['raptor','raydium'],routeProgramIds:[RAYDIUM_CLMM_PROGRAM],sourceInstructionHashes:[instructionHash(raptor),instructionHash(ray)],closesIntermediateAta:false,legs:[{provider:'raptor',programId:RAPTOR_PROGRAM_ID.toBase58(),downstreamProgramId:RAYDIUM_CLMM_PROGRAM,inputMint:mint0.toBase58(),outputMint:mint1.toBase58(),inputAmount:80n,expectedOutputAmount:110n,minimumOutputAmount:100n,pool:first.address.toBase58()},{provider:'raydium',programId:RAYDIUM_CLMM_PROGRAM,inputMint:mint1.toBase58(),outputMint:mint0.toBase58(),inputAmount:100n,expectedOutputAmount:e.expectedOutput,minimumOutputAmount:e.minimumOutput,pool:e.pool}]}};
}
function handoffFixture(plan=planFixture()):AggregatorAtomicHandoff{
  const leg=(index:0|1)=>{const e=plan.aggregatorEvidence!.legs[index];return {provider:e.provider,poolId:e.pool,executableProgramId:RAYDIUM_CLMM_PROGRAM,normalizedRouteLabel:executionAdapterIdentity(e.provider,RAYDIUM_CLMM_PROGRAM),inputMint:e.inputMint,outputMint:e.outputMint,inputAmount:String(e.inputAmount),minimumOutputAmount:String(e.minimumOutputAmount),quoteEvidenceAt:1000};};
  const routeEvidence:RouteEvidence={policyVersion:EXECUTABLE_POLICY_VERSION,policyHash:EXECUTABLE_POLICY_HASH,leg1:leg(0),leg2:leg(1)};
  return {schema:'sol-arb.aggregator-execution-handoff',version:2,opportunityId:'fixture',detectedAt:1000,opportunityType:'RAPTOR_RAYDIUM_ATOMIC',providers:['raptor','raydium'],inputMint:plan.inputMint,intermediateMint:plan.intermediateMint,outputMint:plan.outputMint,proposedInputAmount:String(plan.inputAmount),scannerPools:[[plan.pools[0]],[plan.pools[1]]],routeEvidence,routeFingerprint:routeEvidenceFingerprint(routeEvidence),scannerObservation:{expectedOutputAmount:String(plan.expectedOutputAmount),minimumOutputAmount:String(plan.minimumOutputAmount),projectedNetAmount:'20',roiBps:'100',quoteTimestamp:1000}};
}

describe('bounded CLMM capability and binary inspection (offline only)',()=>{
  it('fresh scanner CLMM producer stamps capability and preserves it through clone and v2 evidence',async()=>{
    const f=scannerClmmRpcFixture();
    const sell=await quoteRaydiumExecutablePool(f.connection,f.pool.address.toBase58(),mint1.toBase58(),mint0.toBase58(),'100',50);
    expect(sell.executionCapabilityId).toBe(RAYDIUM_ADAPTER_ID);
    const buy:Quote={...sell,provider:'raptor',inputMint:mint0.toBase58(),outputMint:mint1.toBase58(),inAmount:'80',consumedInAmount:'80',outAmount:'110',otherAmountThreshold:'100',poolIds:[poolFixture(1).address.toBase58()],routePlan:[{percent:100,swapInfo:{label:'Raydium CLMM',programId:RAYDIUM_CLMM_PROGRAM,ammKey:poolFixture(1).address.toBase58()}}]};
    for(const copy of [{...sell},JSON.parse(JSON.stringify(sell)) as Quote]){
      expect(quoteMatchesExecutableProviderPolicy(copy)).toBe(true);
      const evidence=quoteRouteEvidence(buy,copy);
      expect(evidence.leg2.normalizedRouteLabel).toBe(RAYDIUM_ADAPTER_ID);
      expect(evidence.leg2.inputAmount).toBe(evidence.leg1.minimumOutputAmount);
      const candidate={...handoffFixture(),routeEvidence:evidence,routeFingerprint:routeEvidenceFingerprint(evidence)};
      expect(parseAggregatorAtomicHandoff(candidate).providers).toEqual(['raptor','raydium']);
    }
    for(const patch of [{executionCapabilityId:undefined},{swapMode:'ExactOut'},{isPartialFill:true},{poolIds:[sell.poolIds[0]!,key(42).toBase58()]},{routePlan:[...sell.routePlan,...sell.routePlan]},...['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',key(43).toBase58()].map(programId=>({routePlan:[{...sell.routePlan[0]!,swapInfo:{...sell.routePlan[0]!.swapInfo,programId}}]}))]){
      expect(quoteMatchesExecutableProviderPolicy({...sell,...patch} as Quote)).toBe(false);
      expect(()=>quoteRouteEvidence(buy,{...sell,...patch} as Quote)).toThrow();
    }
  });
  it('scanner producer cannot stamp capability for Token-2022 or a non-CLMM account owner',async()=>{
    for(const index of [0,6,7]){
      const f=scannerClmmRpcFixture();f.values[index]!.owner=TOKEN_2022_PROGRAM_ID;
      await expect(quoteRaydiumExecutablePool(f.connection,f.pool.address.toBase58(),mint1.toBase58(),mint0.toBase58(),'100',50)).rejects.toThrow('ACCOUNT_OWNER_OR_LAYOUT');
    }
  });
  it('identifies CLMM by owner + layout + PDA, never the shared discriminator alone',()=>{const f=poolFixture(1);expect(decodeRaydiumPool(info(f.data),f.address).address.equals(f.address)).toBe(true);expect(()=>decodeRaydiumPool(info(f.data,new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')),f.address)).toThrow();});
  it.each([389,390,391,1096])('rejects unsupported pool state at offset %i',offset=>{const f=poolFixture(1);f.data[offset]=offset===389?16:1;expect(()=>decodeRaydiumPool(info(f.data),f.address)).toThrow();});
  it('rejects a forged pool/vault relationship',()=>{const f=poolFixture(1);key(31).toBuffer().copy(f.data,137);expect(()=>decodeRaydiumPool(info(f.data),f.address)).toThrow('POOL_ACCOUNT_GRAPH');});
  it('rejects tick bitmap coverage requiring unmodeled arrays',()=>{const f=poolFixture(1);f.data[968]=0;expect(()=>decodeRaydiumPool(info(f.data),f.address)).toThrow('EXTENSION_REQUIRED');});
  it('uses integer local math and rejects traversal rather than clipping',()=>{const p=poolFixture(1).pool;const q=quoteRaydiumCell(10000n,p.liquidity,p.sqrtPrice,p.tick,p.spacing,2500,true,50);expect(q.expected>0n&&q.minimum<=q.expected).toBe(true);expect(()=>quoteRaydiumCell(100000000000000n,p.liquidity,p.sqrtPrice,p.tick,p.spacing,2500,true,50)).toThrow('TICK_CROSSING');});
  it('accepts only initialized classic token accounts without delegate/close authority',()=>{const t=token(mint0,wallet);expect(validateClassicTokenAccount(t,mint0,wallet)).toBe(1000n);expect(()=>validateClassicTokenAccount({...t,owner:TOKEN_2022_PROGRAM_ID},mint0,wallet)).toThrow();for(const offset of [72,129]){const bad=token(mint0,wallet);bad.data.writeUInt32LE(1,offset);expect(()=>validateClassicTokenAccount(bad,mint0,wallet)).toThrow();}});
  it('passes a locally constructed exact-input instruction',()=>{const e=evidence();expect(()=>inspectRaydiumInstruction(raydiumInstruction(e),e)).not.toThrow();});
  it.each(['program','discriminator','input','minimum','sqrt','exactOut','extra','signer','writable','alias','config','pool','vault','observation','tick','token2022','hash','capability','tickIndex','mint'] as const)('rejects %s mutation',kind=>{
    const e=evidence(),ix=raydiumInstruction(e);
    if(kind==='program')ix.programId=key(80);
    if(kind==='discriminator')ix.data[0]^=1;
    if(kind==='input')ix.data.writeBigUInt64LE(e.inputAmount+1n,8);
    if(kind==='minimum')ix.data.writeBigUInt64LE(e.minimumOutput+1n,16);
    if(kind==='sqrt')ix.data[24]=1;
    if(kind==='exactOut')ix.data[40]=0;
    if(kind==='extra')ix.keys.push({pubkey:key(70),isSigner:false,isWritable:false});
    if(kind==='signer')ix.keys[1]!.isSigner=true;
    if(kind==='writable')ix.keys[1]!.isWritable=true;
    if(kind==='alias')ix.keys[5]!.pubkey=ix.keys[6]!.pubkey;
    const indexes:Record<string,number>={config:1,pool:2,vault:5,observation:7,tick:9,token2022:8};
    if(kind in indexes)ix.keys[indexes[kind]!]!.pubkey=kind==='token2022'?TOKEN_2022_PROGRAM_ID:key(71);
    if(kind==='hash')e.instructionHash='f'.repeat(64);
    if(kind==='capability')e.capability={...RAYDIUM_CAPABILITY,builderVersion:99} as unknown as typeof RAYDIUM_CAPABILITY;
    if(kind==='tickIndex')e.tickArrayStart=600;
    if(kind==='mint')e.inputMint=mint0.toBase58();
    expect(()=>inspectRaydiumInstruction(ix,e)).toThrow();
  });
  it('decodes Raptor exact input, expected, minimum and split allocation',()=>{expect(decodeRaptorClmmSwap(raptorData())).toMatchObject({input:80n,expected:110n,minimum:100n,dex:6});});
  it.each([0,32,44,48,52,56,57,61,62,65,67])('rejects Raptor unmodeled layout/fee at byte %i',offset=>{const data=raptorData();data[offset]=255;expect(()=>decodeRaptorClmmSwap(data)).toThrow();});
  it('does not confuse matching quote data/hash with correct encoded Raptor input',()=>{const p=planFixture();p.instructions[2]!.data.writeBigUInt64LE(81n,8);p.instructions[2]!.data.writeBigUInt64LE(81n,36);p.aggregatorEvidence!.sourceInstructionHashes[0]=instructionHash(p.instructions[2]!);expect(inspectAtomicTransaction(p).passed).toBe(false);});
  it('accepts complete exact chain, rejects expected-output-as-input and 1-atomic mismatch',()=>{const p=planFixture();expect(inspectAtomicTransaction(p).passed).toBe(true);p.aggregatorEvidence!.legs[1].inputAmount=110n;expect(inspectAtomicTransaction(p).passed).toBe(false);p.aggregatorEvidence!.legs[1].inputAmount=101n;expect(inspectAtomicTransaction(p).passed).toBe(false);});
  it('rejects unexpected setup, cleanup and compute changes',()=>{for(const mutate of [(p:AtomicExecutionPlan)=>p.instructions.push(new TransactionInstruction({programId:SystemProgram.programId,keys:[],data:Buffer.alloc(0)})),(p:AtomicExecutionPlan)=>{p.computeUnitLimit=500001;},(p:AtomicExecutionPlan)=>{p.intermediateAta.exists=false;}]){const p=planFixture();mutate(p);expect(inspectAtomicTransaction(p).passed).toBe(false);}});
  it('preserves exactly the six prior pairs and adds only raptor:raydium',()=>{expect([...EXECUTABLE_PROVIDER_PAIRS].sort()).toEqual(['raptor:jupiter','jupiter:raptor','jupiter:orca','orca:jupiter','raptor:orca','orca:raptor','raptor:raydium'].sort());});
  it('generic Raydium quote cannot claim the capability using only its program label',()=>{const q={provider:'raydium',swapMode:'ExactIn',isPartialFill:false,poolIds:['p'],routePlan:[{swapInfo:{ammKey:'p',programId:RAYDIUM_CLMM_PROGRAM}}]} as Quote;expect(quoteMatchesExecutableProviderPolicy(q)).toBe(false);q.executionCapabilityId=RAYDIUM_ADAPTER_ID;expect(quoteMatchesExecutableProviderPolicy(q)).toBe(true);q.routePlan[0]!.swapInfo.programId=TOKEN_2022_PROGRAM_ID.toBase58();expect(quoteMatchesExecutableProviderPolicy(q)).toBe(false);});
  it('advisory program hint expires and cannot reset quote freshness',()=>{rememberRaydiumClmmPool('fixture',100);expect(raydiumClmmHint('fixture',101)).toBe(RAYDIUM_CLMM_PROGRAM);expect(raydiumClmmHint('fixture',60101)).toBeUndefined();});
  it('does not let scanner optimistic totals affect executor economics',()=>{const p=planFixture();const simulation={estimatedBaseFeeLamports:5000} as SimulationResult;const before=calculateExecutorEconomics(p,simulation);Object.assign(p,{scannerExpectedNet:'999999999999'});expect(calculateExecutorEconomics(p,simulation)).toEqual(before);});
  it('missing/foreign/deactivated ALT fails closed',async()=>{for(const value of [null,info(Buffer.alloc(56),SystemProgram.programId),info(Buffer.alloc(56),new PublicKey('AddressLookupTab1e1111111111111111111111111'))]){const connection={getMultipleAccountsInfoAndContext:async()=>({context:{slot:100},value:[value]})} as unknown as Connection;await expect(loadRaydiumLookupTables(connection,[key(30).toBase58()])).rejects.toThrow();}});
  it('read-only connection never calls a transport even on accidental send',()=>{const send=vi.fn();const guarded=noBroadcastRaydiumConnection({sendRawTransaction:send} as unknown as Connection);expect(guarded.counters.submissionAttempts).toBe(0);expect(()=>guarded.connection.sendRawTransaction(Buffer.alloc(0))).toThrow('NO_BROADCAST');expect(send).not.toHaveBeenCalled();});
  it('no new validation entrypoint can load a signer or submit',async()=>{const source=await readFile('src/execution/raptor-raydium-validation.ts','utf8');expect(source).not.toMatch(/loadDedicatedSigner|signApprovedExecution|autoExecute\(|createSubmissionBroadcaster/);expect(await readFile('src/execution/raydium-swap-builder.ts','utf8')).not.toMatch(/VersionedTransaction\.deserialize|\.execute\(|\.sendTransaction\(/);});
  it('strict handoff refuses provider transaction bytes and mismatched capability fingerprints',()=>{const p=planFixture(),h=handoffFixture(p);expect(parseAggregatorAtomicHandoff(h).providers).toEqual(['raptor','raydium']);expect(()=>parseAggregatorAtomicHandoff({...h,transaction:'untrusted-provider-bytes'})).toThrow();expect(compareExecutionRouteAlignment(h,p).passed).toBe(true);h.routeEvidence!.leg2.normalizedRouteLabel='raydium:cpmm';h.routeFingerprint=routeEvidenceFingerprint(h.routeEvidence!);expect(compareExecutionRouteAlignment(h,p).passed).toBe(false);h.routeEvidence!.policyHash='0'.repeat(64);expect(compareExecutionRouteAlignment(h,p).code).toBe('POLICY_VERSION_MISMATCH');});
  it('rejects oversized packets before simulation and never calls a network transport',async()=>{const p=planFixture();p.instructions[2]!.data=Buffer.alloc(2000);const simulate=vi.fn(),send=vi.fn();await expect(simulateAtomicTransaction({simulateTransaction:simulate,sendRawTransaction:send} as unknown as Connection,p,{publicKey:p.wallet},undefined,undefined,{value:{blockhash:key(99).toBase58(),lastValidBlockHeight:999},retrievedAt:1000,retrievalMs:0})).rejects.toThrow(/packet|encoding/);expect(simulate).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();});
});

function simulationFixture(){
  const plan=planFixture(),e=plan.raydiumEvidence!,p=e.firstPool;
  const message=new TransactionMessage({payerKey:wallet,recentBlockhash:key(99).toBase58(),instructions:plan.instructions}).compileToV0Message();
  const addresses=message.staticAccountKeys.map(k=>k.toBase58());
  const tokens=new Map<string,AccountInfo<Buffer>>([[plan.baseAta.ata,token(mint0,wallet)],[plan.intermediateAta.ata,token(mint1,wallet)],[p.vault0.toBase58(),token(mint0,p.address)],[p.vault1.toBase58(),token(mint1,p.address)],[e.leg.inputVault,token(mint1,new PublicKey(e.leg.pool))],[e.leg.outputVault,token(mint0,new PublicKey(e.leg.pool))]]);
  const poolAccounts=new Map<string,AccountInfo<Buffer>>();
  for(const fixture of [poolFixture(1),poolFixture(2)]){
    poolAccounts.set(fixture.address.toBase58(),info(fixture.data));
    const observation=Buffer.alloc(4483);raydiumDiscriminator('account:ObservationState').copy(observation);fixture.address.toBuffer().copy(observation,19);
    poolAccounts.set(fixture.pool.observation.toBase58(),info(observation));
    const ticks=Buffer.alloc(10240);raydiumDiscriminator('account:TickArrayState').copy(ticks);fixture.address.toBuffer().copy(ticks,8);ticks.writeInt32LE(fixture.pool.start,40);
    poolAccounts.set(fixture.pool.tickArray.toBase58(),info(ticks));
  }
  const accounts=addresses.map(a=>tokens.get(a)??poolAccounts.get(a)??info(Buffer.alloc(0),SystemProgram.programId));
  const snapshot:RaydiumSimulationSnapshot={addresses,accounts,slot:123,message:Buffer.from(message.serialize())};
  const transfer=(source:string,destination:string,authority:string,amount:string)=>({program:'spl-token',programId:TOKEN_PROGRAM_ID,parsed:{type:'transfer',info:{source,destination,authority,amount}}});
  const ts=[transfer(plan.baseAta.ata,p.vault0.toBase58(),plan.wallet,'80'),transfer(p.vault1.toBase58(),plan.intermediateAta.ata,p.address.toBase58(),'110'),transfer(plan.intermediateAta.ata,e.leg.inputVault,plan.wallet,'100'),transfer(e.leg.outputVault,plan.baseAta.ata,e.leg.pool,'110')];
  const firstIx=raydiumInstruction({...e.leg,pool:p.address.toBase58(),config:p.config.toBase58(),inputMint:plan.inputMint,outputMint:plan.intermediateMint,sourceAta:plan.baseAta.ata,destinationAta:plan.intermediateAta.ata,inputVault:p.vault0.toBase58(),outputVault:p.vault1.toBase58(),observation:p.observation.toBase58(),tickArray:p.tickArray.toBase58(),inputAmount:80n,minimumOutput:100n});
  const delta=new Map<string,bigint>();for(const t of ts){const x=t.parsed.info;delta.set(x.source,(delta.get(x.source)??0n)-BigInt(x.amount));delta.set(x.destination,(delta.get(x.destination)??0n)+BigInt(x.amount));}
  const response:SimulatedTransactionResponse={err:null,unitsConsumed:100000,logs:[`Program ${RAPTOR_PROGRAM_ID.toBase58()} invoke [1]`,`Program ${RAYDIUM_CLMM_PROGRAM} invoke [2]`],innerInstructions:[{index:2,instructions:[{programId:program,accounts:firstIx.keys.map(k=>k.pubkey),data:getBase58Decoder().decode(firstIx.data)},ts[0]!,ts[1]!]},{index:3,instructions:[ts[2]!,ts[3]!]}],accounts:accounts.map((a,i)=>{const data=Buffer.from(a.data),address=addresses[i]!;if(delta.has(address))data.writeBigUInt64LE(data.readBigUInt64LE(64)+delta.get(address)!,64);return {...a,owner:a.owner.toBase58(),data:[data.toString('base64'),'base64'],lamports:a.lamports-(address===plan.wallet?5000:0)};})};
  return {plan,message,snapshot,response};
}
describe('simulation-effect authority, not err=null alone',()=>{
  it('accepts exact modeled transfers and fee in the same confirmed bank',()=>{const f=simulationFixture();expect(()=>inspectRaydiumSimulationEffects(f.plan,f.message,f.snapshot,f.response,123,5000)).not.toThrow();});
  it.each(['cpi','token','sol','closure','creation','compute','logs','bank','owner','mint','missingEffects'] as const)('rejects success with %s anomaly',kind=>{const f=simulationFixture();let slot=123;
    if(kind==='cpi')f.response.logs!.push(`Program ${key(70).toBase58()} invoke [2]`);
    if(kind==='token')(f.response.innerInstructions![1]!.instructions[0] as any).parsed.info.amount='101';
    if(kind==='sol')f.response.accounts![0]!.lamports--;
    if(kind==='closure')f.response.accounts![0]=null;
    if(kind==='creation')f.snapshot.accounts[0]=null;
    if(kind==='compute')f.response.unitsConsumed=500001;
    if(kind==='logs')f.response.logs!.push('Log truncated');
    if(kind==='bank')slot++;
    if(kind==='owner')f.response.accounts![0]!.owner=program.toBase58();
    if(kind==='mint'){const i=f.snapshot.addresses.indexOf(f.plan.baseAta.ata),d=Buffer.from(f.response.accounts![i]!.data[0]!,'base64');d[0]^=1;f.response.accounts![i]!.data[0]=d.toString('base64');}
    if(kind==='missingEffects')f.response.innerInstructions=null;
    expect(()=>inspectRaydiumSimulationEffects(f.plan,f.message,f.snapshot,f.response,slot,5000)).toThrow();
  });
});

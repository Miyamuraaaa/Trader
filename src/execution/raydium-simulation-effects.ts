import { ComputeBudgetProgram, PublicKey, type AccountInfo, type Connection, type MessageV0, type SimulatedTransactionResponse } from '@solana/web3.js';
import { getBase58Encoder } from '@solana/kit';
import { TOKEN_PROGRAM_ID } from './account-preflight.js';
import { RAPTOR_PROGRAM_ID } from './aggregator-cycle-builder.js';
import { RAYDIUM_CLMM_PROGRAM } from './raydium-capability.js';
import { raydiumDiscriminator, validateClassicTokenAccount } from './raydium-swap-builder.js';
import { loadRaydiumLookupTables } from './raptor-raydium-cycle-builder.js';
import type { AtomicExecutionPlan } from './types.js';

function requireEffect(ok:unknown,reason:string):asserts ok{if(!ok)throw new Error(`RAYDIUM_SIMULATION_${reason}`);}
export interface RaydiumSimulationSnapshot { addresses:string[];accounts:(AccountInfo<Buffer>|null)[];slot:number;message:Buffer; }
export async function prepareRaydiumSimulation(connection:Connection,plan:AtomicExecutionPlan,message:MessageV0):Promise<RaydiumSimulationSnapshot>{
  requireEffect(plan.raydiumEvidence,'EVIDENCE_MISSING');
  const tables=await loadRaydiumLookupTables(connection,(plan.lookupTableAccounts??[]).map(t=>t.key.toBase58()));
  for(const [i,t]of tables.entries()){
    const original=plan.lookupTableAccounts![i]!;
    requireEffect(t.state.addresses.length===original.state.addresses.length&&t.state.addresses.every((a,j)=>a.equals(original.state.addresses[j]!)),'ALT_CHANGED');
  }
  const resolved=message.getAccountKeys({addressLookupTableAccounts:tables});
  requireEffect(resolved.length<=64&&message.header.numRequiredSignatures===1,'ACCOUNT_OR_SIGNER_LIMIT');
  const addresses=Array.from({length:resolved.length},(_,i)=>resolved.get(i)!.toBase58());
  requireEffect(new Set(addresses).size===addresses.length,'ACCOUNT_ALIAS');
  const e=plan.raydiumEvidence;
  addresses.forEach((a,i)=>requireEffect(a===ComputeBudgetProgram.programId.toBase58()||e.writableAccounts.includes(a)||e.readonlyAccounts.includes(a),'COMPILED_UNKNOWN_ACCOUNT'));
  addresses.forEach((a,i)=>requireEffect(!message.isAccountWritable(i)||e.writableAccounts.includes(a),'COMPILED_WRITABLE'));
  const response=await connection.getMultipleAccountsInfoAndContext(addresses.map(a=>new PublicKey(a)),{commitment:'confirmed',minContextSlot:e.leg.slot});
  if(response.value.some(value=>value===null))throw new Error('RAYDIUM_SIMULATION_ACCOUNT_MISSING');
  for(const a of [RAPTOR_PROGRAM_ID.toBase58(),RAYDIUM_CLMM_PROGRAM,TOKEN_PROGRAM_ID.toBase58()]){
    const index=addresses.indexOf(a);requireEffect(index>=0&&response.value[index]?.executable,'PROGRAM_NOT_EXECUTABLE');
  }
  return {addresses,accounts:response.value,slot:response.context.slot,message:Buffer.from(message.serialize())};
}

/** Missing effect evidence is a rejection, not a successful simulation. */
export function inspectRaydiumSimulationEffects(plan:AtomicExecutionPlan,message:MessageV0,snapshot:RaydiumSimulationSnapshot,result:SimulatedTransactionResponse,slot:number,feeLamports:number):void{
  const e=plan.raydiumEvidence, legs=plan.aggregatorEvidence?.legs;
  requireEffect(e&&legs,'EVIDENCE_MISSING');
  requireEffect(snapshot.message.equals(Buffer.from(message.serialize())),'MESSAGE_CHANGED');
  // Separate RPC snapshots cannot prove deltas across banks. Fail closed rather
  // than explaining away external movements or refreshing/resetting freshness.
  requireEffect(slot===snapshot.slot,'CONTEXT_CHANGED');
  requireEffect(result.err===null&&result.unitsConsumed!==undefined&&result.unitsConsumed>0&&result.unitsConsumed<=(plan.computeUnitLimit??0),'ERROR_OR_COMPUTE');
  requireEffect(result.logs&&result.logs.length>0&&!result.logs.some(l=>/failed:|Log truncated/.test(l)),'LOG_FAILURE_OR_TRUNCATION');
  const memo='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  const allowedPrograms=new Set([RAPTOR_PROGRAM_ID.toBase58(),RAYDIUM_CLMM_PROGRAM,TOKEN_PROGRAM_ID.toBase58(),memo,ComputeBudgetProgram.programId.toBase58()]);
  for(const line of result.logs){const match=/^Program (\S+) invoke \[\d+\]$/.exec(line);if(match)requireEffect(allowedPrograms.has(match[1]!),'UNEXPECTED_CPI');}
  const groups=result.innerInstructions;
  requireEffect(groups&&groups.length===2&&groups[0]!.index===2&&groups[1]!.index===3,'INNER_INSTRUCTION_COVERAGE');
  const transfers:{index:number;source:string;destination:string;authority:string;amount:bigint}[]=[];
  let firstSwapCount=0;
  for(const group of groups)for(const ix of group.instructions){
    const program=ix.programId.toBase58();requireEffect(allowedPrograms.has(program),'UNEXPECTED_CPI');
    if(program===RAYDIUM_CLMM_PROGRAM){
      requireEffect(group.index===2&&!('parsed'in ix),'UNEXPECTED_CLMM_CPI');firstSwapCount++;
      const data=Buffer.from(getBase58Encoder().encode(ix.data));
      const v2=data.subarray(0,8).equals(raydiumDiscriminator('global:swap_v2'));
      requireEffect(data.length===41&&(v2||data.subarray(0,8).equals(raydiumDiscriminator('global:swap')))
        &&data.readBigUInt64LE(8)===plan.inputAmount&&data[40]===1&&data.subarray(24,40).every(x=>x===0),'RAPTOR_CPI_AMOUNT_OR_VARIANT');
      const p=e.firstPool,zero=plan.inputMint===p.mint0.toBase58();
      const roles=[plan.wallet,p.config.toBase58(),p.address.toBase58(),plan.baseAta.ata,plan.intermediateAta.ata,(zero?p.vault0:p.vault1).toBase58(),(zero?p.vault1:p.vault0).toBase58(),p.observation.toBase58(),TOKEN_PROGRAM_ID.toBase58(),
        ...(v2?['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',memo,plan.inputMint,plan.intermediateMint]:[]),p.tickArray.toBase58()];
      requireEffect(ix.accounts.length===roles.length&&ix.accounts.every((a,i)=>a.toBase58()===roles[i]),'RAPTOR_CPI_ACCOUNT_GRAPH');
    }else if(program===TOKEN_PROGRAM_ID.toBase58()){
      requireEffect('parsed'in ix,'UNPARSED_TOKEN_EFFECT');
      const parsed=ix.parsed as {type?:string;info?:Record<string,unknown>};const info=parsed.info;
      requireEffect(info&&(parsed.type==='transfer'||parsed.type==='transferChecked'),'UNEXPECTED_TOKEN_OPERATION');
      const amount=parsed.type==='transfer'?info.amount:(info.tokenAmount as {amount?:unknown}|undefined)?.amount;
      requireEffect(typeof amount==='string'&&/^[1-9]\d*$/.test(amount)&&typeof info.source==='string'&&typeof info.destination==='string'&&typeof info.authority==='string','MALFORMED_TRANSFER');
      transfers.push({index:group.index,source:info.source,destination:info.destination,authority:info.authority,amount:BigInt(amount)});
    }else requireEffect(program===memo,'UNEXPECTED_INNER_OPERATION');
  }
  requireEffect(firstSwapCount===1&&transfers.length===4,'TRANSFER_COUNT');
  const p=e.firstPool,zero=plan.inputMint===p.mint0.toBase58();
  const expected=[{index:2,source:plan.baseAta.ata,destination:(zero?p.vault0:p.vault1).toBase58(),authority:plan.wallet,amount:plan.inputAmount},
    {index:2,source:(zero?p.vault1:p.vault0).toBase58(),destination:plan.intermediateAta.ata,authority:p.address.toBase58(),minimum:legs[0].minimumOutputAmount},
    {index:3,source:plan.intermediateAta.ata,destination:e.leg.inputVault,authority:plan.wallet,amount:legs[0].minimumOutputAmount},
    {index:3,source:e.leg.outputVault,destination:plan.baseAta.ata,authority:e.leg.pool,minimum:plan.minimumOutputAmount}];
  expected.forEach((x,i)=>{const t=transfers[i]!;requireEffect(t.index===x.index&&t.source===x.source&&t.destination===x.destination&&t.authority===x.authority&&(x.amount!==undefined?t.amount===x.amount:t.amount>=x.minimum!),'TOKEN_MOVEMENT');});
  requireEffect(result.accounts&&result.accounts.length===snapshot.addresses.length,'POST_ACCOUNTS_MISSING');
  const deltas=new Map<string,bigint>();for(const t of transfers){deltas.set(t.source,(deltas.get(t.source)??0n)-t.amount);deltas.set(t.destination,(deltas.get(t.destination)??0n)+t.amount);}
  const mutablePoolAccounts=new Set([p.address,p.observation,p.tickArray].map(x=>x.toBase58()).concat([e.leg.pool,e.leg.observation,e.leg.tickArray]));
  for(let i=0;i<snapshot.addresses.length;i++){
    const address=snapshot.addresses[i]!, before=snapshot.accounts[i],after=result.accounts[i];
    requireEffect(!!before===!!after,'ACCOUNT_CREATION_OR_CLOSURE');if(!before||!after)continue;
    requireEffect(after.owner===before.owner.toBase58()&&after.executable===before.executable,'ACCOUNT_OWNER_CHANGED');
    requireEffect(Number.isSafeInteger(after.lamports)&&Number.isSafeInteger(before.lamports)&&after.lamports-before.lamports===(address===plan.wallet?-feeLamports:0),'SOL_OR_RENT_DELTA');
    requireEffect(Array.isArray(after.data)&&after.data[1]==='base64','POST_DATA_ENCODING');
    const bytes=Buffer.from(after.data[0]!,'base64');
    if(deltas.has(address)){
      requireEffect(before.owner.equals(TOKEN_PROGRAM_ID)&&before.data.length===165&&bytes.length===165,'TOKEN_LAYOUT');
      const mint=new PublicKey(before.data.subarray(0,32)),owner=new PublicKey(before.data.subarray(32,64));
      const pre=validateClassicTokenAccount(before,mint,owner);
      const post=validateClassicTokenAccount({...before,data:bytes},mint,owner);
      requireEffect(post-pre===deltas.get(address)&&bytes.subarray(0,64).equals(before.data.subarray(0,64))&&bytes.subarray(72).equals(before.data.subarray(72)),'TOKEN_DELTA_OR_AUTHORITY');
    }else if(mutablePoolAccounts.has(address)){
      requireEffect(before.owner.toBase58()===RAYDIUM_CLMM_PROGRAM&&bytes.length===before.data.length,'POOL_MUTATION');
      // Pool identity/config/mints/vaults and tick-array identity may never change.
      const immutablePrefix=address===p.address.toBase58()||address===e.leg.pool?237:address===p.tickArray.toBase58()||address===e.leg.tickArray?44:8;
      requireEffect(bytes.subarray(0,immutablePrefix).equals(before.data.subarray(0,immutablePrefix)),'POOL_GRAPH_MUTATION');
    }
    else requireEffect(bytes.equals(before.data),'UNEXPECTED_ACCOUNT_MUTATION');
  }
}

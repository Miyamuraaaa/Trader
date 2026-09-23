import { createHash } from 'node:crypto';
import { Connection, PublicKey, TransactionInstruction, type AccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, associatedTokenAddress } from './account-preflight.js';
import { RAYDIUM_CLMM_PROGRAM, RAYDIUM_CAPABILITY } from './raydium-capability.js';
import { RAYDIUM_ADAPTER_ID, rememberRaydiumClmmPool } from './raydium-capability.js';
import type { Quote } from '../aggregators/types.js';

// Binary protocol/layout and integer rounding reference: official raydium-clmm
// states/{pool,config,tick_array,oracle}.rs and libraries/{tick_math,sqrt_price_math,swap_math}.rs.
// No Trade API/SDK accounts, bytes, send helper or floating point token arithmetic.
const PROGRAM = new PublicKey(RAYDIUM_CLMM_PROGRAM);
const Q64 = 1n << 64n;
const U64 = (1n << 64n) - 1n;
export const raydiumDiscriminator = (name: string) => createHash('sha256').update(name).digest().subarray(0, 8);
const keyAt = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32));
const u128 = (data: Buffer, offset: number) => data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
const pda = (seed: string, ...parts: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], PROGRAM)[0];
function check(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(`RAYDIUM_${reason}`); }
const uint64 = (n: bigint) => { check(n > 0n && n <= U64, 'INVALID_AMOUNT'); return n; };
function account(info: AccountInfo<Buffer> | null, owner: PublicKey, length: number, kind?: string): Buffer {
  check(info && info.owner.equals(owner) && !info.executable && info.data.length === length, 'ACCOUNT_OWNER_OR_LAYOUT');
  if (kind) check(info.data.subarray(0, 8).equals(raydiumDiscriminator(`account:${kind}`)), 'ACCOUNT_DISCRIMINATOR');
  return info.data;
}
export function decodeRaydiumPool(info: AccountInfo<Buffer> | null, address: PublicKey) {
  const data = account(info, PROGRAM, 1544, 'PoolState');
  const config = keyAt(data, 9), mint0 = keyAt(data, 73), mint1 = keyAt(data, 105);
  check(address.equals(pda('pool', config.toBuffer(), mint0.toBuffer(), mint1.toBuffer())), 'POOL_PDA');
  check(Buffer.compare(mint0.toBuffer(), mint1.toBuffer()) < 0, 'MINT_ORDER');
  check((data[389]! & 16) === 0 && data[390] === 0 && data.subarray(391, 397).every(x => x === 0)
    && data.subarray(1096, 1176).every(x => x === 0), 'UNSUPPORTED_STATUS_DYNAMIC_FEE_OR_PERMISSIONED_POOL');
  const spacing = data.readUInt16LE(235), tick = data.readInt32LE(269);
  check(spacing > 0 && spacing <= 1000 && Math.abs(tick) < 443636, 'TICK_RANGE');
  const start = Math.floor(tick / (60 * spacing)) * 60 * spacing;
  const bitmapIndex = start / (60 * spacing) + 512;
  check(bitmapIndex >= 0 && bitmapIndex < 1024 && (data[904 + Math.floor(bitmapIndex / 8)]! & (1 << (bitmapIndex % 8))) !== 0, 'CURRENT_ARRAY_UNINITIALIZED_OR_EXTENSION_REQUIRED');
  const vault0 = pda('pool_vault', address.toBuffer(), mint0.toBuffer());
  const vault1 = pda('pool_vault', address.toBuffer(), mint1.toBuffer());
  const observation = pda('observation', address.toBuffer());
  check(vault0.equals(keyAt(data, 137)) && vault1.equals(keyAt(data, 169)) && observation.equals(keyAt(data, 201)), 'POOL_ACCOUNT_GRAPH');
  const startBytes = Buffer.alloc(4); startBytes.writeInt32BE(start);
  return { address, config, mint0, mint1, vault0, vault1, observation, tickArray: pda('tick_array', address.toBuffer(), startBytes),
    start, spacing, tick, liquidity: u128(data, 237), sqrtPrice: u128(data, 253), decimals0: data[233]!, decimals1: data[234]!, openTime: data.readBigUInt64LE(1080) };
}
// Protocol Q64 reciprocal factors; integer multiplication truncates after each selected bit.
const FACTORS = ['fffcb933bd6fb800','fff97272373d4000','fff2e50f5f657000','ffe5caca7e10f000','ffcb9843d60f7000','ff973b41fa98e800','ff2ea16466c9b000','fe5dee046a9a3800','fcbe86c7900bb000','f987a7253ac65800','f3392b0822bb6000','e7159475a2caf000','d097f3bdfd2f2000','a9f746462d9f8000','70d869a156f31c00','31be135f97ed3200','9aa508b5b85a500','5d6af8dedc582c','2216e584f5fa'].map(x => BigInt(`0x${x}`));
export function raydiumSqrtAtTick(tick: number): bigint {
  check(Number.isInteger(tick) && Math.abs(tick) <= 443636, 'TICK_RANGE');
  let value = Q64; const bits = Math.abs(tick);
  for (let i = 0; i < FACTORS.length; i++) if ((bits & (1 << i)) !== 0) value = value * FACTORS[i]! >> 64n;
  return tick > 0 ? ((1n << 128n) - 1n) / value : value;
}
export function quoteRaydiumCell(input: bigint, liquidity: bigint, sqrt: bigint, tick: number, spacing: number, feeRate: number, zeroForOne: boolean, slippageBps: number) {
  uint64(input); check(liquidity > 0n && Number.isInteger(feeRate) && feeRate >= 0 && feeRate < 1_000_000, 'FEE_OR_LIQUIDITY');
  check(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps < 10000, 'SLIPPAGE');
  const lo = raydiumSqrtAtTick(Math.floor(tick / spacing) * spacing), hi = raydiumSqrtAtTick((Math.floor(tick / spacing) + 1) * spacing);
  check(sqrt >= raydiumSqrtAtTick(tick) && sqrt < raydiumSqrtAtTick(tick + 1), 'TICK_PRICE_MISMATCH');
  const netInput = input * BigInt(1_000_000 - feeRate) / 1_000_000n;
  const denominator = liquidity * Q64 + netInput * sqrt;
  const next = zeroForOne ? (liquidity * Q64 * sqrt + denominator - 1n) / denominator : sqrt + netInput * Q64 / liquidity;
  // No traversal approximation, clipping or resizing: reject before crossing even an uninitialized cell boundary.
  check(next > lo && next < hi && (zeroForOne ? next < sqrt : next > sqrt), 'TICK_CROSSING_OR_ZERO_OUTPUT_UNSUPPORTED');
  const expected = zeroForOne ? liquidity * (sqrt - next) / Q64 : liquidity * Q64 * (next - sqrt) / next / sqrt;
  const minimum = expected * BigInt(10000 - slippageBps) / 10000n;
  uint64(expected); uint64(minimum); return { expected, minimum, next };
}
export function validateClassicTokenAccount(info: AccountInfo<Buffer> | null, mint: PublicKey, owner: PublicKey) {
  const d = account(info, TOKEN_PROGRAM_ID, 165);
  check(keyAt(d, 0).equals(mint) && keyAt(d, 32).equals(owner) && d[108] === 1
    && d.readUInt32LE(72) === 0 && d.readBigUInt64LE(121) === 0n && d.readUInt32LE(129) === 0, 'TOKEN_ACCOUNT_AUTHORITY_OR_STATE');
  return d.readBigUInt64LE(64);
}
export interface RaydiumState {
  pool: ReturnType<typeof decodeRaydiumPool>; feeRate: number; evidenceAt: number; slot: number;
  outputVaultBalance0: bigint; outputVaultBalance1: bigint;
  stateHash: string;
}
export async function loadRaydiumState(connection: Connection, poolId: string, inputMint: string, outputMint: string): Promise<RaydiumState> {
  const address = new PublicKey(poolId), evidenceAt = Date.now();
  const first = await connection.getAccountInfoAndContext(address, 'confirmed');
  const initial = decodeRaydiumPool(first.value, address);
  const keys = [address, initial.config, initial.vault0, initial.vault1, initial.observation, initial.tickArray, initial.mint0, initial.mint1, PROGRAM];
  const fetched = await connection.getMultipleAccountsInfoAndContext(keys, {commitment:'confirmed', minContextSlot:first.context.slot});
  check(fetched.context.slot >= first.context.slot, 'CONTEXT_REGRESSION');
  const values = fetched.value, pool = decodeRaydiumPool(values[0] ?? null, address);
  check([pool.config,pool.vault0,pool.vault1,pool.observation,pool.tickArray,pool.mint0,pool.mint1].every((key,i)=>key.equals(keys[i+1]!)), 'POOL_GRAPH_CHANGED');
  check(new Set([pool.mint0.toBase58(),pool.mint1.toBase58()]).has(inputMint) && new Set([pool.mint0.toBase58(),pool.mint1.toBase58()]).has(outputMint) && inputMint !== outputMint, 'MINT_PATH');
  check(values[8]?.executable === true, 'PROGRAM_NOT_EXECUTABLE');
  const config = account(values[1] ?? null, PROGRAM, 117, 'AmmConfig');
  const index = Buffer.alloc(2);index.writeUInt16BE(config.readUInt16LE(9));
  check(pool.config.equals(pda('amm_config',index)) && config.readUInt16LE(51) === pool.spacing, 'CONFIG_PDA_OR_SPACING');
  const feeRate = config.readUInt32LE(47);
  check(config.readUInt32LE(43) + config.readUInt32LE(53) <= 1_000_000, 'CONFIG_FEE_SPLIT');
  const observation = account(values[4] ?? null, PROGRAM, 4483, 'ObservationState');
  check(keyAt(observation,19).equals(address), 'OBSERVATION_POOL');
  const ticks = account(values[5] ?? null, PROGRAM, 10240, 'TickArrayState');
  check(keyAt(ticks,8).equals(address) && ticks.readInt32LE(40) === pool.start, 'TICK_ARRAY_PDA_OR_START');
  let initialized = 0; let ahead = false;
  for (let i=0;i<60;i++) {
    const offset=44+i*168, tick=ticks.readInt32LE(offset), gross=u128(ticks,offset+20);
    check(ticks.readBigUInt64LE(offset+124)===0n && ticks.readBigUInt64LE(offset+132)===0n, 'LIMIT_ORDERS_UNSUPPORTED');
    if(gross>0n){initialized++;check(tick===pool.start+i*pool.spacing,'TICK_ARRAY_ORDER');if(inputMint===pool.mint0.toBase58()?tick<=pool.tick:tick>pool.tick)ahead=true;}
  }
  check(initialized===ticks[10124] && ahead, 'TICK_COVERAGE');
  for (const [i,decimals] of [[6,pool.decimals0],[7,pool.decimals1]] as const) {
    const mint=account(values[i]??null,TOKEN_PROGRAM_ID,82);check(mint[45]===1&&mint[44]===decimals,'MINT_STATE');
  }
  check(BigInt(Math.floor(Date.now()/1000))>pool.openTime,'POOL_NOT_OPEN');
  const outputVaultBalance0=validateClassicTokenAccount(values[2]??null,pool.mint0,address);
  const outputVaultBalance1=validateClassicTokenAccount(values[3]??null,pool.mint1,address);
  rememberRaydiumClmmPool(poolId);
  return {pool,feeRate,evidenceAt,slot:fetched.context.slot,outputVaultBalance0,outputVaultBalance1,
    stateHash:createHash('sha256').update(Buffer.concat(values.slice(0,8).map(v=>v!.data))).digest('hex')};
}
export interface RaydiumLegEvidence {
  capability: typeof RAYDIUM_CAPABILITY; family:'CLMM'; pool:string; inputMint:string; outputMint:string;
  inputAmount:bigint; expectedOutput:bigint; minimumOutput:bigint; wallet:string; sourceAta:string; destinationAta:string;
  config:string; inputVault:string; outputVault:string; observation:string; tickArray:string; tickArrayStart:number;
  tickCurrent:number; tickSpacing:number; sqrtPrice:bigint; liquidity:bigint; feeRate:number; slippageBps:number;
  quoteReceivedAt:number; slot:number; stateHash:string; instructionHash:string;
}
export function raydiumInstruction(e: Omit<RaydiumLegEvidence,'instructionHash'>): TransactionInstruction {
  const data=Buffer.alloc(41);raydiumDiscriminator('global:swap').copy(data);data.writeBigUInt64LE(uint64(e.inputAmount),8);data.writeBigUInt64LE(uint64(e.minimumOutput),16);
  // Zero sqrt limit enforces full fill on-chain; true = exact input. No remaining accounts.
  data[40]=1;
  const roles=[e.wallet,e.config,e.pool,e.sourceAta,e.destinationAta,e.inputVault,e.outputVault,e.observation,TOKEN_PROGRAM_ID.toBase58(),e.tickArray];
  return new TransactionInstruction({programId:PROGRAM,data,keys:roles.map((key,i)=>({pubkey:new PublicKey(key),isSigner:i===0,isWritable:[2,3,4,5,6,7,9].includes(i)}))});
}
export function raydiumInstructionHash(ix:TransactionInstruction):string {
  return createHash('sha256').update(Buffer.concat([ix.programId.toBuffer(),...ix.keys.map(k=>Buffer.concat([k.pubkey.toBuffer(),Buffer.from([Number(k.isSigner),Number(k.isWritable)])])),ix.data])).digest('hex');
}
export async function buildRaydiumSwapLeg(input:{connection:Connection;wallet:PublicKey;poolId:string;inputMint:string;outputMint:string;inputAmount:bigint;slippageBps:number}) {
  const state=await loadRaydiumState(input.connection,input.poolId,input.inputMint,input.outputMint);
  const zero=input.inputMint===state.pool.mint0.toBase58();
  const math=quoteRaydiumCell(input.inputAmount,state.pool.liquidity,state.pool.sqrtPrice,state.pool.tick,state.pool.spacing,state.feeRate,zero,input.slippageBps);
  check(math.expected<(zero?state.outputVaultBalance1:state.outputVaultBalance0),'INSUFFICIENT_VAULT');
  const evidence:Omit<RaydiumLegEvidence,'instructionHash'>={capability:RAYDIUM_CAPABILITY,family:'CLMM',pool:input.poolId,inputMint:input.inputMint,outputMint:input.outputMint,inputAmount:input.inputAmount,expectedOutput:math.expected,minimumOutput:math.minimum,
    wallet:input.wallet.toBase58(),sourceAta:associatedTokenAddress(new PublicKey(input.inputMint),input.wallet,TOKEN_PROGRAM_ID).toBase58(),destinationAta:associatedTokenAddress(new PublicKey(input.outputMint),input.wallet,TOKEN_PROGRAM_ID).toBase58(),
    config:state.pool.config.toBase58(),inputVault:(zero?state.pool.vault0:state.pool.vault1).toBase58(),outputVault:(zero?state.pool.vault1:state.pool.vault0).toBase58(),observation:state.pool.observation.toBase58(),tickArray:state.pool.tickArray.toBase58(),tickArrayStart:state.pool.start,
    tickCurrent:state.pool.tick,tickSpacing:state.pool.spacing,sqrtPrice:state.pool.sqrtPrice,liquidity:state.pool.liquidity,feeRate:state.feeRate,slippageBps:input.slippageBps,
    quoteReceivedAt:state.evidenceAt,slot:state.slot,stateHash:state.stateHash};
  const instruction=raydiumInstruction(evidence);
  return {instruction,evidence:{...evidence,instructionHash:raydiumInstructionHash(instruction)}};
}
/** Exact-pool scanner requote. It carries no execution authority or instructions. */
export async function quoteRaydiumExecutablePool(connection:Connection,poolId:string,inputMint:string,outputMint:string,amount:string,slippageBps:number):Promise<Quote>{
  const s=await loadRaydiumState(connection,poolId,inputMint,outputMint);
  const q=quoteRaydiumCell(BigInt(amount),s.pool.liquidity,s.pool.sqrtPrice,s.pool.tick,s.pool.spacing,s.feeRate,inputMint===s.pool.mint0.toBase58(),slippageBps);
  check(q.expected<(inputMint===s.pool.mint0.toBase58()?s.outputVaultBalance1:s.outputVaultBalance0),'INSUFFICIENT_VAULT');
  return {provider:'raydium',id:`raydium-clmm-${poolId}-${s.slot}-${amount}`,executionCapabilityId:RAYDIUM_ADAPTER_ID,inputMint,outputMint,inAmount:amount,consumedInAmount:amount,outAmount:String(q.expected),otherAmountThreshold:String(q.minimum),swapMode:'ExactIn',slippageBps,
    routePlan:[{percent:100,swapInfo:{label:'Raydium CLMM',ammKey:poolId,programId:RAYDIUM_CLMM_PROGRAM,inputMint,outputMint,inAmount:amount,outAmount:String(q.expected)}}],poolIds:[poolId],isPartialFill:false,contextSlot:s.slot,
    requestTimestamp:s.evidenceAt,responseTimestamp:s.evidenceAt,latencyMs:Date.now()-s.evidenceAt,rawResponse:JSON.stringify({family:'CLMM',programId:RAYDIUM_CLMM_PROGRAM,capability:RAYDIUM_ADAPTER_ID,poolId,slot:s.slot,stateHash:s.stateHash})};
}
export function inspectRaydiumInstruction(ix:TransactionInstruction,e:RaydiumLegEvidence):void {
  check(JSON.stringify(e.capability)===JSON.stringify(RAYDIUM_CAPABILITY)&&e.family==='CLMM','CAPABILITY_MISMATCH');
  const expected=raydiumInstruction(e);
  check(ix.programId.equals(PROGRAM)&&ix.data.equals(expected.data)&&ix.keys.length===10,'INSTRUCTION_VARIANT_OR_AMOUNTS');
  check(new Set(ix.keys.map(k=>k.pubkey.toBase58())).size===10,'ACCOUNT_ROLE_ALIAS');
  check(ix.keys.every((k,i)=>k.pubkey.equals(expected.keys[i]!.pubkey)&&k.isSigner===expected.keys[i]!.isSigner&&k.isWritable===expected.keys[i]!.isWritable),'ACCOUNT_ROLE_FLAGS');
  check(associatedTokenAddress(new PublicKey(e.inputMint),new PublicKey(e.wallet),TOKEN_PROGRAM_ID).toBase58()===e.sourceAta
    &&associatedTokenAddress(new PublicKey(e.outputMint),new PublicKey(e.wallet),TOKEN_PROGRAM_ID).toBase58()===e.destinationAta,'ATA_DERIVATION');
  const start=Buffer.alloc(4);start.writeInt32BE(e.tickArrayStart);
  const orderedMints=[new PublicKey(e.inputMint),new PublicKey(e.outputMint)].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
  check(Number.isInteger(e.tickSpacing)&&e.tickSpacing>0&&e.tickArrayStart===Math.floor(e.tickCurrent/(60*e.tickSpacing))*60*e.tickSpacing,'TICK_COVERAGE');
  const quote=quoteRaydiumCell(e.inputAmount,e.liquidity,e.sqrtPrice,e.tickCurrent,e.tickSpacing,e.feeRate,e.inputMint===orderedMints[0]!.toBase58(),e.slippageBps);
  check(quote.expected===e.expectedOutput&&quote.minimum===e.minimumOutput,'LOCAL_QUOTE_MISMATCH');
  check(pda('pool',new PublicKey(e.config).toBuffer(),orderedMints[0]!.toBuffer(),orderedMints[1]!.toBuffer()).toBase58()===e.pool,'POOL_PDA');
  check(pda('tick_array',new PublicKey(e.pool).toBuffer(),start).toBase58()===e.tickArray
    &&pda('observation',new PublicKey(e.pool).toBuffer()).toBase58()===e.observation
    &&pda('pool_vault',new PublicKey(e.pool).toBuffer(),new PublicKey(e.inputMint).toBuffer()).toBase58()===e.inputVault
    &&pda('pool_vault',new PublicKey(e.pool).toBuffer(),new PublicKey(e.outputMint).toBuffer()).toBase58()===e.outputVault,'ACCOUNT_PDA');
  check(raydiumInstructionHash(ix)===e.instructionHash,'SOURCE_INSTRUCTION_HASH');
}

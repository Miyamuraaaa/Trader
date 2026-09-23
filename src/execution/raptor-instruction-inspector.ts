import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from './account-preflight.js';
import { RAPTOR_PROGRAM_ID } from './aggregator-cycle-builder.js';

// Published Raptor V1 IDL: SwapParams, Route, FeeConfig (see P1-B source notes).
// Deliberately ONLY swap / one branch / one hop / one CLMM adapter / no fees.
// Do not prefix-decode unknown trailing fields, JIT, proxy or split variants.
export function decodeRaptorClmmSwap(data: Buffer) {
  const fail = () => { throw new Error('RAPTOR_UNSUPPORTED_INSTRUCTION_LAYOUT'); };
  if (data.length !== 76 || !data.subarray(0,8).equals(Buffer.from([248,198,158,145,225,117,135,200]))) fail();
  if ([32,44,48,52,57].some(offset=>data.readUInt32LE(offset)!==1)
    || ![6,11].includes(data[56]!) || data[61]!==100
    || data.readUInt16LE(62)!==0 || data[64]!>1 || data.readUInt16LE(65)!==0 || data[67]!==0) fail();
  const input=data.readBigUInt64LE(8), expected=data.readBigUInt64LE(16), minimum=data.readBigUInt64LE(24);
  if(input===0n || minimum===0n || minimum>expected || data.readBigUInt64LE(36)!==input) fail();
  return {input,expected,minimum,dex:data[56]!,orderId:data.readBigUInt64LE(68)};
}

export function inspectRaptorClmmSwap(ix:TransactionInstruction, expected:{wallet:string;sourceAta:string;destinationAta:string;inputMint:string;outputMint:string;input:bigint;minimum:bigint;expected:bigint}) {
  if(!ix.programId.equals(RAPTOR_PROGRAM_ID))throw new Error('RAPTOR_PROGRAM_MISMATCH');
  const decoded=decodeRaptorClmmSwap(ix.data);
  if(decoded.input!==expected.input || decoded.minimum!==expected.minimum || decoded.expected!==expected.expected)throw new Error('RAPTOR_ENCODED_AMOUNT_MISMATCH');
  if(ix.keys.length<14)throw new Error('RAPTOR_ACCOUNT_LAYOUT');
  const prefix=[expected.wallet,expected.sourceAta,expected.destinationAta,expected.inputMint,expected.outputMint];
  prefix.forEach((address,i)=>{
    const k=ix.keys[i]!;
    if(k.pubkey.toBase58()!==address || k.isSigner!==(i===0) || k.isWritable!==(i<3))throw new Error('RAPTOR_ACCOUNT_ROLE');
  });
  // Anchor optional accounts use the program ID sentinel. No fee/proxy authority.
  for(let i=5;i<=8;i++)if(!ix.keys[i]!.pubkey.equals(RAPTOR_PROGRAM_ID)||ix.keys[i]!.isWritable||ix.keys[i]!.isSigner)throw new Error('RAPTOR_FEE_OR_PROXY_ACCOUNT');
  const optional=[TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,new PublicKey('11111111111111111111111111111111')];
  optional.forEach((address,i)=>{const k=ix.keys[9+i]!;if((!k.pubkey.equals(address)&&!k.pubkey.equals(RAPTOR_PROGRAM_ID))||k.isSigner||k.isWritable)throw new Error('RAPTOR_OPTIONAL_ACCOUNT');});
  if(ix.keys.slice(1).some(k=>k.isSigner&&k.pubkey.toBase58()!==expected.wallet))throw new Error('RAPTOR_UNEXPECTED_SIGNER');
  return decoded;
}

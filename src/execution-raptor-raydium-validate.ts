import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { createExecutionConnection } from './execution/execution-connection.js';
import { validateRaptorRaydiumReadOnly } from './execution/raptor-raydium-validation.js';
import { writeAtomicJson } from './persistence/atomic-json-file.js';

async function main(){
  const arg=(name:string)=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
  const file=arg('candidate');
  if(!file||path.extname(file).toLowerCase()!=='.json'||(await stat(file)).size>32768)throw new Error('CANDIDATE_JSON_REQUIRED_MAX_32K');
  const wallet=arg('wallet')??CONFIG.botWalletAddress;
  if(!wallet)throw new Error('PUBLIC_WALLET_REQUIRED');
  const result=await validateRaptorRaydiumReadOnly(JSON.parse(await readFile(file,'utf8')),new PublicKey(wallet),createExecutionConnection());
  const output=path.resolve('data',`raptor-raydium-validation-${Date.now()}.json`);
  await writeAtomicJson(output,result);
  console.log(JSON.stringify(result,null,2));console.log(`Report: ${output}`);
}
void main().catch(error=>{
  // No provider payload, URL, signed message or key material is printed.
  const code=error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'RAPTOR_RAYDIUM_VALIDATION_FAILED';
  console.error(code);process.exitCode=1;
});

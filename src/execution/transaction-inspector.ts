import {
  DEFAULT_WHIRLPOOL_DEPLOYMENT,
  parseSwapV2Instruction,
  parseTwoHopSwapV2Instruction,
} from '@orca-so/whirlpools-client';
import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from './account-preflight.js';
import { JUPITER_V6_PROGRAM_ID, RAPTOR_PROGRAM_ID } from './aggregator-cycle-builder.js';
import type { AtomicExecutionPlan, InspectionResult } from './types.js';
import { web3InstructionToKit } from './instruction-adapter.js';
import { inspectRaydiumInstruction } from './raydium-swap-builder.js';
import { inspectRaptorClmmSwap } from './raptor-instruction-inspector.js';
import { RAYDIUM_CLMM_PROGRAM } from './raydium-capability.js';

function inspectRaptorRaydiumCycle(plan:AtomicExecutionPlan):InspectionResult {
  const reasons=inspectComputeBudget(plan);
  const programIds=[...new Set(plan.instructions.map(i=>i.programId.toBase58()))];
  try {
    const e=plan.raydiumEvidence, legs=plan.aggregatorEvidence?.legs;
    if(!e||!legs||plan.instructions.length!==4||plan.aggregatorEvidence?.providers.join(':')!=='raptor:raydium'
      ||!plan.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)||!plan.instructions[1]!.programId.equals(ComputeBudgetProgram.programId)
      ||plan.aggregatorEvidence.closesIntermediateAta||!plan.baseAta.exists||!plan.intermediateAta.exists
      ||plan.inputMint!==plan.outputMint||plan.inputMint===plan.intermediateMint||plan.pools[0]===plan.pools[1]
      ||plan.computeUnitLimit!==500000||plan.aggregatorEvidence.routeProgramIds.length!==1||plan.aggregatorEvidence.routeProgramIds[0]!==RAYDIUM_CLMM_PROGRAM
      ||plan.baseToken.status!=='SUPPORTED'||plan.intermediateToken.status!=='SUPPORTED'
      ||plan.baseToken.programId!==TOKEN_PROGRAM_ID.toBase58()||plan.intermediateToken.programId!==TOKEN_PROGRAM_ID.toBase58())throw new Error('RAYDIUM_PLAN_SHAPE');
    const [first,second]=legs, ray=e.leg;
    if(first.provider!=='raptor'||second.provider!=='raydium'||first.inputAmount!==plan.inputAmount
      ||first.minimumOutputAmount!==second.inputAmount||second.inputAmount!==ray.inputAmount||plan.expectedIntermediateAmount!==ray.inputAmount
      ||second.minimumOutputAmount!==ray.minimumOutput||plan.minimumOutputAmount!==ray.minimumOutput
      ||second.expectedOutputAmount!==ray.expectedOutput||plan.expectedOutputAmount!==ray.expectedOutput
      ||first.inputMint!==plan.inputMint||first.outputMint!==plan.intermediateMint||second.inputMint!==plan.intermediateMint||second.outputMint!==plan.outputMint
      ||ray.inputMint!==plan.intermediateMint||ray.outputMint!==plan.outputMint||ray.wallet!==plan.wallet
      ||ray.sourceAta!==plan.intermediateAta.ata||ray.destinationAta!==plan.baseAta.ata
      ||first.pool!==plan.pools[0]||e.firstPool.address.toBase58()!==first.pool||second.pool!==plan.pools[1]||ray.pool!==second.pool
      ||first.programId!==RAPTOR_PROGRAM_ID.toBase58()||first.downstreamProgramId!==RAYDIUM_CLMM_PROGRAM||second.programId!==RAYDIUM_CLMM_PROGRAM)throw new Error('RAYDIUM_EXACT_CHAIN_OR_POOL_MISMATCH');
    inspectRaptorClmmSwap(plan.instructions[2]!,{wallet:plan.wallet,sourceAta:plan.baseAta.ata,destinationAta:plan.intermediateAta.ata,inputMint:plan.inputMint,outputMint:plan.intermediateMint,input:plan.inputAmount,expected:first.expectedOutputAmount,minimum:first.minimumOutputAmount});
    inspectRaydiumInstruction(plan.instructions[3]!,ray);
    for(const ix of plan.instructions.slice(2))for(const k of ix.keys){const a=k.pubkey.toBase58();if((k.isSigner&&a!==plan.wallet)||(k.isWritable&&!e.writableAccounts.includes(a))||(!e.writableAccounts.includes(a)&&!e.readonlyAccounts.includes(a)))throw new Error('RAYDIUM_UNMODELED_ACCOUNT_ROLE');}
    const hashes=plan.instructions.slice(2).map(instructionHash);
    if(hashes.length!==plan.aggregatorEvidence.sourceInstructionHashes.length||hashes.some((h,i)=>h!==plan.aggregatorEvidence!.sourceInstructionHashes[i]))throw new Error('RAYDIUM_SOURCE_HASH_MISMATCH');
  }catch(error){reasons.push(error instanceof Error?error.message:'RAYDIUM_INSPECTION_FAILED');}
  return {passed:!reasons.length,reasons,programIds,instructionCount:plan.instructions.length};
}

export const EXECUTION_PROGRAM_ALLOWLIST = new Set([
  ComputeBudgetProgram.programId.toBase58(),
  String(DEFAULT_WHIRLPOOL_DEPLOYMENT.programId),
]);

export const AGGREGATOR_EXECUTION_PROGRAM_ALLOWLIST = new Set([
  ComputeBudgetProgram.programId.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  RAPTOR_PROGRAM_ID.toBase58(),
  JUPITER_V6_PROGRAM_ID.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
]);

/** Initial audited CPI surface. Unknown routes remain discovery-only. */
export const AGGREGATOR_CPI_PROGRAM_ALLOWLIST = new Set([
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
  'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq', // PancakeSwap Solana
  'ALPHAQmeA7bjrVuccPsYPiCvsi428SNwte66Srvs4pHA', // AlphaQ
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // passed by V2-capable routes; route mints remain classic SPL only
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // memo CPI support used by Token-2022-aware venues
]);

function accountAddress(value: { address: string }): string {
  return String(value.address);
}

function instructionHash(instruction: { programId: PublicKey; keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array }): string {
  const hash = createHash('sha256');
  hash.update(instruction.programId.toBuffer());
  for (const key of instruction.keys) {
    hash.update(key.pubkey.toBuffer());
  }
  hash.update(instruction.data);
  return hash.digest('hex');
}

function inspectComputeBudget(plan: AtomicExecutionPlan): string[] {
  const reasons: string[] = [];
  const compute = plan.instructions.filter((instruction) =>
    instruction.programId.equals(ComputeBudgetProgram.programId));
  if (compute.length !== 2) {
    reasons.push(`Expected exactly two compute-budget instructions, got ${compute.length}`);
    return reasons;
  }
  const [limit, price] = compute;
  if (limit!.data.length !== 5 || limit!.data[0] !== 2) {
    reasons.push('First compute instruction must set the unit limit');
  } else if (limit!.data.readUInt32LE(1) !== plan.computeUnitLimit) {
    reasons.push('Compute-unit limit differs from execution plan');
  }
  if (price!.data.length !== 9 || price!.data[0] !== 3) {
    reasons.push('Second compute instruction must set the unit price');
  } else {
    const encoded = price!.data.readBigUInt64LE(1);
    if (encoded !== BigInt(plan.computeUnitPriceMicroLamports ?? 0)) {
      reasons.push('Compute-unit price differs from execution economics');
    }
  }
  return reasons;
}

function inspectAggregatorCycle(plan: AtomicExecutionPlan): InspectionResult {
  const reasons: string[] = [];
  const evidence = plan.aggregatorEvidence;
  const programIds = [...new Set(plan.instructions.map((instruction) => instruction.programId.toBase58()))];
  const providerMap: Record<string, [string, string] | undefined> = {
    'RAPTOR_JUPITER_CYCLE': ['raptor', 'jupiter'],
    'JUPITER_RAPTOR_CYCLE': ['jupiter', 'raptor'],
    'JUPITER_ORCA_CYCLE': ['jupiter', 'orca'],
    'ORCA_JUPITER_CYCLE': ['orca', 'jupiter'],
    'RAPTOR_ORCA_CYCLE': ['raptor', 'orca'],
    'ORCA_RAPTOR_CYCLE': ['orca', 'raptor'],
  };
  const expectedProviders = providerMap[plan.type];

  if (!expectedProviders || !evidence || evidence.providers[0] !== expectedProviders[0]
    || evidence.providers[1] !== expectedProviders[1]) {
    reasons.push('Missing or invalid aggregator execution evidence');
  }
  if (plan.inputMint !== plan.outputMint || plan.inputMint === plan.intermediateMint) {
    reasons.push('Aggregator execution must be a complete cycle through a distinct intermediate mint');
  }
  if (plan.pools[0] === plan.pools[1]) reasons.push('Aggregator cycle pools must be distinct');
  const legs = evidence?.legs;
  if (!legs || legs.length !== 2) {
    reasons.push('Missing independently validated execution-leg evidence');
  } else {
    const [first, second] = legs;
    if (first.provider !== evidence.providers[0] || second.provider !== evidence.providers[1]) {
      reasons.push('Execution-leg providers do not match route evidence');
    }
    if (first.inputMint !== plan.inputMint || first.outputMint !== plan.intermediateMint
      || second.inputMint !== plan.intermediateMint || second.outputMint !== plan.outputMint) {
      reasons.push('Execution-leg mint chain does not match the approved cycle');
    }
    if (first.inputAmount !== plan.inputAmount
      || second.inputAmount !== first.minimumOutputAmount
      || plan.expectedIntermediateAmount !== first.minimumOutputAmount) {
      reasons.push('Execution-leg exact intermediate amount propagation mismatch');
    }
    if (second.minimumOutputAmount !== plan.minimumOutputAmount
      || second.expectedOutputAmount !== plan.expectedOutputAmount) {
      reasons.push('Final execution-leg output evidence mismatch');
    }
    if (first.pool !== plan.pools[0] || second.pool !== plan.pools[1]) {
      reasons.push('Execution-leg pool evidence mismatch');
    }
  }
  for (const programId of programIds) {
    if (!AGGREGATOR_EXECUTION_PROGRAM_ALLOWLIST.has(programId) && programId !== String(DEFAULT_WHIRLPOOL_DEPLOYMENT.programId)) {
      reasons.push(`Unexpected top-level program: ${programId}`);
    }
  }
  for (const programId of evidence?.routeProgramIds ?? []) {
    if (!AGGREGATOR_CPI_PROGRAM_ALLOWLIST.has(programId)) reasons.push(`Unapproved aggregator CPI program: ${programId}`);
  }
  if (plan.instructions.length < 4) reasons.push('Aggregator cycle is missing required instructions');
  reasons.push(...inspectComputeBudget(plan));

  const raptor = plan.instructions.filter((instruction) => instruction.programId.equals(RAPTOR_PROGRAM_ID));
  const jupiter = plan.instructions.filter((instruction) => instruction.programId.equals(JUPITER_V6_PROGRAM_ID));
  const orca = plan.instructions.filter((instruction) => instruction.programId.equals(new PublicKey(String(DEFAULT_WHIRLPOOL_DEPLOYMENT.programId))));
  const tokenInstructions = plan.instructions.filter((instruction) => instruction.programId.equals(TOKEN_PROGRAM_ID));

  const providerNames = evidence ? [evidence.providers[0], evidence.providers[1]] : [];
  const hasRaptor = providerNames.indexOf('raptor') >= 0;
  const hasJupiter = providerNames.indexOf('jupiter') >= 0;
  const hasOrca = providerNames.indexOf('orca') >= 0;

  if (hasRaptor && raptor.length !== 1) reasons.push(`Expected exactly one Raptor swap instruction, got ${raptor.length}`);
  if (hasJupiter && jupiter.length !== 1) reasons.push(`Expected exactly one Jupiter swap instruction, got ${jupiter.length}`);
  if (hasOrca && orca.length !== 1) reasons.push(`Expected exactly one Orca swap instruction, got ${orca.length}`);
  const expectedProgramByProvider = new Map([
    ['raptor', RAPTOR_PROGRAM_ID.toBase58()],
    ['jupiter', JUPITER_V6_PROGRAM_ID.toBase58()],
    ['orca', String(DEFAULT_WHIRLPOOL_DEPLOYMENT.programId)],
  ]);
  for (const leg of legs ?? []) {
    if (expectedProgramByProvider.get(leg.provider) !== leg.programId) {
      reasons.push(`Execution-leg program mismatch for ${leg.provider}`);
    }
  }

  if (hasOrca && orca.length === 1 && legs) {
    const orcaLeg = legs.find((leg) => leg.provider === 'orca');
    try {
      if (!orcaLeg) throw new Error('Orca leg evidence is absent');
      const parsed = parseSwapV2Instruction(web3InstructionToKit(orca[0]!));
      if (accountAddress(parsed.accounts.whirlpool) !== orcaLeg.pool) reasons.push('Orca leg pool mismatch');
      const mintA = accountAddress(parsed.accounts.tokenMintA);
      const mintB = accountAddress(parsed.accounts.tokenMintB);
      if (!new Set([mintA, mintB]).has(orcaLeg.inputMint)
        || !new Set([mintA, mintB]).has(orcaLeg.outputMint)) reasons.push('Orca leg mint pair mismatch');
      if (parsed.data.amount !== orcaLeg.inputAmount) reasons.push('Orca leg input amount mismatch');
      if (parsed.data.otherAmountThreshold !== orcaLeg.minimumOutputAmount) reasons.push('Orca leg minimum output mismatch');
      if (!parsed.data.amountSpecifiedIsInput) reasons.push('Orca mixed leg must use exact-input mode');
    } catch (error) {
      reasons.push(`Cannot decode Orca mixed instruction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const providerIndices = {
    raptor: plan.instructions.findIndex((instruction) => instruction.programId.equals(RAPTOR_PROGRAM_ID)),
    jupiter: plan.instructions.findIndex((instruction) => instruction.programId.equals(JUPITER_V6_PROGRAM_ID)),
    orca: plan.instructions.findIndex((instruction) => instruction.programId.equals(new PublicKey(String(DEFAULT_WHIRLPOOL_DEPLOYMENT.programId)))),
  };

  if (evidence) {
    const firstIdx = providerIndices[evidence.providers[0] as keyof typeof providerIndices];
    const secondIdx = providerIndices[evidence.providers[1] as keyof typeof providerIndices];
    if (firstIdx >= secondIdx) {
      reasons.push(`Compiled aggregator instruction order does not match ${evidence.providers[0]} -> ${evidence.providers[1]} evidence`);
    }
  }
  const expectedCloseCount = evidence?.closesIntermediateAta ? 1 : 0;
  if (tokenInstructions.length !== expectedCloseCount) {
    reasons.push(`Expected ${expectedCloseCount} WSOL close instruction(s), got ${tokenInstructions.length}`);
  }
  for (const instruction of tokenInstructions) {
    if (instruction.data.length !== 1 || instruction.data[0] !== 9 || instruction.keys.length !== 3) {
      reasons.push('Only the exact SPL Token CloseAccount instruction is allowed');
      continue;
    }
    const [account, destination, authority] = instruction.keys;
    if (account?.pubkey.toBase58() !== plan.intermediateAta.ata || !account.isWritable) reasons.push('CloseAccount targets an unexpected token account');
    if (destination?.pubkey.toBase58() !== plan.wallet || !destination.isWritable) reasons.push('CloseAccount destination is not the dedicated wallet');
    if (authority?.pubkey.toBase58() !== plan.wallet || !authority.isSigner) reasons.push('CloseAccount authority is not the dedicated wallet');
  }

  const allowedAtas = new Map([
    [plan.baseAta.ata, plan.inputMint],
    [plan.intermediateAta.ata, plan.intermediateMint],
  ]);
  const ataInstructions = plan.instructions.filter((instruction) => instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  for (const instruction of ataInstructions) {
    if (instruction.data.length !== 1 || instruction.data[0] !== 1) reasons.push('Only idempotent ATA creation is allowed');
    if (instruction.keys.length !== 6) { reasons.push('Unexpected ATA instruction account count'); continue; }
    const [payer, ata, owner, mint, , tokenProgram] = instruction.keys;
    if (payer?.pubkey.toBase58() !== plan.wallet || !payer.isSigner || !payer.isWritable) reasons.push('ATA payer is not the dedicated wallet');
    if (owner?.pubkey.toBase58() !== plan.wallet) reasons.push('ATA owner is not the dedicated wallet');
    if (tokenProgram?.pubkey.toBase58() !== TOKEN_PROGRAM_ID.toBase58()) reasons.push('ATA uses an unsupported token program');
    const expectedMint = ata ? allowedAtas.get(ata.pubkey.toBase58()) : undefined;
    if (!expectedMint || mint?.pubkey.toBase58() !== expectedMint) reasons.push('ATA instruction targets an unexpected account or mint');
  }
  for (const swap of [...raptor, ...jupiter, ...orca]) {
    const signers = [...new Set(swap.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58()))];
    if (signers.length !== 1 || signers[0] !== plan.wallet) reasons.push('Aggregator swap has an unexpected signer set');
    const keys = new Set(swap.keys.map((key) => key.pubkey.toBase58()));
    if (!keys.has(plan.wallet)) reasons.push('Aggregator swap omits the dedicated wallet');
    if (!keys.has(plan.baseAta.ata)) reasons.push('Provider swap omits the base USDC ATA');
    if (!keys.has(plan.intermediateAta.ata)) reasons.push('Provider swap omits the intermediate ATA');
  }
  const allKeys = new Set(plan.instructions.flatMap((instruction) => instruction.keys.map((key) => key.pubkey.toBase58())));
  for (const pool of plan.pools) if (!allKeys.has(pool)) reasons.push(`Expected pool is absent from compiled accounts: ${pool}`);
  const sourceHashes = plan.instructions.slice(2).map(instructionHash);
  if (!evidence || sourceHashes.length !== evidence.sourceInstructionHashes.length
    || sourceHashes.some((hash, index) => hash !== evidence.sourceInstructionHashes[index])) {
    reasons.push('Aggregator instruction payload differs from independently built source evidence');
  }
  return { passed: reasons.length === 0, reasons, programIds, instructionCount: plan.instructions.length };
}

export function inspectAtomicTransaction(plan: AtomicExecutionPlan): InspectionResult {
  if(plan.type==='RAPTOR_RAYDIUM_CYCLE')return inspectRaptorRaydiumCycle(plan);
  if (plan.type !== 'ORCA_TWO_HOP_CYCLE') {
    return inspectAggregatorCycle(plan);
  }
  const reasons: string[] = [];
  const programIds = [...new Set(plan.instructions.map((instruction) => instruction.programId.toBase58()))];
  for (const programId of programIds) {
    if (!EXECUTION_PROGRAM_ALLOWLIST.has(programId)) reasons.push(`Unexpected top-level program: ${programId}`);
  }
  reasons.push(...inspectComputeBudget(plan));
  const swaps = plan.instructions.filter((instruction) =>
    instruction.programId.equals(new PublicKey(String(DEFAULT_WHIRLPOOL_DEPLOYMENT.programId))));
  if (swaps.length !== 1) reasons.push(`Expected exactly one Orca two-hop instruction, got ${swaps.length}`);
  const swap = swaps[0];
  if (swap) {
    try {
      const parsed = parseTwoHopSwapV2Instruction(web3InstructionToKit(swap));
      const { accounts, data } = parsed;
      if (accountAddress(accounts.whirlpoolOne) !== plan.pools[0]) reasons.push('First pool mismatch');
      if (accountAddress(accounts.whirlpoolTwo) !== plan.pools[1]) reasons.push('Second pool mismatch');
      if (plan.pools[0] === plan.pools[1]) reasons.push('Two-hop pools must be distinct');
      if (accountAddress(accounts.tokenMintInput) !== plan.inputMint) reasons.push('Input mint mismatch');
      if (accountAddress(accounts.tokenMintIntermediate) !== plan.intermediateMint) reasons.push('Intermediate mint mismatch');
      if (accountAddress(accounts.tokenMintOutput) !== plan.outputMint) reasons.push('Output mint mismatch');
      if (plan.inputMint !== plan.outputMint) reasons.push('Initial route must be a complete same-mint cycle');
      if (accountAddress(accounts.tokenAuthority) !== plan.wallet) reasons.push('Token authority is not the dedicated wallet');
      if (accountAddress(accounts.tokenOwnerAccountInput) !== accountAddress(accounts.tokenOwnerAccountOutput)) {
        reasons.push('Input and final output token accounts differ');
      }
      if (data.amount !== plan.inputAmount) reasons.push('Instruction input amount mismatch');
      if (data.otherAmountThreshold !== plan.minimumOutputAmount) reasons.push('Instruction minimum output mismatch');
      if (!data.amountSpecifiedIsInput) reasons.push('Only exact-input cycles are allowed');
      const signers = swap.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58());
      if (signers.length !== 1 || signers[0] !== plan.wallet) reasons.push('Unexpected signer set');
      if (swap.keys.length !== 24) reasons.push(`Unexpected Orca account count: ${swap.keys.length}`);
    } catch (error) {
      reasons.push(`Cannot decode Orca instruction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passed: reasons.length === 0, reasons, programIds, instructionCount: plan.instructions.length };
}

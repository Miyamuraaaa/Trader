import { PublicKey, type Connection } from '@solana/web3.js';
import { performance } from 'node:perf_hooks';
import { CONFIG, DECIMALS, MINTS } from './config.js';
import { fromAtomic, toAtomic } from './math.js';
import { inspectAssociatedTokenAccount } from './execution/account-preflight.js';
import { approveTransaction, signApprovedExecution } from './execution/approved-transaction.js';
import { buildOrcaTwoHopCycle, prepareOrcaTwoHopCycle, type OrcaTwoHopPreparation } from './execution/orca-two-hop-builder.js';
import { inspectAtomicTransaction } from './execution/transaction-inspector.js';
import { loadDedicatedSigner } from './execution/signer.js';
import { simulateAtomicTransaction, simulateSignedApprovedTransaction } from './execution/simulator.js';
import type { AtomicExecutionPlan, SimulationResult } from './execution/types.js';
import { createExecutionConnection } from './execution/execution-connection.js';
import { getExecutionReadiness } from './execution-readiness.js';

const MAX_TRANSACTION_BYTES = 1232;
const COMPUTE_BUFFER_RATIO = 1.15;
const COMPUTE_BUFFER_UNITS = 5_000;
const MAX_COMPUTE_UNITS = 1_400_000;

function printAta(label: string, ata: AtomicExecutionPlan['baseAta'], required: boolean): void {
  console.log(`${label} ATA: ${ata.ata}`);
  console.log(`  exists: ${ata.exists ? 'YES' : 'NO'}; balance: ${ata.balance}; rent if created: ${ata.creationRentLamports} lamports`);
  console.log(`  required for this instruction: ${required ? 'YES' : 'NO'}`);
}

function logSimulation(simulation: SimulationResult): void {
  console.log(`Transaction: ${simulation.transactionVersion.toUpperCase()} (unsigned for simulation; sigVerify=false)`);
  console.log(`Serialized size: ${simulation.transactionBytes}/${MAX_TRANSACTION_BYTES} bytes`);
  console.log(`Instructions: ${simulation.transaction.message.compiledInstructions.length}`);
  console.log(`Static accounts: ${simulation.staticAccountCount}`);
  console.log(`Address Lookup Tables: ${simulation.lookupTableCount} (${simulation.lookupTableAccountCount} looked-up accounts)`);
  console.log(`ALT addresses: ${simulation.lookupTableAddresses.length ? simulation.lookupTableAddresses.join(', ') : 'none'}`);
  console.log(`Signatures required: ${simulation.requiredSignatures}`);
  console.log(`Fresh blockhash: ${simulation.blockhash}`);
  console.log(`Compute: ${simulation.unitsConsumed ?? 'not returned'} units`);
  console.log(`Loaded account data: ${simulation.loadedAccountsDataSize ?? 'not returned'} bytes`);
  console.log(`Estimated base fee: ${simulation.estimatedBaseFeeLamports} lamports`);
  console.log(`Simulation logs:\n${simulation.logs.join('\n') || '(none returned)'}`);
  if (simulation.returnData !== null) console.log(`Simulation return data: ${JSON.stringify(simulation.returnData)}`);
}

function logTiming(
  plan: AtomicExecutionPlan,
  inspectionMs: number,
  simulation: SimulationResult | undefined,
  validationStartedAt: number,
): void {
  const timing = plan.executionTiming;
  if (!timing) return;
  console.log('Timing:');
  console.log(`  route discovery: ${timing.routeDiscoveryMs} ms`);
  console.log(`  pool/account fetching: ${timing.poolAccountFetchMs} ms`);
  console.log(`  fresh selected-pool state: ${timing.freshPoolStateFetchMs} ms`);
  console.log(`  quote generation: ${timing.quoteGenerationMs} ms`);
  console.log(`  transaction construction: ${timing.transactionConstructionMs} ms`);
  console.log(`  instruction inspection: ${inspectionMs} ms`);
  console.log(`  selected pool-state read spread: ${timing.newestPoolStateAt - timing.oldestPoolStateAt} ms`);
  console.log(`  quote age at transaction construction: ${timing.quoteAgeAtTransactionConstructionMs} ms`);
  if (simulation) {
    console.log(`  blockhash retrieval: ${simulation.timing.blockhashRetrievalMs} ms`);
    console.log(`  serialization: ${simulation.timing.serializationMs} ms`);
    console.log(`  simulation RPC: ${simulation.timing.simulationRpcMs} ms`);
    console.log(`  quote age when simulation request begins: ${simulation.timing.simulationRequestAt - plan.quoteReceivedAt} ms`);
    console.log(`  quote age when simulation response arrives: ${simulation.timing.simulationResponseAt - plan.quoteReceivedAt} ms`);
  }
  console.log(`  total validation latency: ${Date.now() - validationStartedAt} ms`);
}

function recommendedComputeLimit(unitsConsumed: number | undefined): number {
  if (!unitsConsumed || unitsConsumed <= 0) {
    throw new Error('RPC did not return unitsConsumed; cannot derive a bounded compute limit');
  }
  const buffered = Math.ceil(unitsConsumed * COMPUTE_BUFFER_RATIO) + COMPUTE_BUFFER_UNITS;
  if (buffered > MAX_COMPUTE_UNITS) {
    throw new Error(`Measured compute requires ${buffered} units, above the ${MAX_COMPUTE_UNITS} safety ceiling`);
  }
  return buffered;
}

async function constructAndProbe(
  connection: Connection,
  wallet: PublicKey,
  inputAmount: bigint,
  intermediateMint: string,
  signer: NonNullable<Awaited<ReturnType<typeof loadDedicatedSigner>>>,
): Promise<{ plan: AtomicExecutionPlan; probe: SimulationResult; prepared: OrcaTwoHopPreparation }> {
  const prepared = await prepareOrcaTwoHopCycle({
    connection,
    wallet,
    baseMint: MINTS.USDC,
    intermediateMint,
    inputAmount,
    purpose: 'developer-validation',
  });
  // Broad metadata/state discovery is intentionally outside the executable
  // quote-age window. It selects two real pools, but does not authorize or
  // simulate this preliminary quote.
  const discoveryPlan = await buildOrcaTwoHopCycle({
    connection,
    wallet,
    baseMint: MINTS.USDC,
    intermediateMint,
    inputAmount,
    slippageBps: CONFIG.slippageBps,
    purpose: 'developer-validation',
    prepared,
    freshPoolState: false,
  });
  // Only the selected pair is now refreshed and quoted. Expanding scanner
  // coverage from two to five pools must not make the execution critical path
  // fetch all five pools inside MAX_EXECUTION_QUOTE_AGE_MS.
  const plan = await buildOrcaTwoHopCycle({
    connection,
    wallet,
    baseMint: MINTS.USDC,
    intermediateMint,
    inputAmount,
    slippageBps: CONFIG.slippageBps,
    purpose: 'developer-validation',
    prepared,
    poolAddresses: discoveryPlan.pools,
    freshPoolState: true,
  });
  const inspection = inspectAtomicTransaction(plan);
  if (!inspection.passed) throw new Error(`Instruction inspection failed: ${inspection.reasons.join('; ')}`);
  const probe = await simulateAtomicTransaction(connection, plan, signer, {
    quoteReceivedAt: plan.quoteReceivedAt,
    maxAgeMs: CONFIG.maxExecutionQuoteAgeMs,
  });
  if (!probe.passed) {
    throw new Error(`Probe simulation failed: ${JSON.stringify(probe.error)}\n${probe.logs.slice(-16).join('\n')}`);
  }
  return { plan, probe, prepared };
}

async function main(): Promise<void> {
  const validationStartedAt = Date.now();
  console.log('================================================');
  console.log('EXECUTION PIPELINE VALIDATION');
  console.log('NOT AN ARBITRAGE OPPORTUNITY');
  console.log('SIMULATION ONLY — THIS COMMAND CANNOT BROADCAST');
  console.log('================================================');
  if (CONFIG.executionMode !== 'dry-run') {
    throw new Error('Set EXECUTION_MODE=dry-run for execution pipeline validation');
  }

  const signer = await loadDedicatedSigner('dry-run');
  if (!signer) throw new Error('Dedicated signer is unavailable');
  const connection = createExecutionConnection();
  const inputAmount = BigInt(toAtomic(CONFIG.executionValidationAmountUsdc, DECIMALS.USDC));
  if (inputAmount <= 0n) throw new Error('EXECUTION_VALIDATION_AMOUNT_USDC must produce at least one USDC base unit');

  const [solLamports, usdcAta] = await Promise.all([
    connection.getBalance(signer.keypair.publicKey, 'confirmed'),
    inspectAssociatedTokenAccount(
      connection,
      signer.keypair.publicKey,
      new PublicKey(MINTS.USDC),
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    ),
  ]);
  console.log(`Wallet: ${signer.publicKey}`);
  console.log('Network: MAINNET');
  console.log(`Mainnet SOL balance: ${solLamports} lamports`);
  console.log(`Mainnet USDC balance: ${usdcAta.balance} atomic (${fromAtomic(usdcAta.balance, DECIMALS.USDC).toFixed()} USDC)`);

  // Probe exactly the explicitly configured route. Falling through to other
  // mints after an RPC 429 multiplies account reads and can turn one transient
  // free-tier failure into minutes of hidden SDK retries.
  const intermediateMint = CONFIG.executionValidationIntermediateMint;
  if (intermediateMint === MINTS.USDC) {
    throw new Error('EXECUTION_VALIDATION_INTERMEDIATE_MINT must differ from USDC');
  }
  console.log(`Probing configured Orca two-pool USDC -> ${intermediateMint} -> USDC route...`);
  const selection = await constructAndProbe(
    connection,
    signer.keypair.publicKey,
    inputAmount,
    intermediateMint,
    signer,
  );

  const computeUnitLimit = recommendedComputeLimit(selection.probe.unitsConsumed);
  const plan = await buildOrcaTwoHopCycle({
    connection,
    wallet: signer.keypair.publicKey,
    baseMint: MINTS.USDC,
    intermediateMint: selection.plan.intermediateMint,
    inputAmount,
    slippageBps: CONFIG.slippageBps,
    purpose: 'developer-validation',
    poolAddresses: selection.plan.pools,
    computeUnitLimit,
    prepared: selection.prepared,
    // This is the execution quote: it deliberately bypasses all pool-state
    // caches and begins only after discovery/account preparation is complete.
    freshPoolState: true,
  });
  const inspectionStart = performance.now();
  const inspection = inspectAtomicTransaction(plan);
  const inspectionMs = Number((performance.now() - inspectionStart).toFixed(1));
  if (!inspection.passed) throw new Error(`Final instruction inspection failed: ${inspection.reasons.join('; ')}`);
  const simulation = await simulateAtomicTransaction(connection, plan, signer, {
    quoteReceivedAt: plan.quoteReceivedAt,
    maxAgeMs: CONFIG.maxExecutionQuoteAgeMs,
  });
  if (!simulation.passed) {
    throw new Error(`Complete atomic simulation failed: ${JSON.stringify(simulation.error)}`);
  }
  if (simulation.transactionBytes > MAX_TRANSACTION_BYTES) throw new Error('Serialized transaction exceeds Solana packet limit');
  if (Date.now() - plan.quoteReceivedAt > CONFIG.maxExecutionQuoteAgeMs) {
    throw new Error('Final transaction quote became stale before validation completed');
  }
  const approved = approveTransaction('developer-validation', plan, simulation.transaction);
  const signed = signApprovedExecution(approved, signer);
  const signedSimulation = await simulateSignedApprovedTransaction(connection, signed);
  if (!signedSimulation.passed) {
    throw new Error(`Signed simulation failed: ${JSON.stringify(signedSimulation.error)}`);
  }
  if (Date.now() - plan.quoteReceivedAt > CONFIG.maxExecutionQuoteAgeMs) {
    throw new Error('Final transaction quote became stale during signed simulation');
  }
  // Reporting is deliberately outside the safety-critical quote window.
  logTiming(plan, inspectionMs, simulation, validationStartedAt);
  logSimulation(simulation);
  const [afterSolLamports, afterBaseAta, afterIntermediateAta] = await Promise.all([
    connection.getBalance(signer.keypair.publicKey, 'confirmed'),
    inspectAssociatedTokenAccount(connection, signer.keypair.publicKey, new PublicKey(plan.inputMint), new PublicKey(plan.baseToken.programId!)),
    inspectAssociatedTokenAccount(connection, signer.keypair.publicKey, new PublicKey(plan.intermediateMint), new PublicKey(plan.intermediateToken.programId!)),
  ]);
  if (afterSolLamports !== solLamports || afterBaseAta.balance !== usdcAta.balance
    || afterIntermediateAta.balance !== plan.intermediateAta.balance) {
    throw new Error('Wallet balance changed while simulating; cannot attribute a post-simulation balance difference to this dry run');
  }

  console.log('');
  console.log('EXECUTION PIPELINE VALIDATION');
  console.log('─────────────────────────────');
  console.log(`Wallet: ${signer.publicKey}`);
  console.log('Network: MAINNET');
  console.log(`Route: USDC -> ${plan.intermediateMint} -> USDC`);
  console.log(`Pools: ${plan.pools[0]} -> ${plan.pools[1]}`);
  console.log(`Input: ${inputAmount} atomic (${CONFIG.executionValidationAmountUsdc} USDC)`);
  console.log(`Expected output: ${plan.expectedOutputAmount} atomic; on-chain minimum: ${plan.minimumOutputAmount} atomic`);
  console.log(`Quote-only difference: ${plan.expectedOutputAmount - plan.inputAmount} atomic USDC (not P&L)`);
  console.log('Atomic: YES');
  console.log('Transaction: CONSTRUCTED');
  console.log(`Instruction inspection: PASS (${inspection.instructionCount} top-level instructions)`);
  console.log(`Token-program policy: PASS (input ${plan.baseToken.programId}; intermediate ${plan.intermediateToken.programId})`);
  printAta('USDC', plan.baseAta, true);
  printAta('Intermediate', plan.intermediateAta, false);
  console.log(`WSOL: ${plan.intermediateMint === MINTS.SOL ? 'not required: the atomic instruction passes intermediate WSOL directly between Whirlpool vaults' : 'not used'}`);
  console.log(`Compute budget: ${computeUnitLimit} units (measured probe + 15% + 5,000)`);
  console.log(`Simulation: PASS (sigVerify=${simulation.sigVerify})`);
  console.log('Local signing: PASS (approved message fingerprint and Ed25519 signature verified)');
  console.log('Signed simulation: PASS (sigVerify=true)');
  console.log('Broadcast: DISABLED');
  console.log('REAL FUNDS MOVED: NO');
  console.log(`REAL-MONEY READINESS: ${getExecutionReadiness().verdict}`);
}

main().catch((error) => {
  console.error(`DRY RUN BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

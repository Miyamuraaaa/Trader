import { CONFIG, DECIMALS } from './config.js';
import { approveTransaction, signApprovedExecution } from './execution/approved-transaction.js';
import {
  buildJupiterOrcaCycle, buildOrcaJupiterCycle,
  buildRaptorOrcaCycle, buildOrcaRaptorCycle
} from './execution/mixed-cycle-builder.js';
import { loadDedicatedSigner } from './execution/signer.js';
import { simulateAtomicTransaction, simulateSignedApprovedTransaction } from './execution/simulator.js';
import { inspectAtomicTransaction } from './execution/transaction-inspector.js';
import { toAtomic } from './math.js';
import { createExecutionConnection } from './execution/execution-connection.js';

async function main(): Promise<void> {
  console.log('MIXED EXECUTION PIPELINE VALIDATION');
  console.log('NOT AN ARBITRAGE OPPORTUNITY');
  console.log('BROADCAST: DISABLED');
  const signer = await loadDedicatedSigner('dry-run');
  if (!signer) throw new Error('Dedicated signer is unavailable');
  const connection = createExecutionConnection();
  const inputAmount = BigInt(toAtomic(CONFIG.executionValidationAmountUsdc ?? '0.05', DECIMALS.USDC));
  
  const directionArgs = process.argv.filter((arg) => arg.startsWith('--direction='));
  const direction = directionArgs.length > 0 ? directionArgs[0]!.split('=')[1] : 'jupiter-orca';
  const mintArg = process.argv.find((argument) => argument.startsWith('--intermediate-mint='));
  const intermediateMint = mintArg?.slice('--intermediate-mint='.length);
  
  const builders: Record<string, typeof buildJupiterOrcaCycle> = {
    'jupiter-orca': buildJupiterOrcaCycle,
    'orca-jupiter': buildOrcaJupiterCycle,
    'raptor-orca': buildRaptorOrcaCycle,
    'orca-raptor': buildOrcaRaptorCycle,
  };
  const buildCycle = builders[direction!];
  if (!buildCycle) throw new Error(`Unknown direction: ${direction}`);

  const plan = await buildCycle({
    connection,
    wallet: signer.keypair.publicKey,
    inputAmount,
    slippageBps: CONFIG.slippageBps,
    intermediateMint,
  });
  
  const inspection = inspectAtomicTransaction(plan);
  if (!inspection.passed) throw new Error(`Instruction inspection failed: ${inspection.reasons.join('; ')}`);
  
  const unsigned = await simulateAtomicTransaction(connection, plan, signer);
  if (!unsigned.passed) {
    console.error(unsigned.logs.slice(-30).join('\n'));
    throw new Error(`Unsigned simulation failed: ${JSON.stringify(unsigned.error)}`);
  }
  
  const approved = approveTransaction('developer-validation', plan, unsigned.transaction);
  const signed = signApprovedExecution(approved, signer);
  const signedSimulation = await simulateSignedApprovedTransaction(connection, signed);
  if (!signedSimulation.passed) throw new Error(`Signed simulation failed: ${JSON.stringify(signedSimulation.error)}`);
  
  console.log(`Wallet: ${plan.wallet}`);
  console.log(`Route: ${direction} (USDC -> ${plan.intermediateMint} -> USDC)`);
  console.log(`Input atomic: ${plan.inputAmount}`);
  console.log(`Expected output atomic: ${plan.expectedOutputAmount}`);
  console.log(`Minimum output atomic: ${plan.minimumOutputAmount}`);
  console.log(`Pools: ${plan.pools.join(' -> ')}`);
  console.log(`Instruction inspection: PASS (${inspection.instructionCount} instructions)`);
  console.log(`Transaction: v0, ${unsigned.transactionBytes}/1232 bytes`);
  console.log(`Static accounts: ${unsigned.staticAccountCount}`);
  console.log(`Lookup tables: ${unsigned.lookupTableCount}; loaded accounts: ${unsigned.lookupTableAccountCount}`);
  console.log(`Unsigned simulation: PASS (${unsigned.unitsConsumed ?? 'unknown'} units, sigVerify=false)`);
  console.log(`Quote age at unsigned simulation: ${unsigned.timing.simulationResponseAt - plan.quoteReceivedAt} ms`);
  console.log(`Signed simulation: PASS (${signedSimulation.unitsConsumed ?? 'unknown'} units, sigVerify=true)`);
  console.log(`Quote age at signed simulation: ${Date.now() - plan.quoteReceivedAt} ms`);
  console.log('APPROVED_FOR_SUBMISSION: NO (developer validation cannot be submitted)');
  console.log('REAL FUNDS MOVED: NO');
}

main().catch((error) => {
  console.error(`MIXED EXECUTION VALIDATION FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

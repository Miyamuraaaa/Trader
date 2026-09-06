import { CONFIG } from './config.js';
import { validateOrcaHandoffForApproval } from './execution/handoff-validator.js';
import { OrcaHandoffInbox } from './execution/handoff-inbox.js';
import { orcaCrossPoolStats, recordOrcaHandoffOutcome } from './orca-cross-pool.js';
import { discoverCurrentOrcaExecutionCandidates, formatLiveOrcaCoverage } from './live-orca-candidate.js';

async function main(): Promise<void> {
  console.log('================================================');
  console.log('EXECUTION HANDOFF VALIDATION — NO BROADCAST');
  console.log('================================================');
  if (CONFIG.executionMode !== 'dry-run' || CONFIG.liveTradingEnabled) {
    throw new Error('Handoff validation requires EXECUTION_MODE=dry-run and LIVE_TRADING_ENABLED=false');
  }
  const raw = process.env.EXECUTION_HANDOFF_JSON;
  let input: unknown;
  if (raw) {
    try { input = JSON.parse(raw); } catch { throw new Error('EXECUTION_HANDOFF_JSON is not valid JSON'); }
  } else {
    // Run only the narrow Orca cross-pool scanner strategy against current
    // mainnet state, then consume its public DTO inbox. This is not executor
    // revalidation and cannot create/sign a transaction by itself.
    // Slot is diagnostic data for the untrusted DTO. A public RPC transient
    // must not prevent the direct Orca scanner from attempting its own fresh
    // pool-state reads, and it must never be treated as execution authority.
    const scan = await discoverCurrentOrcaExecutionCandidates();
    if (scan.feeEstimateFallback) {
      console.warn('Network-fee diagnostic unavailable; using conservative 10,000-lamport scan estimate.');
    }
    const inbox = new OrcaHandoffInbox();
    await inbox.publish(scan.candidates);
    input = await inbox.latest();
    if (!input) {
      console.log('NO EXECUTION-ELIGIBLE LIVE OPPORTUNITY');
      formatLiveOrcaCoverage().forEach((line) => console.log(line));
      console.log('BROADCAST: DISABLED');
      return;
    }
  }
  if (!input) {
    console.log('NO EXECUTION-ELIGIBLE LIVE OPPORTUNITY');
    console.log('BROADCAST: DISABLED');
    return;
  }
  recordOrcaHandoffOutcome('handoff');
  const result = await validateOrcaHandoffForApproval(input);
  console.log(`Candidate identity: ${result.identity}`);
  console.log(`Candidate age at handoff: ${result.candidateAgeAtHandoffMs} ms`);
  console.log(`Scanner observed expected output: ${result.candidate.scannerObservation.expectedOutputAmount} atomic (diagnostic only)`);
  console.log(`Scanner observed projected net: ${result.candidate.scannerObservation.projectedNetAmount} atomic (untrusted)`);
  if (result.status === 'REJECTED') {
    const reason = result.reason ?? 'Executor rejected candidate without a supplied reason';
    const expired = /stale|expired|quote age|blockhash/i.test(reason);
    recordOrcaHandoffOutcome(expired ? 'expired' : 'rejected');
    console.log(`HANDOFF REJECTED: ${reason}`);
    console.log(`Handoff stats: handoffs=${orcaCrossPoolStats.handoffs}; rejected=${orcaCrossPoolStats.executorRejections}; expired=${orcaCrossPoolStats.expiredCandidates}; approved=${orcaCrossPoolStats.approvedDryRuns}`);
    console.log('BROADCAST: DISABLED');
    return;
  }
  const { plan, economics, unsignedSimulation, signedSimulation, finalApprovalAt } = result;
  recordOrcaHandoffOutcome('approved');
  console.log('APPROVED_FOR_SUBMISSION');
  console.log(`Executor expected output: ${plan!.expectedOutputAmount} atomic`);
  console.log(`Executor minimum output: ${plan!.minimumOutputAmount} atomic`);
  console.log(`Expected net: ${economics!.expectedNetAtomic} atomic; conservative net: ${economics!.conservativeNetAtomic} atomic`);
  console.log(`Expected ROI: ${economics!.expectedRoiBps} bps; conservative ROI: ${economics!.conservativeRoiBps} bps`);
  console.log(`Fee estimate: total ${economics!.totalNetworkCostLamports} lamports (base ${economics!.baseFeeLamports}; priority ${economics!.priorityFeeLamports}; ${economics!.computeUnitPriceMicroLamports} micro-lamports/CU × ${economics!.computeUnitLimit} CU)`);
  console.log(`Final quote age at unsigned simulation response: ${unsignedSimulation!.timing.simulationResponseAt - plan!.quoteReceivedAt} ms`);
  console.log(`Final approval timestamp: ${finalApprovalAt}`);
  console.log('Local signing: PASS (approved-message fingerprint verified)');
  console.log(`Signed simulation: ${signedSimulation!.passed ? 'PASS' : 'FAIL'} (sigVerify=true)`);
  console.log(`Handoff stats: handoffs=${orcaCrossPoolStats.handoffs}; rejected=${orcaCrossPoolStats.executorRejections}; expired=${orcaCrossPoolStats.expiredCandidates}; approved=${orcaCrossPoolStats.approvedDryRuns}`);
  console.log('BROADCAST: DISABLED');
}

main().catch((error) => {
  console.error(`HANDOFF VALIDATION BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

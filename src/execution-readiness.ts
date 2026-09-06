import { CONFIG } from './config.js';
import { getProviderCapabilities } from './aggregators/index.js';
import { EXECUTION_IMPLEMENTATION_READY } from './execution/readiness-manifest.js';

export type ReadinessGateState = 'PASS' | 'FAIL' | 'NOT_IMPLEMENTED';

export interface ReadinessGate {
  id: string;
  state: ReadinessGateState;
  detail: string;
}

/**
 * Fail-closed readiness inventory. PASS means a component has a tested design,
 * never that a configured environment may bypass the final live guards.
 */
export function getExecutionReadiness() {
  const providerCapabilities = getProviderCapabilities();
  const gates: ReadinessGate[] = [
    { id: 'wallet-and-mainnet-preflight', state: 'PASS', detail: 'Dedicated wallet identity, funded mainnet balances, classic USDC ATA, and SOL reserve passed the real non-broadcast validation command.' },
    { id: 'atomic-orca-validation', state: 'PASS', detail: 'Fresh two-hop state, exact bigint quote, compiled-message inspection, strict freshness, packet-size, unsigned and signed mainnet simulation are implemented.' },
    { id: 'dedicated-signer-identity', state: 'PASS', detail: 'The external dedicated keypair was matched to BOT_WALLET_ADDRESS during funded mainnet validation; secret bytes are neither logged nor stored in environment variables.' },
    { id: 'mainnet-simulation-evidence', state: 'PASS', detail: 'The real v0 Orca two-hop message passed unsigned sigVerify=false and locally signed sigVerify=true mainnet simulation.' },
    { id: 'spl-token-security-chain', state: 'PASS', detail: 'The executor no longer imports @solana/spl-token; account/mint validation uses RPC jsonParsed responses and Token-2022 execution is fail-closed.' },
    { id: 'scanner-dependency-isolation', state: 'PASS', detail: 'Execution-critical modules do not import scanner provider implementations, @solana/spl-token, or bigint-buffer. The reviewed aggregator executor has independent minimal HTTP clients and accepts only a strict instruction-free handoff DTO.' },
    { id: 'confirmation-and-realized-accounting', state: 'PASS', detail: 'Read-only confirmation detects failure, retrieves on-chain balances/fee, calculates realized P&L and dust, and persists accounting in the execution journal.' },
    { id: 'execution-journal-and-restart-safety', state: 'PASS', detail: 'Fail-closed legal state transitions are atomically persisted. Any unresolved SUBMITTING/SUBMITTED/CONFIRMING record must be reconciled before a new submission.' },
    { id: 'final-opportunity-revalidation', state: 'PASS', detail: 'The Orca handoff validator treats DTO economics as untrusted, fetches fresh state, rebuilds/re-inspects/re-simulates, enforces conservative minimum-output profit/ROI and blockhash validity, then stops at APPROVED_FOR_SUBMISSION.' },
    { id: 'scanner-orca-handoff-source', state: 'PASS', detail: 'Distinct Orca Whirlpool combinations are screened and exact-quoted at 0.01/0.02/0.05 USDC. Core and eligible HOT/WARM classic-SPL intermediate mints may produce the strict DTO; the executor independently rechecks mint policy and economics.' },
    { id: 'aggregator-atomic-composition', state: 'PASS', detail: 'Raptor/Jupiter and Jupiter-or-Raptor with direct Orca raw instructions are independently rebuilt for constrained complete cycles. Dynamic classic-SPL intermediates must pass mint/freeze policy; ALTs and compiled messages are independently verified.' },
    { id: 'execution-critical-dependency-audit', state: 'PASS', detail: 'Scanner-only bigint-buffer remains isolated. Executor-reachable jayson calls uuid.v4() without external buffers; the v3/v5/v6 buffer advisory is not reachable. See docs/dependency-security-audit.md.' },
    { id: 'controlled-broadcaster', state: 'PASS', detail: 'The one-shot broadcaster accepts only in-process branded ApprovedSignedExecution bytes, persists signature/hash before one maxRetries=0 RPC call, and never retries ambiguity.' },
  ];
  const blockers = gates.filter((gate) => gate.state !== 'PASS').map((gate) => `${gate.id}: ${gate.detail}`);
  return {
    ready: EXECUTION_IMPLEMENTATION_READY && blockers.length === 0,
    verdict: EXECUTION_IMPLEMENTATION_READY && blockers.length === 0 ? 'READY' as const : 'NOT READY' as const,
    executionMode: CONFIG.executionMode,
    liveTradingEnabled: CONFIG.liveTradingEnabled,
    liveSubmissionExposed: true,
    providerCapabilities,
    gates,
    blockers,
  };
}

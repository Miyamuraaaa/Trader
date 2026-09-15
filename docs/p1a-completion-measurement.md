# P1-A completion: passive coverage and comparison drain

Starting point: `codex/workflow-admission`, `94ee62929b7ea9758a9341ab350e1fba3ff4925f`, clean worktree.

This patch adds no quote, RPC, retry, refresh, stream or trading scheduling work. The user explicitly approved comparison-only scanner/provider stop hooks because a harness-only stop could not prevent continuations from starting another request.

## Coverage and honest denominators

`quality.surfaces` identifies all six source lanes and observed aggregator, direct, mixed and Orca cross-pool surfaces. Existing completed matrix results feed the same advisory breakdown observer; no second quote model or provider call is introduced. Orca copies existing outputs, net economics, pool IDs and observation time, with missing leg evidence and individual fee components explicitly listed. An internally consistent aggregate cost may be derived from the existing outputs and nets; contradictory totals remain unavailable.

Coverage states are `FULL`, `PARTIAL`, `UNAVAILABLE`, `NOT_OBSERVED`; dispatch states are `EXACT_NETWORK_DISPATCH`, `LOGICAL_PROVIDER_CALL_ONLY`, `EVALUATION_ONLY`, `UNAVAILABLE`. This implementation does not manufacture FULL/network coverage: currently observed surfaces are PARTIAL, with EVALUATION_ONLY cycle attribution. Logical wrapper calls and existing Jupiter/Raptor governor sends are separately reported. Governor sends do not prove exact HTTP dispatch, so network counts remain null. Unobserved/unavailable counters are null, not zero.

Comparison requires eligible, identical denominators. Shared first-leg/mixed request attribution remains incomplete, so per-call lane superiority and whole-bot conclusions are blocked explicitly. Completed-cycle comparisons can be eligible only where all corresponding economic/freshness/policy fields are known. This conservative reporting limitation is intentional, not a zero-opportunity claim.

## Diagnostic integrity

The existing bounded async writer is retained. Critical overflow, any write failure or pending critical data at finalization invalidates measurement, never trading. Ordinary sample drops alone do not invalidate a run. Reports expose `diagnosticEvidenceValid`, `invalidReasons`, `criticalOverflowCount`, `ordinaryDropCount`, `writeFailureCount`, `pendingCriticalAtFinalize`, `lastSuccessfulDiagnosticWriteAt`, `diagnosticPartsWritten`, `diagnosticBytesWritten`, and `diagnosticDirectory`. No old-file deletion was added.

## Comparison-only drain

Only no-broadcast comparison bootstraps activate the barrier. Normal production receives inert hooks. At completion, the parent stops scheduling, blocks new provider/RPC dispatch and refreshes, suppresses P0 through the existing no-broadcast stop hook, and asks the child to stop future ticks. The child comparison hook does not edit autoExecute or reconciliation behavior in production. Already-sent work and local completion callbacks can settle, but may not launch another request or reset a deadline.

Pre-barrier scanner, provider/RPC, continuation and executor tick work is tracked. A stable idle barrier triggers diagnostic flush. The drain exits early when clean, otherwise stops at 10 seconds, retaining pending IDs/source lanes/stages and `INVALID_RUN_DRAIN_TIMEOUT`. The report records both parent stop time and the child stop acknowledgement; the effective distributed scheduling-stop time is the later acknowledgement, not an invented instantaneous cross-process barrier.

Final submission counters are collected before child termination. Missing final acknowledgement invalidates the run. Safety journal/risk persistence is not moved to this diagnostic queue and is never made best-effort.

## Manual comparison only

Run from `C:\Users\ADMIN\Trader`, without `npm run dev` alongside it:

```powershell
npm.cmd run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=15
npm.cmd run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=30
npm.cmd run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=60
```

Choose one duration. Do not run all three concurrently. The command prints the final exact path: `C:\Users\ADMIN\Trader\data\production-soak-<timestamp>.json`. The existing checkpoint is `<final-path>.checkpoint.json`. Diagnostic parts are retained under the sandbox directory reported in `diagnosticIntegrity.diagnosticDirectory`; no automatic deletion was added.

```powershell
node scripts/summarize-opportunity-quality.mjs "C:\Users\ADMIN\Trader\data\production-soak-<timestamp>.json"
```

Send back the final JSON, not secrets or `.env`. Keep the PC awake. Any positive submission/broadcast counter is FAIL. Missing fields, continuity/schema mismatch, missing/duplicate ledger outcomes, critical diagnostic loss, drain timeout or missing final-counter proof means INVALID_RUN. Otherwise fewer than 20 completed fast/control economic observations means INSUFFICIENT_SAMPLE_FOR_LANE_COMPARISON. PASS_MEASUREMENT_ONLY means valid measurement with that sample floor, not profitability, complete whole-bot coverage or lane superiority.

No long comparison is run by the AI terminal. Production automatic execution remains automatic; comparison validation is no-broadcast.

## Local validation and changed areas

On 2026-09-15: typecheck PASS, full single-worker suite **366/366 tests in 44 files PASS**, build PASS. Audit review completed with the unchanged 13 known vulnerabilities (7 moderate, 6 high); this is not a clean audit. All existing P0 recovery/authority/no-broadcast regression tests remain green. No dev, live benchmark or long comparison was launched.

The baseline-to-worktree source comparison verified identical P0 publication and autoExecute function bodies. Safety configuration, policy, risk, signer, broadcaster and recovery modules, dependencies and real `.env` are unchanged. The only worker change is the explicitly comparison-only stop/tick tracking hook.

Changed areas:

- `src/economics/{measurement-coverage,orca-observation,opportunity-quality,economic-breakdown}.ts`: passive coverage, partial data and denominator truth.
- `src/diagnostics/economic-diagnostics.ts`: integrity and storage progress fields.
- `src/comparison-drain.ts`, `src/production-workload-soak.ts`, `src/production-soak-child.ts`: bounded comparison barrier, drain, child acknowledgement and final counters before termination.
- `src/scanner.ts`, `src/routes.ts`, `src/orca-cross-pool.ts`, `src/executable-pair-coordinator.ts`: existing observation hooks and comparison-only stop/continuation tracking.
- `src/{quote-admission,provider-runtime,http,scanner-rpc-limiter,scanner-rpc-transport}.ts`, `src/aggregators/index.ts`: inactive-in-production admission/dispatch barriers; no new calls.
- `src/live-execution-worker.ts`: comparison-only future-tick stop and in-flight tick tracking; automatic authority unchanged.
- `src/execution/{execution-funnel,raw-prefilter-ledger}.ts`: read-only pending-work reporting, without shutdown-fabricated completions.
- `scripts/summarize-opportunity-quality.mjs`: fail/invalid/sample verdict ordering and required evidence checks.
- `test/{comparison-drain,measurement-coverage,opportunity-quality-summary}.test.ts`: 19 added regression cases covering passive labels, null dispatch, partial Orca costs, denominator compatibility, integrity failures, clean/timed-out drain, real guarded dispatch cleanup and final-counter ordering.

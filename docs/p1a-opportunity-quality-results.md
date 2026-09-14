# P1-A opportunity-quality implementation / operator handoff

## Status and initial state

Base: `910066d527bf8d53deeb2d2c908b71a6e566fa11`, branch `codex/workflow-admission`. The starting worktree was clean. No merge or live comparison was performed.

**This is a tested partial implementation, not full P1-A acceptance.** Remaining diagnostic-retention and coverage limitations are listed below. No claim about real profitability, READY, or lane usefulness follows from deterministic fixtures.

## Verified defect and call map

The executable fast lane previously registered `RAW_POSITIVE` and zero-valued positive economics before completing leg 2. This polluted the broad-positive denominator.

- Broad/control: `buildRoundTripMatrix` -> `promoteRawImmediately` -> `registerRawPositive` -> `findExecutableCandidates` -> `buildExecutableCandidateFromRaw`.
- Existing executable plane: `executableSurfaceProvider` -> aggregator first legs -> `buildExecutableFastLane` -> the existing guarded `publishSupportedAggregatorHandoff`.
- Accounting: `RawPrefilterLedger` -> `ExecutionFunnel.snapshot` -> existing server/dashboard API.
- Cadence remains `executableSurfaceTurn++ % 10 !== 9`. `LiveSizeCadence`, policy, limits and selected amounts are unchanged.
- Refresh remains `ExecutablePairCoordinator.refresh`, with its existing bounds. It now has a distinct source label.
- Executor: independent final plan and simulation -> `calculateExecutorEconomics` -> passive breakdown observation -> unchanged final policy checks and automatic worker execution.

## Cohorts and schema

Telemetry schema **2** has a run UUID, wall start time, executable policy hash and best-effort checkout HEAD. HEAD is not a dirty-worktree/build integrity attestation.

Sources: `BROAD_MATRIX`, `EXECUTABLE_FAST_LANE`, `UNRESTRICTED_CONTROL`, `PAIR_REFRESH`, `ORCA_CROSS_POOL`, `ABOVE_CAP_SHADOW`.

- `RAW_POSITIVE` is a compatibility alias for completed positive broad/control cycles; it also records `BROAD_ROUND_TRIP_POSITIVE`.
- Fast-lane starts/completions have a separate executable-observation ledger. They do not enter the raw ledger or create fake zero-valued positive economics.
- `EXEC_SURFACE_POSITIVE` follows an actual `EXECUTABLE_CANDIDATE`, not an observation start.
- Duplicate/missing outcomes remain explicit invariant violations. Executable ledger API fields no longer call its denominator RAW_POSITIVE.
- Legacy reports carry `LEGACY_RAW_POSITIVE_COHORT_CONTAINS_UNPROVEN_FAST_LANE_ATTEMPTS`. The comparison summary rejects mixed schema/run samples.

## Economic breakdown and waterfall

Breakdown V1 is immutable and advisory. Quote amounts are integer atomic strings. Existing fractional-atomic scanner costs use a BigInt numerator/common decimal scale so classification does not introduce premature rounding. Floor/ceiling display fields are separate from exact scaled calculations.

Constrained earliest-fail precedence:

1. `EXEC_SURFACE_EXPECTED_NONPOSITIVE`
2. `MIN_OUTPUT_PROPAGATION_LOSS`
3. `NETWORK_COST_DOMINATED`
4. `ATA_RENT_DOMINATED`
5. `MIN_NET_THRESHOLD_SHORTFALL`
6. `MIN_ROI_THRESHOLD_SHORTFALL`
7. `EXEC_SURFACE_POSITIVE`, otherwise explicit `UNATTRIBUTED_ECONOMICS` for invalid/missing evidence or currently unattributable other costs.

ROI shortfall remains a secondary flag if minimum net fails first. Equality uses existing non-strict threshold passage; nonpositive net still fails. Venue fees remain embedded in provider output; minimum outputs are applied once. No extra optimistic-input quote was added.

Broad expected-output propagation, constrained minimum-output propagation, and Orca combined atomic two-hop enforcement are explicitly different models. Missing independently enforced Orca leg-1 minimum is not invented.

`ECONOMICS_DIVERGED` now requires a linked prior broad positive and stores both breakdown IDs plus the underlying numeric cause. Fast-lane nonpositive observations receive their direct numeric outcome. Comparison attributes include pool/shape change, evidence-age change and expected-net delta; missing program evidence means unknown comparison, not a fabricated route change.

## Executor independence and automatic authority

The handoff validators add only a passive observation after `calculateExecutorEconomics`. The observer accepts the independently reconstructed plan and executor economics, never scanner totals. Its scalar IPC whitelist excludes plans, instructions, provider payloads, URLs and signed bytes. Scanner/executor correlation uses existing execution identity in the parent process; the handoff DTO and route fingerprint are unchanged.

Authoritative total fee conversion is not recomputed. Diagnostic component allocation conserves that total and cannot assign conversion rounding to ATA rent when no ATA is needed. Component deltas are unknown where scanner evidence is absent.

`src/live-execution-worker.ts` is unchanged, including `await autoExecute(prepared)`. P0 publication remains behind the same fresh, positive, audited candidate checks. No manual approval requirement was restored. P0 recovery, signer, broadcaster, risk and no-broadcast capability implementations were not changed.

## Experiment, counters and dashboard

The existing 9:1 experiment is unchanged. Passive source context tags existing calls and actual Jupiter/Raptor quote dispatches; no provider lane or default quote stream was added. Observation starts never increment positive size utility; actual fast-lane positives now increment the existing constrained-positive counter.

The API/report includes source-lane planned/completed turns, logical quote calls, labeled legal sends, compatible/fresh cycles, economic outcomes, normalized yields, evidence age/skew, sampled distributions, nearest observations, executor comparisons and diagnostic loss indicators. The dashboard distinguishes broad positives, executable observations and executable positives, and shows numeric economic blockers. Percentages/percentiles are suppressed for small samples (20 for p50/p90, 100 for p99); count/max remain available.

**Coverage boundaries are explicit in `quality.accountingCoverage`:** legal sends cover labeled Jupiter/Raptor quote dispatch, not all direct RPC/background operations. Logical calls can coalesce onto one actual send. Provider call duration includes queue time and is not HTTP service latency. Orca cross-pool currently has cycle counts rather than full per-cycle numerical breakdowns. Per-lane distributions retain the latest 2,000 observations, while counters are cumulative.

## Diagnostic persistence and remaining acceptance gaps

The independent async JSONL buffer never queues behind risk/journal persistence and never writes inline in quote/P0 code. Ordinary samples are dropped first. Positive, P0, READY, executor-comparison and unattributed records receive critical priority. Failed writes retain the pending head and invalidate diagnostic evidence.

Full acceptance is **not** claimed because:

1. Critical queue capacity is finite (4,096). Overflow is explicitly counted and invalidates the report, but cannot satisfy an unconditional never-drop requirement during sustained storage failure. Guaranteeing both finite resources and lossless nonblocking output during arbitrary disk failure would require source backpressure, reserved durable capacity or an explicit failure/retention policy. This patch does not change production execution authority to achieve that.
2. JSONL files are segmented at 8 MiB, but cumulative disk retention is not bounded. Critical history is not automatically deleted. Operator-defined archive/retention remains open.
3. Full direct-provider/control coverage reconciliation and detailed Orca scanner/executor pairing remain incomplete. Reports must not claim that partial labeled counts cover every provider operation.
4. Executor plan evidence supplies one conservative quote timestamp, not individual leg timestamps. The executor emits `planEvidenceAgeMs`; individual leg ages/skew are unknown, not invented zero values. The comparison exposes a separately named plan-versus-scanner-oldest age delta. Use scanner pair-skew metrics for the lane comparison.
5. Stopping with outstanding observations can expose missing-outcome invariants; such a run is invalid, not silently reconciled. No new production execution drain/shutdown policy was introduced.

## Files changed

- `src/scanner.ts`, `src/scanner-executable-plane.ts`, `src/executable-pair-coordinator.ts`: correct writers/cohorts and label existing work.
- `src/execution/scanner-executable-prefilter.ts`: attach breakdowns and linked comparisons without changing financial guards.
- `src/execution/execution-funnel.ts`, `src/execution/raw-prefilter-ledger.ts`, new `src/execution/source-lane.ts`: separate ledgers, source/run/schema metadata and executor diagnostic IPC.
- New `src/economics/{economic-breakdown,scanner-breakdown,executor-breakdown,economic-telemetry,opportunity-quality}.ts`: exact diagnostic arithmetic, independent comparison and bounded aggregates.
- `src/profit.ts`, `src/routes.ts`: optional advisory metadata only.
- `src/execution/{handoff-validator,aggregator-handoff-validator}.ts`: passive independent executor observation only.
- `src/jupiter.ts`, `src/raptor.ts`: passive source-labeled dispatch counters; no governor/reservation changes.
- New `src/diagnostics/economic-diagnostics.ts`: separate bounded async diagnostic queue.
- `public/index.html`: truthful cohort/blocker display.
- `src/soak-controls.ts`, `src/production-workload-soak.ts`: explicit 15–60 minute comparison flag and report metadata/flush.
- New `scripts/summarize-opportunity-quality.mjs`; `scripts/summarize-production-soak.mjs`: offline comparison validity and legacy warning.
- New `test/opportunity-quality.test.ts`, `test/opportunity-quality-summary.test.ts`; updated funnel/raw-prefilter tests: arithmetic, cohort, persistence, independence, cadence, one-existing-leg-2-call and offline-report regressions.

## Automated validation

Final local validation on 2026-09-14: typecheck PASS; **347/347 tests across 42 files PASS** (single worker, 76.78 seconds); production build PASS. `git diff --check` passed. The full suite includes P0 fault injection, no-resend, risk/journal, bootstrap, isolation, no-broadcast and route-policy regressions. Synthetic quote fixtures are not evidence of market profitability.

Audit review retains the known **13 vulnerabilities: 7 moderate, 6 high**. No dependencies were upgraded or findings hidden.

Safe local verification, from a fresh PowerShell window:

```powershell
Set-Location C:\Users\ADMIN\Trader
$env:DOTENV_CONFIG_PATH='.ci-no-env-does-not-exist'
$env:EXECUTION_MODE='paper'
$env:LIVE_TRADING_ENABLED='false'
$env:MAX_TRADE_USDC='1'
npm.cmd run typecheck
npm.cmd test -- --maxWorkers=1
npm.cmd run build
npm.cmd run audit:review
```

These overrides affect that terminal only, not `.env`. Use a separate fresh terminal for the operator comparison so test settings do not alter its intended read-only configuration.

## Manual comparison commands — not run by Codex

From a fresh PowerShell window at `C:\Users\ADMIN\Trader`, run **one**:

```powershell
npm.cmd run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=15
npm.cmd run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=30
npm.cmd run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=60
```

Do not run `npm run dev` alongside it. Keep the PC plugged in and temporarily prevent sleep/hibernation in Windows power settings; restore your preferred settings afterward. Do not change bot caps or `.env`.

WSL/Linux, with Node 22 and dependencies installed for Linux rather than shared Windows native modules:

```sh
npm run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=15
npm run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=30
npm run scan:production-soak -- --opportunity-quality-comparison --duration-minutes=60
```

The existing harness loads runtime configuration normally, preserves the isolated executor and runs with submission disabled. It does not invoke automatic approval/submission. It emits startup/progress records and prints the exact `outputPath` on completion. Progress is expected every 30 seconds: `executorReady=true`, `scannerFailed=false`, no unexpected executor exit.

Output:

- `C:\Users\ADMIN\Trader\data\production-soak-<timestamp>.json` — final report.
- Same path plus `.checkpoint.json` — partial checkpoints, not final evidence.
- `diagnosticDirectory` in the report — per-run JSONL detail in the harness sandbox, normally under the Windows temporary directory. Keep it if detailed analysis is needed.

Summarize the newest final report:

```powershell
node scripts/summarize-opportunity-quality.mjs (Get-ChildItem .\data\production-soak-*.json -File | Where-Object Name -NotLike '*.checkpoint.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName)
```

Or provide its exact path explicitly (also works on Linux):

```sh
node scripts/summarize-opportunity-quality.mjs data/production-soak-<timestamp>.json
```

Send back the **single final `production-soak-<timestamp>.json`**, not `.env`, keys, database or signed bytes. The report includes aggregates and bounded representative details; retain the diagnostic directory locally if a follow-up needs a specific record.

## Interpretation

- **FAIL:** any broadcaster-factory, transport-construction, broadcaster-submit, transport-send or submitted-signature count exceeds zero. A guard violation is never market absence.
- **INVALID_RUN:** incomplete counters, missing zero-broadcast proof, continuity gap, incomplete duration, mixed telemetry schema/run, pending/missing/duplicate terminals, critical diagnostic loss/write failure, or incomplete critical flush.
- **INSUFFICIENT_SAMPLE_FOR_LANE_COMPARISON:** valid measurement but fewer than 20 completed fast economic evaluations or 20 control classifications. This is a reporting floor, not a statistical-power guarantee.
- **PASS_MEASUREMENT_ONLY:** valid evidence above that floor. It is not proof of lane superiority, all P1-A acceptance requirements, profitability or READY. Compare normalized yield, pressure, freshness and downstream latency together, respecting declared coverage limitations.
- Zero executable positives are not failure when covered and numerically explained. Unobserved downstream stages remain insufficient data, not successful validation.

No comparison was run by Codex. No real approvals, submissions, broadcasts or funds were used. `.env`, frozen safety configuration, route policy, token/provider restrictions and automatic authority remain unchanged. Adaptive sizing, capital changes, venue expansion and all P0 redesign remain deferred.

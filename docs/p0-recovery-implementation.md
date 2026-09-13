# P0 ambiguous-submission recovery handoff

## 1. Verified initial state

Base `6c00b01`, branch `codex/workflow-admission`. The working tree was clean. Production already called `autoExecute(prepared)` without a click. Ambiguous RPC/Jito responses left the journal `SUBMITTING`; `SUBMISSION_UNKNOWN` existed only in UI feedback. `pending` returned before reconciliation. Signer loading preceded journal/risk validation. The journal was unversioned; risk was v2 with partial idempotency. The existing operator soak already disabled live trading and used an isolated child.

## 2. Changed files

- `execution-journal.ts`, `broadcaster.ts`: versioning, immutable recovery metadata, durable unknown/expired-unlanded states, original-signature duplicate protection.
- `submission-reconciler.ts`, `confirmation-accounting.ts`, `risk-manager.ts`: public-only observation, height evidence, commitment, exact settlement replay.
- `executor-bootstrap.ts`, `live-config-validation.ts`, `config.ts`: pre-signer validation and public-state classification.
- `submission-capability.ts`, `jito-submission-transport.ts`: guarded factory, transport kind and measured submission counters.
- `runtime-readiness.ts`, `execution-readiness.ts`, `index.ts`, `live-execution-process.ts`, `live-execution-worker.ts`: reconciliation-first scheduling, signer-free startup recovery, truthful runtime gates and automatic-authority preservation.
- `production-workload-soak.ts`, `scripts/summarize-production-soak.mjs`: child counter acknowledgements and fail/invalid reporting.
- `test/submission-recovery.test.ts`, `test/executor-bootstrap.test.ts`, `test/recovery-soak-summary.test.ts`, `test/execution.test.ts`, `test/prefilter-workflow.test.ts`: recovery, bootstrap, capability, soak-verdict and compatibility tests.
- `test/raw-prefilter.test.ts`: three pre-existing expectations updated to the base commit's speculative leg-two behavior; policy rejection and absence of a promoted route are still asserted. No scanner/prefilter production code changed.
- This report and `submission-recovery-spec.md`.

## 3. Journal schema / migration

Top level is `{version:2,records:[...]}`. Unversioned journals migrate through the owning bootstrap's atomic checkpoint; dashboard/read-only loads never write a migration snapshot over concurrent executor state. Duplicates/malformed/unknown schemas reject. Unresolved legacy entries retain their records and signature and receive `INSUFFICIENT_LEGACY_METADATA` when recovery data is insufficient. Migration is idempotent. No runtime files were deleted.

New sends persist execution ID, original signature, signed-byte hash, blockhash, lastValidBlockHeight, public wallet/mints, raw input, transport kind, attempt ID, send boundary, recovery version and current policy hash before calling a transport. Those fields cannot change after the submission boundary.

## 4. Reconciliation state machine

Normal: preparation -> SUBMITTING -> SUBMITTED -> terminal confirmed/failed accounting.

Ambiguous: SUBMITTING -> SUBMISSION_UNKNOWN -> CONFIRMED / TRANSACTION_FAILED / EXPIRED_UNLANDED. CONFIRMING remains readable and recoverable. A direct legal recovery transition is allowed; no durable RECONCILING lease is introduced.

Submission-possible records are processed before `pending` and before risk-disabled candidate scheduling. More than one unresolved settlement blocks rather than choosing arbitrarily. Recovery has no signing or send interface. Terminal settlement clears in-memory pending only after durable accounting. A crash after terminal persistence but before cleanup is also handled.

## 5. Block-height expiry

Dedicated execution RPC, configured confirmation commitment, two successful nondecreasing heights strictly greater than the original lastValidBlockHeight, separated by at least LIVE_EXECUTION_POLL_MS. Recovery observations have a separate 2,000 ms maximum age; execution quote freshness is unchanged. A retained high-water mark rejects lower heights after an error. Status context slots cannot regress.

After qualifying heights, the final lookup checks signature status and transaction existence. Any landing observation wins. Previously observed landing is durable and prohibits an absence-based expiry. Failed/stale/malformed/contradictory observations retain the gate. Height qualification restarts after an error/restart. First/second height evidence and final lookup time are persisted for unlanded settlement. No wall-clock-only expiry, replacement signature or resend exists.

## 6. Pre-signer bootstrap

Configuration, mode capability, journal, atomic persistence and risk state are checked before `loadDedicatedSigner`. Valid unresolved public metadata enters RECONCILIATION_ONLY without reading the key. Legacy/multiple/unclassifiable records remain blocked without reading the key. After public recovery, readiness is rerun before signer loading. Parent startup recognizes reconciliation health without confusing it with readiness for new submissions.

Policy compatibility is evaluated for persisted routes. A historical policy mismatch does not authorize a new route; public observation of the original signature remains permitted. New execution still uses current independent route/policy validation.

## 7. Configuration validation

Added pure finite/range/integer checks for profit/slippage bps, positive loss/trade budgets, trade percentage, session/transaction/failure/concurrency caps, quote-age and RPC/provider/submission durations, provider pacing/concurrency and priority-fee ranges/percentile. Live session caps must agree and polling must remain below execution quote age. Existing scanner-RPC bounds remain. Errors do not echo supplied values. No configured values/defaults were increased or loosened.

## 8. Readiness truth

The restart gate is no longer unconditional PASS. Runtime readiness distinguishes UNVERIFIED, RECONCILIATION_ONLY, legacy/NOT_READY, NO_BROADCAST and READY_FOR_NEW_SUBMISSIONS. A stale readiness heartbeat is not submission readiness. Persistent risk and unresolved journal truth govern execution regardless of dashboard status.

## 9. No-broadcast defenses

The existing early autoExecute return remains. Bootstrap issues a branded immutable capability. The guarded factory rejects NO_BROADCAST before invoking its transport constructor callback, with no fallback/environment reread. Both worker submission paths use that factory. Measured counters cover broadcaster factory, transport construction, broadcaster submit, transport send and returned signature count.

## 10. Automatic execution preservation

`await autoExecute(prepared)` remains the production path. No required per-trade click was restored. Legacy manual endpoints/states remain solely for compatibility. Tests assert automatic invocation and the no-broadcast early guard. Nothing submitted real transactions during development.

## 11. Tests

Coverage includes RPC/Jito ambiguity; journal/risk/pre-transport boundaries; restart from each submission state; already/later landed and failed transactions; strict/equal/stale/regressing heights; final landed lookup; contradictory status/transaction data; actual persistence failure latches; duplicate observations and signatures; conflicting settlement evidence; terminal journal/risk replay; legacy migration; multiple unresolved records; pre-signer stores/config; capability zero counters; and readiness separation.

## 12–15. Automated validation

Final validation: `npm run typecheck` PASS; `npm test -- --maxWorkers=1` **301/301 tests, 40/40 files PASS**; `npm run build` PASS. The final full suite took 54.45 seconds. One preceding parallel run suffered a roughly nine-minute scheduling stall, file-read test timeouts and worker-start failures; it was not counted as passing. The single-worker rerun changed no test timeouts or production limits. `node --check scripts/summarize-production-soak.mjs` and `git diff --check` passed.

`npm run audit:review` passed its reviewed baseline: **13 known vulnerabilities, 7 moderate and 6 high**. This is not a clean dependency audit. No dependency upgrades or audit suppression were performed. Existing import/safety tests remain in the full suite.

## 16. Send-attempt proof

Mock-transport crash tests assert zero calls before the send boundary and exactly one call for ambiguous RPC/Jito outcomes, including after reconstruction of the broadcaster. A reused deterministic signature under another execution ID is blocked. The coordinator cannot send. No live transport was exercised. Risk precedes terminal journal persistence and binds execution ID, signature, outcome, net amount and financial evidence hash. Identical replay is a no-op; conflict halts. Unlanded settlement charges no fee and retains attempt counts.

Terminal journal entries missing risk can be repaired from matching deterministic chain accounting when sufficient metadata exists. Conflicting or insufficient historical data stays blocked; durable settlement is never undone.

## 17. Soak tooling

Existing 60–120 minute CLI (90 preferred), isolated child, sampling continuity, checkpoints, provider/RPC statistics and execution funnel remain. Reports now include recovery observations and measured submission counters. A final child acknowledgement is required; absent counters are not silently zero. Any nonzero submission-related counter fails the no-broadcast proof. No long soak or live startup smoke was run by the agent.

## 18. PowerShell soak command

From `C:\Users\ADMIN\Trader`, with `npm run dev` stopped:

```powershell
npm run scan:production-soak -- --duration-minutes=90
```

## 19. WSL/Linux

The same npm command applies in a separately installed Linux-compatible checkout using Node 22. Do not reuse Windows-native `node_modules` from WSL: this project includes native SQLite dependencies. No WSL execution was validated in this patch.

```sh
npm run scan:production-soak -- --duration-minutes=90
```

## 20. PowerShell summary command

```powershell
node scripts/summarize-production-soak.mjs (Get-ChildItem .\data\production-soak-*.json -File | Where-Object Name -NotLike '*.checkpoint.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName)
```

## 21. Files / awake operation

The started/finished messages print the exact `data\production-soak-<timestamp>.json` path; partial progress is `<same path>.checkpoint.json`. Send the final JSON back for analysis. Do not send `.env`, key files or signed bytes.

Plug in the PC, keep its lid open, and temporarily set Windows sleep while plugged in to Never; restore your normal setting afterward. Keep the terminal open and do not run dev concurrently. The harness detects gaps but does not change power settings.

## 22. Interpretation

- Progress every 30 seconds: elapsed time rises; executorReady true, executorExit null, scannerFailed false.
- Any construction/submit/send/signature count above zero: FAIL.
- Missing final counter acknowledgement, changed safety fingerprint, sampling gap, failed checkpoint or unhealthy worker: INVALID continuous soak.
- Valid zero-broadcast run without an eligible downstream candidate: INSUFFICIENT_DATA for those stages, not recovery or market success.
- Deterministic recovery tests are separate evidence and must pass before the soak. READY does not authorize submission in soak mode.

## 23. Remaining risks

Real RPC availability and market opportunity coverage remain operator-soak questions. Legacy insufficient metadata needs operator review; never delete state to unlock it. This uses one execution endpoint, not an independent quorum. Readiness is sampled health, not a promise of future RPC latency. Native Windows tests ran locally; remote CI/WSL were not run by the agent.

## 24. Deferred

No Jito tipping/bundle changes, provider expansion, executor restart automation, dynamic sizing, dependency changes, concurrency increases, approval cleanup or broad UI work. Real `.env`, secrets, capital, risk, quote freshness, profitability, slippage, token policy and exact route alignment remain unchanged. No merge to main.

## 25. Exact local no-broadcast verification commands

These overrides affect only the current shell and avoid loading the real `.env`:

```powershell
$env:DOTENV_CONFIG_PATH='.ci-no-env-does-not-exist'
$env:EXECUTION_MODE='paper'
$env:LIVE_TRADING_ENABLED='false'
$env:MAX_TRADE_USDC='1'
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run audit:review
```

Use a fresh PowerShell terminal for the operator soak so fixture overrides do not replace your normal runtime configuration. The harness itself enforces no-broadcast without editing `.env`.

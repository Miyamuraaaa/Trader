# Hardening branch result

Base: `85f9fc070873cb6bfd5e21b93050547e6dfda50d`.
Branch: `codex/professional-hardening`. Not pushed or merged.

## Implemented

1. Persistent daily/single/session risk limits; confirmed failed-transaction fees
   count conservatively; restart preserves duplicates and active session.
2. Shared Windows-safe atomic JSON persistence for both inboxes, journal and risk.
3. Independent aggregator/direct first-leg lanes, bounded background work and
   pending discovery/quote queues.
4. Priority/LRU leased subscriptions without increasing the subscription cap.
5. Versioned policy/route fingerprint evidence and strict fresh route alignment.
6. Execution funnel, last-ten-positive diagnostics, explicit size eligibility,
   scanner feed separate from real journal, rolling provider/RPC/lane metrics.
7. Node22 Ubuntu/Windows CI, audit artifacts and reviewed-exposure gate, recursive
   executor import tests, qs6.16.0 patch, central scanner RPC settings and generic
   wallet template.

## Verification

Local Windows: typecheck PASS; **155/155 tests across20 files PASS**; build PASS.
Baseline was109 tests;46 added. Tests cover risk/restart/fee accounting, persistence
faults, lane isolation, capacity/deduplication, subscription priorities, route
fingerprints, funnel semantics, import isolation and dashboard script syntax.

Full audit: **13 affected packages (6 high,7 moderate)** after qs patch, down
from16 in the fresh pre-patch audit. Reviewed-exposure gate passes, but this is
not vulnerability-free. Scanner-side native dependency risk remains documented.
GitHub Windows/Linux CI is configured, **not remotely verified**.

Synthetic first-leg scheduling test: slow Orca (+1s) reduced old aggregator
capacity to113 eval/min; bulkheads retained1912 versus1864 healthy. These are
fixture scheduler rates, NOT actual market/API throughput. Windows transient
EPERM test preserved unresolved data in two attempts.

Mainnet six-route infrastructure benchmark:8/18 samples constructed, inspected,
simulated and locally signed;10 failed with public RPC/Jupiter429. No profitable
READY candidate is claimed. Separate Orca validator hit the existing1000ms RPC
balance timeout. Handoff validator:6 pools,20 combinations,0 candidates,0 handoffs.
See [detailed measurements](hardening-benchmarks.md).

## Before deployment / remaining work

- Legacy risk state deliberately halts for operator review: missing historical
  daily fees cannot be reconstructed or silently reset. See [migration semantics](professional-hardening.md).
- Remote CI, long-duration soak and production-endpoint throughput remain unverified.
- Terminal history archival is deferred; unresolved journal records stay intact.
- Current scanner dependency exposure and upgrade decisions are in the
  [security review](dependency-security-audit.md).

No real `.env` was read or changed. No secret bytes were printed or committed.
The dedicated signer was used only through the existing no-broadcast validation
loader. **Zero real transactions broadcast.** Manual per-trade approval,
one-execution concurrency, profitability, simulation, inspection, quarantine and
1200/1800ms freshness policies remain intact.

## Changed files

- `.env.example`
- `.github/workflows/ci.yml`
- `.gitignore`
- `docs/dependency-security-audit.md`
- `docs/hardening-benchmarks.md`
- `docs/professional-hardening.md`
- `package-lock.json`
- `package.json`
- `public/index.html`
- `scripts/audit-review.mjs`
- `scripts/hardening-scanner-benchmark.ts`
- `src/config.ts`
- `src/direct-market-stream.ts`
- `src/execution/aggregator-cycle-builder.ts`
- `src/execution/aggregator-handoff-dto.ts`
- `src/execution/aggregator-handoff-inbox.ts`
- `src/execution/aggregator-handoff-validator.ts`
- `src/execution/confirmation-accounting.ts`
- `src/execution/executable-route-policy.ts`
- `src/execution/execution-diagnostics.ts`
- `src/execution/execution-funnel.ts`
- `src/execution/execution-journal.ts`
- `src/execution/execution-route-alignment.ts`
- `src/execution/handoff-inbox.ts`
- `src/execution/live-dashboard.ts`
- `src/execution/mixed-cycle-builder.ts`
- `src/execution/risk-manager.ts`
- `src/execution/scanner-display-eligibility.ts`
- `src/execution/scanner-executable-prefilter.ts`
- `src/execution/types.ts`
- `src/index.ts`
- `src/jupiter.ts`
- `src/live-execution-worker.ts`
- `src/persistence/atomic-json-file.ts`
- `src/provider-health.ts`
- `src/provider-runtime.ts`
- `src/raptor.ts`
- `src/routes.ts`
- `src/scanner-bulkheads.ts`
- `src/scanner-rpc-limiter.ts`
- `src/scanner.ts`
- `src/server.ts`
- `src/subscription-priority.ts`
- `src/work-metrics.ts`
- `test/atomic-persistence.test.ts`
- `test/execution-funnel.test.ts`
- `test/execution-route-alignment.test.ts`
- `test/execution.test.ts`
- `test/executor-isolation.test.ts`
- `test/jupiter.test.ts`
- `test/live-mode.test.ts`
- `test/risk-hardening.test.ts`
- `test/scanner-bulkheads.test.ts`
- `test/scanner-provider-capacity.test.ts`
- `test/scanner-rpc-limiter.test.ts`
- `test/subscription-priority.test.ts`
- `test/work-metrics.test.ts`

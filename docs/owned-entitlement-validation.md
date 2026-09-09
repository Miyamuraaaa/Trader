# Owned dispatch entitlement: implementation and production validation

Branch: `codex/workflow-admission`; implementation base: `01b22cf`. Not merged.

## Result

**Primary market acceptance criterion NOT demonstrated.** The new continuous 30-minute production soak observed zero raw positives. Consequently it did not exercise a real reservation, either constrained leg, constrained economics, or READY. Classification: **INSUFFICIENT_DATA for live promotion**, with no profitable raw signal observed in this particular run. This is not proof of market-wide absence or an external blocker preventing a feasible candidate.

Artifacts (local, ignored runtime evidence):

- Before: `data/production-soak-1788902780084.json`
- After: `data/production-soak-1788919878749.json`
- Reproduce the payload-free comparison: `node scripts/summarize-entitlement-soak.mjs data/production-soak-1788902780084.json data/production-soak-1788919878749.json`

## Root-cause evidence

1. The old 7 deadline outcomes were workflow infeasibility, not long prefilter queue residence. Eight raw evidence ages have p50 1,408 ms, p90/p99/max 2,438 ms. The immutable parent budget already had substantial age consumed before prefilter admission.
2. A real software defect existed in policy caching: `classifyIntermediate` entered the scanner RPC governor before consulting mint/ATA caches. A cooldown could reject already-cached work. Cache lookup now precedes RPC admission; misses retain RPC admission and unchanged TTL/policy checks.
3. Reservations protected discovery slots but did not give a claimed owner precedence over the weighted selector. Both provider dispatchers now select claimed owners first at a legal send opportunity. Owner/generation/semantic checks occur again at dispatch.
4. Noncritical history writes were still synchronous on the main thread despite `setImmediate`. They now run in a bounded worker-thread queue. Safety journal/risk/approval persistence is unchanged.

**The exact cause of historical candidate `bad4c1a5-e520-4a73-95f6-b4b305fc5edd:db76c4c8-741b-4b9e-97b8-50b78d361759` cannot be recovered from its artifact.** It contains `PREFILTER_RATE_LIMITED` without the underlying error. Token policy completed in 0.981 ms and leg 1 took 731.026 ms; no BEFORE_LEG2 projection exists. A policy-gate rejection is plausible but not proven. Reservation consumption failure is also not proven for that attempt because it never reached leg 2. New positive-signal records retain `prefilterReason`, including the `TOKEN_POLICY:` prefix.

The 731 ms field measures the entire leg call, including queue/pacing and quote processing; it was never an isolated HTTP sample. The fake-clock reproduction measures **624 ms queue/pacing + 107 ms HTTP = 731 ms**, with the original parent budget unchanged. This is a deterministic reproduction, **not a recovered historical HTTP measurement**. New request traces separate queue/pacing from HTTP/parse. Token wait, concurrency wait, first byte and callback delay are not separately instrumented yet.

## Reservation behavior

- Owned handle: reservation ID, workflow ID and generation, semantic envelope with amount initially unbound.
- CREATED/HELD reserves priority, not an advance token or concurrency permit.
- Claim binds the exact amount/semantic key; repeated identical claim is idempotent.
- Claimed owner precedes weighted discovery at the next legal dispatch opportunity.
- Consume verifies ownership, semantics, deadline, current provider pacing/cooldown and active HTTP work. Existing serialized provider dispatch remains the actual RPS/concurrency authority.
- One consume; release callback executes once. Abandonment/cancel expires or invalidates ownership; HTTP failures after consume are recorded separately.
- No fallback from invalid ownership to ordinary unreserved work.

## Changed files

| Files | Purpose |
|---|---|
| `src/provider-entitlement.ts`, `src/quote-admission.ts`, `src/jupiter.ts`, `src/raptor.ts`, `src/aggregators/types.ts` | Owned reservation lifecycle, protected dispatch, typed HTTP 429, request timing |
| `src/provider-failure.ts`, `src/execution/scanner-executable-prefilter.ts`, `src/execution/execution-funnel.ts` | Exact failure subreason, owned downstream claim, positive-signal diagnostics |
| `src/execution/execution-preflight-cache.ts` | Existing TTL-respecting cache peek before scanner RPC admission |
| `src/executable-pair-coordinator.ts`, `src/routes.ts`, `src/scanner.ts` | Bounded older-side refresh, new linked signal identity, exact min chain, full prefilter before P0 |
| `src/scanner-service-policy.ts` | Productive in-cap cadence with exploration and lower nonzero above-cap cadence |
| `src/scanner-rpc-limiter.ts` | RPC class attribution/priority, typed 429 detection, finite Retry-After handling |
| `src/scanner-history-buffer.ts`, `scripts/scanner-history-worker.mjs` | Bounded off-thread noncritical scan/quote history |
| `src/production-workload-soak.ts`, `scripts/summarize-entitlement-soak.mjs` | Soak snapshots and offline comparison |
| `test/provider-entitlement.test.ts`, `test/prefilter-cache-gate.test.ts`, `test/executable-pair-coordinator.test.ts`, `test/scanner-history-worker.test.ts`, `test/scanner-service-policy.test.ts` | Regression coverage |

## Validation

Windows local: `npm run typecheck` PASS; `npm test` **229/229, 34 files** PASS; `npm run build` PASS. Base had 209 tests; 20 added. Full suite includes existing executor isolation, fingerprint/alignment, manual approval, duplicate/reconciliation and no-broadcast guards. No additional standalone static-check command exists in package scripts; `git diff --check` passes. No claim of remote CI completion.

New tests cover owner/generation/semantic mismatch, consume/release once, protected dispatch, cooldown/pacing/concurrency/drift rejection, abandoned/canceled ownership, actual 429 vs local failures, realistic 731 ms decomposition, cache hit during RPC cooldown, fail-closed cache miss, Token-2022 exclusion, linked refresh identity, exact intermediate amount, refresh suppression, above-cap exclusion, productive-size exploration and actual off-thread history writes.

## Production results

After duration **1,800,687 ms (30 minutes)**, 60 samples, `validProductionSoak=true`, no gaps, executor ready, scanner not failed, broadcasts 0. The process stopped and released the scanner runtime lock.

The following comparison uses each run's **final rolling 60-second window**; these are different live-market periods, not controlled equivalent workloads. Queue figures include pacing; they are not pure semaphore residence.

| Metric, ms (p50 / p90 / p99) | Before | After |
|---|---|---|
| Jupiter queue | 980 / 3034 / 3285 | 950 / 1741 / 3098 |
| Jupiter service | 81 / 118 / 244 | 74 / 100 / 133 |
| Raptor queue | 707 / 1706 / 1732 | 684 / 1682 / 1702 |
| Raptor service | 294 / 353 / 847 | 322 / 395 / 714 |

After full-run deduplicated completed request traces:

| Provider | Samples | Queue+pacing p50/p90/p99, ms | HTTP+parse p50/p90/p99, ms |
|---|---:|---|---|
| Jupiter | 1310 | 784.5 / 1833.4 / 3163.2 | 64.3 / 97.2 / 160.3 |
| Raptor | 1727 | 719.5 / 1734.5 / 3639.5 | 291.5 / 333.2 / 751.9 |

Before has no equivalent request-level trace sample set. No claim that constrained Raptor queue p90 met its target: **zero constrained requests were observed**.

- Sampled rolling eval/min median: **29 -> 49**; p90: **40 -> 64**. Not a proof of improved profitable throughput.
- Scanner RPC 429/cooldown: **97/97 -> 95/95**; cooldown skips **1346 -> 593**; failed tasks **134 -> 133**.
- After RPC P1: 364 dispatches, 12 429s, 211 cooldown skips. P2: 784 dispatches, 83 429s, 382 skips. P0: zero. Broad RPC pressure persists.
- Largest sampled history write: **1907 ms on main thread -> 4599 ms in worker**. Storage itself did not improve. Largest sampled dispatch-drift p99: **1749 -> 270 ms**. After 29 failed noncritical writes, worker remained healthy; queue empty at completion. Exact failed-write SQLite causes are not yet captured.
- Event-loop lifetime p50/p90/p99: before **30.98/32.21/59.41 ms**, after **30.98/32.13/40.80 ms** (20 ms monitor resolution).
- Final history delay p50/p90/p99: **2.77/15.36/190.40 ms**. Detailed open/write/fsync/rename spans not available; SQLite worker writes do not use the safety JSON rename path.
- After provider dispatch class counts: Jupiter P1/P2 **692/619**, Raptor **583/1144**; P0 zero. Mixed broad observation still consumes substantial provider capacity. No protection-under-live-P0 claim is possible from this sample.
- Cadence before -> after: $0.05 **7.85 -> 12.02 s**, $0.10 **7.84 -> 12.08 s**, $0.25 **7.83 -> 12.05 s**, $0.50 **5.98 -> 2.40 s**, above-cap $1 **5.48 -> 17.75 s**. Counts/cadence in size diagnostics are bounded-window observations, not lifetime totals.

### Funnel and reservations

Before: raw 8 -> leg1 started 1 -> leg2 0 -> constrained economics 0 -> constrained positive 0 -> P0 0 -> executor 0 -> simulation 0 -> READY 0. Seven deadline outcomes, one broad rate-limit outcome; exact historical subreason missing.

After: **raw 0 -> leg1 0 -> leg2 0 -> constrained economics 0 -> constrained positive 0 -> P0 0 -> executor 0 -> aligned 0 -> simulation 0 -> final profitability 0 -> READY 0**. Missing/duplicate/unreconciled outcomes 0 (empty funnel, not a stressed invariant test). All reservation lifecycle counts and active reservations 0; protected borrowing attempts 0.

After raw-positive evidence age/skew, feasible-at-admission count and estimator prediction error have **no samples**. No real candidate completed both constrained legs. No genuine READY candidate occurred. There are no new representative positive traces to provide. The offline comparison prints all eight historical signals without pretending they are new results.

Cap/economic-size conclusion: **INSUFFICIENT_DATA**. No positive or shadow-constrained samples in the new run; cap unchanged. No $0.25 positive was observed in this run. Fixed-cost diagnostics remain empty without completed constrained economics; no unsupported cap recommendation is made.

## Remaining limitations

- Exact original fresh-candidate cause is unrecoverable from missing historical telemetry.
- Live owner claim/consume and two-leg economics still require a real eligible positive. Synthetic success cannot satisfy that criterion.
- Broad RPC remains the dominant observed 429 source. This patch adds class ordering/attribution and bypasses admission only for already-valid cache hits; it does not implement every requested RPC read-coalescing/future-reservation feature.
- Request tracing separates total queue/pacing and HTTP/parse, but not every token/concurrency/callback component. Refreshed pair skew percentiles and full storage subspans are not yet exported.
- Reserved-owner precedence needs further sustained-owner fairness stress coverage; current production run had no owners. Existing weighted discovery fairness tests do not prove this case.
- 29 noncritical history writes failed and were counted; precise SQLite cause still needs instrumentation. Safety state was not moved to the lossy worker.

## Safety

Real `.env` untouched; no secrets printed; normal ~1200 ms and Raptor ~1800 ms freshness unchanged; profitability, min-output, route/pool/program/fingerprint alignment unchanged; risk caps unchanged; Token-2022 and unaudited provider restrictions unchanged; isolated executor and manual ACCEPT & EXECUTE preserved; no automatic submission added; **zero real broadcasts**. No merge. User-owned `production-soak-result.txt` preserved and excluded from commits.

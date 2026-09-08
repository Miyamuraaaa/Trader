# Deadline admission implementation — 2026-09-08

Branch: `codex/deadline-admission`, base `bf22928`. Not merged.

## Scope and safety

This changes scanner quote admission, not execution authorization. Existing provider pacing/concurrency, executor profitability, route/pool fingerprints, token policy, signer isolation, simulation, manual localhost approval, duplicate protection and risk caps remain authoritative. Normal/Raptor freshness remains 1200/1800 ms. No `.env` or keypair was read or edited. No real transaction was broadcast.

This is **not evidence that a profitable real candidate reached READY**. The real probe below exercised quote infrastructure only. Full mixed-load scanner-to-executor acceptance is still unverified.

## Implementation

- `quote-admission.ts`: monotonic deadlines, admission and dispatch feasibility checks, successful-service EWMA/p90 (queue time excluded), per-class queue bounds (32 prefilter, 48 each discovery), provider bound 128, 32 waiters per semantic identity. Admission accounts for the next pacing opportunity. Expired work never earns a longer timeout or a retry.
- `scanner-service-policy.ts`: earliest-deadline ordering within a class; prefilter can reclaim the next legal slot, with at most two consecutive prefilter slots while discovery waits. Discovery high/low retain rotating service. Existing provider pacing still determines legal dispatch times.
- `jupiter.ts`, `raptor.ts`, `provider-runtime.ts`, `aggregators/types.ts`, direct-provider call sites: integrate admission into existing independent provider queues. Exact semantic keys include every quote option except scheduling metadata; unrestricted and constrained work cannot share. Successful cache reuse retains original expiry. Each shared waiter has its own deadline and source-age check. Queued abandoned work is cancelled; physically running work retains its permit until settlement.
- `scanner-executable-prefilter.ts`: passes one bounded attempt deadline through both constrained legs, preserves sequential enforceable-minimum chaining, overlaps independent policy/leg-one work, exposes exact queue-deadline outcome and actual estimated costs. Background mint prewarm is low priority. Token-policy, quote and total-prefilter durations use monotonic time.
- `scanner-size-diagnostics.ts`, `scanner.ts`: cap-aware 3:1 eligible/observation cadence with bounded, decaying recent-positive utility and unconditional exploration. Every configured size remains observable. Actual available cost snapshots expire after 60 seconds; missing rent/cost observations are not invented.
- `raw-prefilter-ledger.ts`, `execution-funnel.ts`: exactly-once constrained outcome accounting, duplicate/missing-outcome invariant counters, original outcome subcategories retained, monotonic adjacent-stage percentiles. An abandoned trace is a visible invariant violation, not unexplained disappearance. `QUOTE_FAILED` includes explicitly identified coalesced/no-independent-quote and missing-outcome subcategories; inspect `sourceResults`, not just its aggregate.
- `bounded-advisory-cache.ts`, preflight/fee caches: size bounds and TTLs for mint/ATA/fee advisory data. No cached item grants execution authority. This does not claim a completed cache redesign for every pool/ALT/template.
- `work-metrics.ts`, `dispatch-diagnostics.ts`, `server.ts`: queue/service p99, admission counters, lane depth/age, per-size costs/cadence, event-loop histogram and timer-dispatch drift through existing API/WebSocket payloads.
- `scanner-admission-soak.ts`: bounded quote-only probe using existing provider adapters, with `.env` bypass, no scanner engine/signer/IPC/journal imports, and a read-method fetch guard. It neither signs nor submits nor auto-approves.

## Deterministic evidence (synthetic, not market profitability)

Fixture: 60 seconds, one provider legal dispatch per second, 375 ms service, sustained high/low discovery plus a simultaneous burst of 20 constrained requests. Same budget before/after; old weighted scheduler versus deadline admission.

| Metric | Before | After |
|---|---:|---:|
| Provider dispatches | 60 | 60 |
| Discovery dispatches | 40 | 59 |
| Prefilter dispatches | 20 | 1 |
| Predicted-infeasible dispatches | 45 | 0 |
| Queue high-water | 22 | 3 |
| All-class queue p50 | 13000 ms | 1000 ms |
| All-class queue p90 | 25000 ms | 2000 ms |

The infeasible burst is rejected, not accelerated into success. Twenty quotes cannot all complete inside 1800 ms on a one-request/second serial provider. Discovery continues, and urgent feasible work receives service. Queue p90 across discovery is not an executor freshness metric.

Tests cover strict semantic differences, waiter-specific expiry, no late dispatch, service/queue separation, bounded waiters and cleanup, service reservation/fairness, size exploration, cost/ATA handling, duplicate/missing funnel outcomes, monotonic stage timing, and cache expiry/bounds. Existing execution safety/architecture tests remain in the full suite.

Final local Windows validation: `npm run typecheck` PASS; `npm test` **186/186 tests in 25 files PASS** (12 new tests over the 174-test base); `npm run build` PASS. No Windows CI run or deployment is claimed. Test runs bypassed `.env` and disabled live trading. New tests are in `quote-admission.test.ts`, `admission-diagnostics.test.ts`, and `deadline-budget-benchmark.test.ts`; existing capacity, service-policy and raw-prefilter fixtures were updated for structured errors and injected monotonic clocks.

Funnel regression fixture: 3 raw positives = 1 ABOVE_LIVE_CAP + 1 ECONOMICS_DIVERGED + 1 QUOTE_FAILED (explicit missing-outcome invariant violation). Unreconciled = 0; duplicate attempt = 1 and missing outcome = 1 are deliberately visible. Normalizing into a bucket does not hide the violation.

## Real quote-only infrastructure observation

Artifact: `data/admission-soak-small-20260908.json` (local runtime artifact, not committed). Duration **180026 ms**. All five providers, USDC/WSOL, sizes 0.05/0.10/0.25/0.50/1.00. No credentials loaded from `.env`. Requests were independently paced per provider with a one-second probe-loop pause; this is **not the production mixed-route queue workload**.

| Provider | Attempts | Successful quotes | Failures | Whole-probe call elapsed p50/p90/p99 ms |
|---|---:|---:|---:|---|
| Jupiter | 116 | 116 | 0 | 325 / 1081 / 1112 |
| Raptor | 141 | 141 | 0 | 334 / 365 / 547 |
| Raydium | 136 | 136 | 0 | 402 / 456 / 573 |
| Orca | 135 | 130 | 5 | 15 / 1050 / 2510 |
| Meteora | 145 | 139 | 6 | 2 / 1023 / 2103 |

673 attempts, 662 successful quote returns, 11 rate-limit/cooldown failures. Quote returns include valid cache hits, **not route evaluations**. Raptor and Jupiter had zero observed HTTP 429s; direct failures combine cooldown/backpressure and must not be called eleven distinct HTTP 429s.

Final rolling-60s observations:

- Raptor queue p50/p90/p99: **0 / 1 / 1 ms**, service: **337 / 409 / 546 ms**, 36 dispatched requests, high-water 1.
- Jupiter queue: **946 / 986 / 1009 ms**, service: **89 / 119 / 154 ms**, 29 dispatched requests, high-water 1. Keyless pacing, rather than HTTP, explains most waiting here.
- Event-loop histogram (whole probe, 5820 samples, 20 ms resolution): **31.2 / 33.0 / 52.0 ms**. Includes timer resolution/Windows scheduling, not solely CPU stalls.
- Timer dispatch drift (19 final-minute samples): **5.7 / 11.9 / 17.7 ms**.
- Jupiter/Raptor successful cache reuse avoided **29 / 35** provider calls. This workload did not generate concurrent identical waiters, so it does not measure in-flight hit rate.
- 506/673 discovery attempts were at the eligible 0.05 size (75.2%). Every other size remained sampled. Raptor: 106 eligible attempts, 35 above-cap observations; actual HTTP service split 71 high / 35 low after cache hits. No constrained or prewarm work in this probe.
- No routes evaluated, no raw-positive observations, no P0/executor/READY events, no broadcasts. These fields are zero **by probe scope**, not evidence that the market had no opportunities. Candidate-to-READY latency and conversion are unavailable.

An earlier 181291 ms probe accidentally used repository-default observation sizes 10/25/50/100. Its artifact is retained as `data/admission-soak-public-20260908.json`; it is not used as a comparable before baseline or cap economics evidence.

## Before/after limits and root cause

The supplied production baseline was Raptor queue p90 2774 ms versus service p90 about 375 ms and freshness 1800 ms: the queue alone exceeds the entire freshness window. That identifies a queue/admission mismatch, not proof that Raptor HTTP itself is too slow. The synthetic test demonstrates prevention of infeasible dispatch; the real low-backlog probe confirms that this machine can obtain Raptor service in hundreds of milliseconds.

It would be incorrect to compare the probe's 1 ms Raptor queue p90 directly with the production 2774 ms and claim a production speedup. A matched production-like mixed-load soak is still required. No measured before/after production eval/min or READY improvement is claimed.

Current evidence-backed classification: **G — INSUFFICIENT_DATA for profitable executable READY conversion**. The probe also measured direct-provider rate-limit/backpressure, but did not establish that this prevented a particular profitable candidate from reaching READY. Historical cap/policy/economics outcomes supplied by the user are not new observations.

## Cost diagnostics and remaining work

The implemented diagnostic uses existing base fee, priority fee, actual known ATA rent, other known costs, and the stricter configured minimum-profit/ROI requirement. Provider fees/impact already embedded in quoted output are not added again. Required output is minimum enforceable output *after* embedded fees; unknown ATA costs produce an explicitly incomplete lower bound.

Fixture only: with existing-test costs base 0.001 + priority 0.0001 USDC and existing ATA, external break-even cost is 0.0011 USDC: 220/110/44/22/11 bps at 0.05/0.10/0.25/0.50/1.00. These are **not live fee estimates**. Adding actual required rent increases the cost exactly once. No current route-specific rent/fee sample or positive round-trip economics was collected in the quote-only probe, so no conclusion that the cap is too small is justified.

Outstanding acceptance evidence/work:

- Matched before/after full scanner workload with constrained prefilters and exact route economics, followed by no-broadcast executor receipt/READY observation.
- Complete per-size/per-pair request-budget and terminal-stage breakdown (the new API fields do not yet cover every requested source/size dimension).
- Background route/ALT/template prewarm coverage beyond existing caches, and end-to-end monotonic trace linkage across every journal stage.
- Dashboard rendering for the newly exposed admission/cost fields; existing funnel/manual approval is unchanged.
- Service prediction is an estimate, not a guarantee: unexpectedly slow HTTP can still expire a waiter. It must fail closed, never extend freshness.

Do not enable or claim readiness on the strength of this report.

# Raw-positive prefilter follow-up

Branch: `codex/professional-hardening`; follow-up base: `7e899db`.

## Cause and repair

Raw positives were not executor attempts. First-leg persistence preceded matrix work, individual second-leg positives waited for the matrix to settle, and constrained prefiltering started after further persistence/bookkeeping. Token policy and constrained leg 1 were sequential. Stale constrained evidence could be reported as economic divergence, while scanner lifecycle expiry appeared as generic EXPIRED.

Per-route completion now starts constrained promotion immediately, before matrix completion or history writes. Token policy and constrained leg 1 overlap. Leg 2 still consumes only leg 1's enforceable minimum. Successful constrained results use the existing strict v2 fingerprinted P0 handoff before history persistence; history retains the same opportunity ID. Executor validation is unchanged.

Admission is bounded to 32 active route identities, each with at most one newest pending trigger. Evidence must advance by at least 50 ms to replace/rerun work. Pending work is rechecked against unchanged scanner freshness/lifecycle limits when started. Provider pacing remains in force.

## Diagnostics and accounting

Correlated traces record detection/evidence, queue/start, token policy, constrained legs, and completion timestamps and durations. Explicit results distinguish cap/pair/token/route rejection, economics divergence, quote failure, stale raw evidence, stale prefilter evidence, rate limits, and ended signals.

Rolling raw-stage totals use detection cohorts: every raw positive occupies exactly one result bucket, including PENDING while unfinished. COALESCED means an identical/older or superseded trigger did not launch another quote; OBSERVATION_ONLY means no live promotion was requested. TELEMETRY_CAPACITY explicitly accounts for bounded retention overflow. Session totals are retained separately; rolling telemetry retains 15 minutes, capped at 100,000 records. Downstream executor events retain their own event-time windows and are not inferred from raw signals.

Live scanner lifecycle EXPIRED is displayed as MARKET_SIGNAL_ENDED in HTTP/WebSocket opportunity feeds; stored lifecycle TTL and executor expiry behavior are unchanged. Last-ten diagnostics expose raw/constrained economics, timing, eligibility, P0 and executor outcomes.

## Deterministic no-broadcast benchmark

Run the `raw-prefilter.test.ts` fixture benchmark with the real `.env` bypassed, paper mode, and live trading disabled. No network, signer, handoff publication or broadcaster is used. These are simulated-clock measurements, not live-market performance claims. Sequential baseline models the former policy -> leg1 -> leg2 dependency schedule with identical fixture latencies; it excludes unmeasured historical persistence/matrix delays.

| Metric | p50 ms | p90 ms |
| --- | ---: | ---: |
| Sequential baseline total | 315 | 380 |
| Parallel prefilter total | 205 | 265 |
| Raw detection -> prefilter start | 0 | 0 |
| Constrained leg 1 | 100 | 120 |
| Constrained leg 2 (9 calls) | 80 | 100 |

10/10 completed: 6 executor-constrained positives + 3 ECONOMICS_DIVERGED + 1 PREFILTER_RATE_LIMITED = 10 raw positives. P0 = 0; executor received = 0; actual executor expiry = 0; broadcasts = 0. A separate deterministic test delays Orca by 1 second and verifies aggregator positive prefiltering starts before direct completion and history work.

Remaining bottleneck: real constrained-provider latency/rate limits and actual constrained liquidity economics. No new live-market quote benchmark was run; these changes do not prove a live candidate reaches READY.

Safety: execution freshness 1200 ms / Raptor 1800 ms unchanged; profitability, route alignment, inspection, simulation, signer, balance, duplicate protections and manual approval unchanged. Real `.env` was not read or changed. No merge or broadcast.

# Workflow admission: implementation and incomplete production validation

Branch: `codex/workflow-admission`, based on `23e9ffb` on `codex/deadline-admission`. Not merged.

## Implemented

- `quote-admission.ts`: forecasts read the provider's actual next legal send and cooldown, not only the admission wrapper's last dispatch. Rate-limit attribution records class and requested cooldown separately from HTTP latency.
- `prefilter-workflow.ts`, `scanner-executable-prefilter.ts`: immutable parent deadline from original evidence; whole dependent workflow feasibility, downstream service and local/P0 reserve; exact enforceable minimum still feeds leg two. Invalid future evidence produces a terminal result.
- `scanner-service-policy.ts`: deadline-ordered 60/30/10 reservations under existing provider pacing, bounded borrowing and discovery service. No added RPS or concurrency.
- `jupiter.ts`: auxiliary pacing is rechecked after sleeping; quote and auxiliary HTTP cannot overlap. `raptor.ts`, `http.ts`: preserve and honor Retry-After and attribute rate limits.
- `scanner-executable-plane.ts`, `scanner.ts`: prewarmed eligibility selects existing audited quote constraints for executable-surface discovery; broad observation remains available. Above-cap shadow diagnostics use P2, one in flight and at least 60 seconds between starts; they return scalar diagnostics only, never a handoff or authority.
- `scanner-history-buffer.ts`: bounded asynchronous noncritical first-leg history. Journal, risk and raw terminal outcomes are not made best-effort.
- `server.ts`: exposes workflow projections and history-buffer metrics.
- `production-workload-soak.ts`, `production-soak-child.ts`, `live-execution-worker.ts`, `live-execution-process.ts`: actual mixed scanner plus isolated executor diagnostic runner, no approval server, acceptance blocked before broadcaster construction, LIVE_TRADING_ENABLED=false. Separate temporary data directory preserves copied risk/journal state; production files are not deleted.
- `soak-continuity.ts`: a suspended/stalled process cannot masquerade as a successful continuous soak. Reports are written before potentially hanging WebSocket unsubscribe. Checkpoints preserve partial evidence.
- `scripts/summarize-production-soak.mjs`: read-only report summary; separates valid prefix from a sampling gap. `package.json`: `npm run scan:production-soak`.

## Tests

New coverage: dependent-workflow deadlines, pacing/cooldown projections, 60/30/10 saturated service, borrowing reclamation, history pressure, executable-surface policy, Retry-After attribution, independent coalesced waiter expiry/error cleanup, Jupiter auxiliary/quote pacing and concurrency, fake diagnostic-capability rejection, invalid future evidence, no-broadcast acceptance guard, and soak continuity.

Final validation: typecheck PASS, 204/204 tests across 29 files PASS, build PASS. Existing alignment, risk, freshness, manual-approval and execution tests remain included.

## Actual production evidence — NOT a completed 30-minute soak

Artifact: `data/production-soak-1788883816943.json` (local runtime output, not committed).

Requested: 1,800,000 ms. There were 21 regular samples through 630,130.654 ms (10.502 minutes). The next sample arrived at 11,444,973 ms: a 10,814,842 ms gap, approximately three hours. The runner then stopped and saved the report. A host suspension or process stall is consistent with this gap; the artifact cannot identify which. The wall/monotonic elapsed total of 11,445,261 ms is **not** continuous workload evidence. The earlier interrupted run also is not a completed soak.

The isolated executor reported ready. Scanner did not report failure. No approval server was started, no acceptance was sent and zero transactions were broadcast. The diagnostic processes have stopped.

Valid prefix, latest rolling 60-second window:

| Provider | Queue p50/p90/p99 ms | HTTP p50/p90/p99 ms | Requests in window | Queue high-water |
|---|---:|---:|---:|---:|
| Raptor | 692 / 1692 / 1714 | 326 / 355 / 526 | 58 | 2 |
| Jupiter | 985 / 2045 / 2898 | 64 / 96 / 228 | 51 | 2 |

These are window percentiles, **not pooled whole-soak percentiles**. The prior reported Raptor mixed queue p90 was 2774 ms; the quote-only probe reported about 1 ms. These different workloads/time periods are not a controlled before/after experiment.

- Mean of 21 rolling evaluation-rate samples: 43.14/min; range 24–72/min. This does not establish a sustained throughput improvement.
- Raptor dispatched P1=135, P2=454; Jupiter P1=257, P2=269. P0=0 for both. Empty P0 capacity was borrowed; real urgent-prefilter service was not exercised.
- Jupiter/Raptor recorded no 429s in the valid prefix. Scanner RPC recorded 36 429s, 397 cooldown skips, and four queued backpressure rejections. Direct/mixed completions decreased while aggregator work continued.
- Raptor recorded one discovery admission deadline drop; Jupiter one waiter deadline expiry. No eligible raw candidate was lost to executor expiry, because none entered the executor.
- Event-loop histogram p50/p90/p99: 30.92/32.64/59.74 ms (20 ms monitor resolution; not exclusive CPU-block measurements). Dispatch drift p50/p90/p99: 7.57/13.70/24.07 ms.
- History: 1,344 completed writes, zero pressure drops, one failed noncritical write; its error cause was not retained. Recent write-duration p90 0.46 ms. No evidence that history dominated provider queue residence.
- 18 provider calls avoided per aggregator, including cache reuse; this is not a pure in-flight coalescing hit count.

## Funnel and representative signals

`8 RAW_POSITIVE = 8 ABOVE_LIVE_CAP`, with zero pending, missing or duplicate terminal outcomes. Constrained positives, P0, executor receipts, alignment, simulation, final profitability and READY were all zero. No $0.25 positive was observed in this prefix, so the historical $0.25 example cannot be diagnosed from this run.

All five examples below were Jupiter -> Raptor, USDC -> WSOL -> USDC, $1. Their complete IDs, timestamps and pools are in the artifact. Each stopped at ABOVE_LIVE_CAP; no execution stage occurred.

| Trace ID prefix | Raw expected / worst USDC | Raw evidence age ms | Outcome |
|---|---:|---:|---|
| b522733a | +0.001125 / +0.000623 | 1936 | ABOVE_LIVE_CAP |
| b3073eb1 | +0.001197 / +0.000695 | 421 | ABOVE_LIVE_CAP |
| 1198ff7e | +0.001439 / +0.000937 | 323 | ABOVE_LIVE_CAP |
| 672edff5 | +0.001585 / +0.001083 | 3778 | ABOVE_LIVE_CAP |
| fa030283 | +0.001529 / +0.001027 | 2388 | ABOVE_LIVE_CAP |

## Size/cost evidence

The runtime classified $0.05/$0.10/$0.25/$0.50 as in-cap and $1 as above-cap; no cap was changed. Eligible-size discovery attempts: 77/76/76/76; $1 observation attempts: 101. Eligible sizes collectively received approximately 75% of size turns. Each eligible size individually was less frequent than the single observation size; this limitation must not be hidden.

Raw signals recorded base fee 0.00075 USDC and priority fee 0.00060 USDC. Their 0.00135 USDC sum is only a **lower-bound additional cost**, not proof of full-route profitability. Required ATA state/cost and fresh full constrained economics were not successfully obtained for these signals. Provider fees are embedded in quoted output; slippage is enforced by minimum output, not charged twice.

| Size USDC | Fee-only lower-bound break-even bps | In cap |
|---|---:|---|
| 0.05 | 270 | Yes |
| 0.10 | 135 | Yes |
| 0.25 | 54 | Yes |
| 0.50 | 27 | Yes |
| 1.00 | 13.5 | No |

Two above-cap shadow attempts: one deadline rejection, one rate-limit classification. Neither established constrained positive economics. Therefore `CURRENT_CAP_EXCLUDED_OBSERVED_ECONOMIC_SIZES` is **not proven**; only exclusion of eight raw-positive observations is proven.

## Root cause and remaining acceptance gaps

1. Production workload consumes paced slots and incurs scanner-RPC backpressure absent from a quote-only probe. Measured HTTP latency was much smaller than queue residence. The exact contribution of the historical 17/30 failures cannot be reconstructed without those original traces.
2. Code-level defects repaired: auxiliary Jupiter pacing race and workflow forecasting without actual provider legal-send/cooldown/downstream reserve. Deterministic tests establish the fixes; this prefix has no eligible positive to establish production conversion success.
3. All observed raw positives were above-cap. It is not valid to conclude an executable profitable route existed or that raising a cap would help.
4. Host/process discontinuity prevents the mandatory continuous 30–60 minute acceptance run. Final classification: **INSUFFICIENT_DATA** for end-to-end READY and cap economics. Scanner RPC rate limiting is measured, but no eligible READY attempt exists to attribute to it.

Outstanding: continuous soak on an awake/stable host, eligible-candidate production traces, precise per-class legal/concurrency-wait metrics, complete cost/shadow samples, and production proof of urgent reservation behavior. Do not declare the task's market-success criterion achieved.

No real .env edits, secrets exposed, freshness/profitability/alignment relaxations, cap increases, Token-2022 enablement, unaudited execution enablement, automatic submission, journal deletion, or merge. Normal manual ACCEPT & EXECUTE remains mandatory; the diagnostic process refuses acceptance entirely.

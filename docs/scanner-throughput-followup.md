# Scanner throughput follow-up

Base: `474c635`, branch `codex/professional-hardening`. No merge, live approval, send call or `.env` modification.

## Pre-edit measurement, not retrospective attribution

Read-only GET of the already-running localhost dashboard returned **56 completed route evaluations/60s**, not the previously reported 29. Lane counts: aggregator 26, direct 6, mixed 24; completed cycles 26; cycle p50/p90 3029/5169 ms. The exact earlier 29/min interval cannot be reconstructed from this snapshot.

| Provider | Requests/60s | Queue p50/p90 ms | Request p50/p90 ms | Active/queued |
| --- | ---: | --- | --- | --- |
| Jupiter | 30 | 57 / 1060 | 71 / 105 | 0 / 0 |
| Raptor | 60 | 719 / 2774 | 299 / 375 | 1 / 2 |
| Raydium | 48 | 0 / 565 | 345 / 520 | 0 / 0 |
| Orca | 30 | 1398 / 3828 | 113 / 458 | 0 / 0 |
| Meteora | 34 | 2316 / 7622 | 2 / 725 | 0 / 0 |

Jupiter/Raptor had zero rolling 429s. Scanner RPC recorded four rolling 429s, queue p50/p90 1/314 ms, request 216/538 ms, effective concurrency 1, and an active ~5.3s cooldown. Provider duration samples can include deliberate backpressure failures; they are not all successful network calls.

Prefilter queue p50/p90 was 0/2 ms; total 504/1089 ms; leg1 89/376 ms; leg2 902/1030 ms. Ledger: **30 = 12 above cap + 9 rate-limited + 8 economics-diverged + 1 route-policy rejection**. All 18 admitted attempts completed. Above-cap triggers made no constrained requests.

Scheduler, cost, matrix and persistence stage histograms did not exist before this change. No historical numbers are invented for them. Source inspection confirmed that fast matrix completion still awaited all associated prefilter promises, and HIGH-first shared provider queues had no minimum LOW service.

## Changes

- Existing Jupiter/Raptor and direct-provider queues now use work-conserving 2:1:1 service slots: EXEC_PREFILTER_HIGH, DISCOVERY_HIGH, DISCOVERY_LOW. HIGH/LOW aliases preserve existing callers. FIFO holds within each class. Existing RPS, concurrency, queue caps, dedupe, cooldown and retry behavior remain unchanged. This guarantees queued discovery service, not extra network capacity.
- Fast-cycle completion no longer awaits constrained-prefilter results. The bounded coalescer still performs promotion and strict P0 handoff; history continuations retain the same opportunity identity. Direct/mixed background reservations remain bounded.
- Live sizes use three eligible turns followed by one observation turn, each group round-robin. All configured sizes remain observable. No live cap is increased.
- Add queue high-water metrics, fixed-label stage profiles, explicit rolling work counts/backlogs, and dashboard request-versus-queue attribution. Existing completed-route 60s metric remains unchanged, not replaced by request or selected-row counts.
- Raw outcomes reconcile by detection cohort. TTL-ended prefilter triggers map to MARKET_SIGNAL_ENDED_BEFORE_PREFILTER; terminal outcomes cannot be overwritten. PENDING remains explicit only while work is active. COALESCED remains a separate duplicate/superseded-work bucket: labelling those triggers as market expiry would be false. These are explicitly documented additional accounting categories rather than hiding raw observations. Session/rolling summaries now list every bucket, including rate limits. ABOVE_LIVE_CAP remains independent of market-lifecycle display.

## Observed post-edit profile

Read-only snapshot: 56 evals/60s (aggregator25/direct1/mixed30), 30 cycles/60s. Not a controlled before/after market experiment; **no measured production throughput gain is claimed**.

| Stage | p50 / p90 ms |
| --- | --- |
| Cost snapshot | 1 / 26 |
| Aggregator first leg | 1950 / 3039 |
| Direct first leg | 978 / 1016 |
| Aggregator matrix | 1012 / 3060 |
| Direct matrix | 0 / 1002 |
| Mixed matrix | 1001 / 1030 |
| Route persistence/bookkeeping | 9 / 109 |
| Completed cycle | 3035 / 5037 |

Scheduler sleep had no samples during that event-driven window, rather than a fabricated zero latency. Token-policy/leg timings remain in per-signal traces; new stage/high-water histograms need a full rolling window after restart. Market movement and RPC backpressure remain material confounders.

## No-broadcast synthetic benchmarks

Two separate models; do not combine their rates into a production forecast.

1. Lane/barrier fixtures use production bulkhead/matrix logic with fixed mock quote latencies, 20 cycles, bounded direct reservations and injected prefilter waits. No provider RPS model; values show removal of the completion barrier only.

| Scenario | Aggregator eval/min before -> after | Cycle p90 before -> after ms | Prefilter attempts |
| --- | --- | --- | ---: |
| Healthy | 266.7 -> 400 | 900 -> 300 | 5 |
| Orca +1s | 266.7 -> 400 | 900 -> 300 | 5 |
| Meteora 429 | 266.7 -> 400 | 900 -> 300 | 5 |
| 20 positive triggers | 133.3 -> 400 | 900 -> 300 | 20 |
| Above-cap positives | 400 -> 400 | 300 -> 300 | 0 |
| Slow Jupiter constrained work | 80 -> 400 | 1500 -> 300 | 20 |
| Slow Raptor constrained work | 80 -> 400 | 1500 -> 300 | 20 |

Normal fixtures completed 40 aggregator / 40 direct / 160 mixed routes including background drain; degraded-direct fixtures completed 40 / 0 / 80. These completion counts include background drain and are intentionally not misrepresented as rolling direct/mixed eval rates.

2. Finite service-budget fixture admits 60 request slots/min before and after. During a 20-prefilter burst, both schedules serve 40 discovery and 20 prefilter requests; queue high-water stays22. Queue p50 worsens 5s -> 15s while p90 improves 41s -> 21s, reflecting fairness rather than additional capacity. Healthy/above-cap cases use zero prefilter slots. Separate tests verify discovery service within each four-slot rotation under sustained load.

Existing constrained-prefilter fixture still completes10/10: 6 constrained positives + 3 economics-diverged + 1 rate-limited, total p50/p90205/265ms. Synthetic P0, executor, submission counts all zero.

## Limits

The historical 29/min regression is not fully attributable without its stage trace. Live provider request budgets and scanner-RPC backpressure remain the measured bottlenecks; these changes cannot make negative constrained economics profitable. No live opportunity or READY success is claimed. Scheduler fairness can trade median latency for bounded tail wait. Manual approval, freshness1200/1800ms, cap, token policy, route fingerprint, inspection, simulation, balance/signer and duplicate protections remain unchanged.

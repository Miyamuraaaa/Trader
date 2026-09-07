# Hardening validation — Windows, 2026-09-07

Node22.23.2. No application `.env` read. No mainnet broadcast. Manual approval
and 1200/1800ms execution freshness remain unchanged.

## Scheduler isolation (synthetic, not market throughput)

Run `npx tsx scripts/hardening-scanner-benchmark.ts`. The script imports no signer,
scanner entrypoint or sender, uses TEST DATA, and writes only its own temporary
test JSON. First legs are 20ms apart from the injected fault; second-leg service
is held at 20ms. Windows timer scheduling affects actual measured duration.
Counts below are scheduling capacity, **not live API rates or profitable trades**.

| Scenario | Aggregator eval/min old → new | New direct / mixed eval/min | New total eval/min | New cycles/min | New cycle p50/p90 ms |
|---|---:|---:|---:|---:|---:|
| Healthy | 1912 → 1864 | 5447 / 10895 | 18206 | 932 | 64.0 / 68.7 |
| Orca +1000ms | 113 → 1912 | 2199 / 7650 | 11762 | 956 | 63.0 / 64.0 |
| Meteora 429/cooldown | 1903 → 1905 | 1857 / 7428 | 11190 | 952 | 62.5 / 63.9 |
| Shared direct RPC cooldown | 1910 → 1900 | 0 / 0 | 1900 | 950 | 63.7 / 64.0 |

Slow-Orca old cycle p50/p90:1057.7/1061.3ms. New aggregator capacity remained
within normal run variance of healthy capacity. Meteora fault produced one429
and39 skipped requests; shared cooldown skipped120 direct first legs. Provider
task p90 was32–34ms in new cases; queues and real quote staleness are not modeled
by this isolated experiment, and must not be reported as measured zero.
Provider/RPC queue, timeout, deduplication and recovery correctness have separate
unit tests. Direct/mixed throughput remains available when providers are healthy.

Transient Windows EPERM replacement: two rename attempts,30.7ms, unresolved test
record preserved. The wider persistence test suite covers EPERM/EBUSY/EACCES,
permanent failure, cleanup, concurrent updates and all four migrated consumers.

## Mainnet infrastructure benchmark (not profitable candidates)

Ran existing `execution:latency-benchmark` with3 samples per direction and1100ms
between samples. Used public mainnet RPC explicitly, the previously supplied
dedicated wallet address/keypair through its existing loader, dry-run mode,
LIVE_TRADING_ENABLED=false and NOT_READY. No API keys or `.env` were read into
the assistant. This does **not** benchmark the user's private Helius endpoint.

The existing benchmark constructs/inspects/simulates/locally signs infrastructure
routes. It does not establish positive conservative arbitrage economics or
scanner→executor route alignment, so local-sign-ready is NOT live READY approval.

| Direction | Passing simulations/signing | Quote/build p50/p90 ms | Simulation p50/p90 ms | Local-sign-ready p50/p90 ms | Failures |
|---|---:|---:|---:|---:|---|
| Raptor → Jupiter | 0/3 | unavailable | unavailable | unavailable | 1 public RPC429,2 Jupiter429 |
| Jupiter → Raptor | 1/3 | 1060.5 /1060.5 | 103.7 /103.7 | 1334.7 /1334.7 | 2 Jupiter429 |
| Jupiter → Orca | 3/3 | 173.6 /856.6 | 85.3 /92.3 | 527.6 /1207.5 | none in this small sample |
| Orca → Jupiter | 1/3 | 248.4 /248.4 | 94.3 /94.3 | 570.9 /570.9 | 2 Jupiter429 |
| Raptor → Orca | 2/3 | 563.7 /1113.1 | 85.9 /95.5 | 819.9 /1365.6 | 1 public RPC429 |
| Orca → Raptor | 0/3 | unavailable | unavailable | unavailable | 3 public RPC429 |

Percentiles use passing samples only; with n=1 they are identical, not a reliable
latency distribution. Total8/18 successful infrastructure samples,10/18 rate-limit
failures. No expiry rejection was reported in these samples. Route-change and
economics-divergence rates are **not measured** by this infrastructure harness.
It measures freshness at simulation request; response age can be greater, and its
local-sign-ready output must not be substituted for the production validator's
final approval gates. No freshness policy was loosened to obtain these results.

Static warmup included Orca discovery450.7ms, parsed preflight239.3ms, rent67.7ms,
fee sample73.6ms. Observed simulation RTTs were under104ms for passing samples;
the prominent external limitation in this run was request admission (429), not
simulation compute latency. Production throughput/positive-funnel acceptance
still needs observation with the operator's configured endpoint and rate plan.

## Remaining validation limits

Separate validators on2026-09-08: `execution:validate` failed closed on the public
RPC balance request exceeding the existing1000ms RPC timeout. No timeout was
raised. The handoff validator ran in a new temporary working directory so its
inbox could not change the operator's runtime journal/inbox. It found6 Orca pools
(5 USDC/WSOL),20 ordered combinations,20 state prefilters,0 exact evaluations,
0 state failures and0 candidates/handoffs at0.01/0.02/0.05 USDC. Result:
NO EXECUTION-ELIGIBLE LIVE OPPORTUNITY; BROADCAST DISABLED.

Local Windows typecheck/tests/build are run on the branch. Linux/Windows GitHub
matrix is configured but not remotely run here (branch has not been pushed or
merged). No claim of remote CI success, live profit, or confirmed trade is made.
Long-duration market soak and terminal-journal archival are not completed by
these short tests; unresolved records remain in the reconciliation journal.

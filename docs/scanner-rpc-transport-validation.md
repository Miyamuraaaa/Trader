# Scanner RPC transport hardening

Branch: `codex/workflow-admission`; implementation base: `8cc07b1`.

Final local validation: typecheck PASS; **250 tests across 37 files PASS** (21 additional tests versus the 229-test baseline); production build PASS; `git diff --check` PASS. Existing safety/architecture and reservation tests ran as part of the full suite. No separate live validator or long soak was launched.

## Evidence and scope

The previous production run recorded 95 scanner RPC 429s, including 83 attributed to P2, and 593 cooldown skips. It did not record individual RPC methods. A production ranking by method therefore cannot be reconstructed honestly from that report.

The targeted code inspection found a concrete admission-granularity gap: a single admitted scanner task could issue multiple simultaneous SDK RPC reads. Task concurrency/pacing did not govern each physical HTTP send. Wallet fan-out and SDK account reads are examples. This does not prove external endpoint contention, a duplicate governor, or the precise cause of every historical 429.

Scanner Web3 and Kit HTTP transports now share the endpoint governor. Logical task wrappers provide asynchronous lineage rather than acquiring a second nested permit. Actual sends obey existing configured pacing/concurrency and mandatory cooldown. P2 is shed during cooldown; deadline-feasible P0/P1 can wait and drain through normal pacing. P1 live dependencies precede background P1 work. No configured maxima changed.

No duplicate governor was proven in the old production run. Canonical endpoint registration now reuses an instance and rejects conflicting registration. Endpoint telemetry contains hashes, not URLs.

## Coalescing and cache boundaries

Only explicitly listed idempotent reads coalesce. Keys bind endpoint, adapter, method and all canonical parameters. JSON-RPC IDs are rebound for each caller. P0 and wallet/balance observations bypass sharing/cache. Priority classes do not share pending entries, avoiding priority inversion behind broad refreshes. Each waiter checks its own deadline, response age and minimum context slot; cancellation detaches that waiter. Queues, waiters, shared requests and telemetry are bounded.

The advisory response-cache implementation is tested, but production callers currently enable **no response-cache TTL**. No broad speculative caching or expiry jitter was enabled without method-level hotspot evidence. Existing protocol metadata caches remain in place. The isolated executor bypasses scanner admission/cache; its authoritative validation is unchanged.

## Deterministic mixed-RPC benchmark

This is a fake-clock, no-network workload, **not production performance or profitability evidence**. Twelve batches contain four logical reads (A, A, B, C), distributed across P0/P1/P2. The synthetic endpoint allows one send per 100 ms and responds in 20 ms. Baseline models the old logical-task fan-out; after uses the actual new transport governor. Measurement window: 60 simulated seconds.

| Metric | Fan-out baseline | Transport governor |
|---|---:|---:|
| Logical calls | 48 | 48 |
| Physical sends | 48 | 40 |
| HTTP 429/min | 36 | 0 |
| Successful useful semantic observations | 12 | 36 |
| 429/1,000 unique useful observations | 3,000 | 0 |
| Cooldown ms/min | 1,800 | 0 |
| Cooldown skips/1,000 useful observations | 0 | 0 |
| Successful caller completion | 25% | 100% |
| Calls avoided by coalescing | 0 | 8 (16.7%) |

"Unique useful" in this report means a successful semantic key in a one-second creation bucket, not an economic opportunity. Before/after useful denominators therefore differ. The fixture baseline's cooldown measurement is its modeled callback-level suppression, not a replay of production's adaptive governor.

After: P0 uses 16 sends; P1 and P2 use 12 each, with four duplicate calls avoided in each discovery class. P1 caller completion is 100%. HTTP p50/p90/p99/max is 20/20/20/20 ms. Combined caller end-to-end p50/p90/p99/max is 120/220/320/320 ms. Queue/pacing/concurrency and method/class sample counts are emitted by `test/rpc-mixed-benchmark.test.ts`; they are not interchangeable with HTTP service time. This benchmark establishes removal of the demonstrated fan-out burst, not a measured provider rolling-window quota.

## Changed areas

- `scanner-rpc-limiter.ts`: actual-send admission, monotonic timing, cancellation, feasible cooldown waiting and bounded P1 service.
- `scanner-rpc-transport.ts`: endpoint registry, HTTP boundary, exact sharing, advisory-cache boundary, safe correlated request telemetry.
- `solana.ts`, `meteora.ts`, `dynamic-token-universe.ts`, `wallet-reader.ts`, `direct-market-stream.ts`, `execution/scanner-executable-prefilter.ts`: scanner transport integration and lineage.
- `provider-runtime.ts`: quarantined Meteora work remains broad/P2.
- `raptor.ts`: bounded legal-send/class and service telemetry only; owned reservation implementation unchanged.
- `scanner.ts`, `executable-coverage.ts`: executable-surface coverage/economics observations and guarded optional stop before P0.
- `soak-controls.ts`, `production-workload-soak.ts`, `rpc-soak-report.ts`: duration validation, safety fingerprint, readiness/continuity checks, trace deltas and normalized report.
- New transport, long-soak and deterministic RPC benchmark tests; existing limiter fake-clock test updated for monotonic time.

## Operator run

Do not run `npm run dev` concurrently. From `C:\Users\ADMIN\Trader`:

```powershell
npm run scan:production-soak -- --duration-minutes=90
```

The existing production scanner and isolated executor run with submission disabled and no approval bridge. Real manual approval code is unchanged. No approval is automatically invoked. Real `.env` is only loaded normally by the operator-run harness, not modified or copied.

Every 30 seconds stdout reports increasing `elapsedSeconds`, `executorReady: true`, `executorExit: null`, and `scannerFailed: false`. Sleep, telemetry gaps, failed checkpoints, executor exit or changed safety fingerprints invalidate the long run. Keep the machine awake; the harness detects continuity problems but does not change OS power settings.

At completion expect `finished: true`, `validProductionSoak: true`, `safetyUnchanged: true`, and `broadcasts: 0`. Inspect the full report's `healthySamples`, `checkpointFailures`, `wallClockDriftMaxMs` and `continuity` as well. A valid run is not proof of sufficient market coverage or profitability.

Stdout prints the exact output path. Send back only **`C:\Users\ADMIN\Trader\data\production-soak-<timestamp>.json`**, not `.env`, keys or the partial `.checkpoint.json` file.

Optional `--stop-after-constrained-economics` blocks P0 from the start and stops only after both constrained legs and required reservation consumption. It persists public quote/economics evidence. Early completion is a functional checkpoint, **not** a valid 60–120 minute coverage soak.

## Captured evidence and remaining limitations

The report includes RPC endpoint/method/class/task request IDs and semantic hashes, cache/sharing outcomes, dispatch admission state, queue/pacing/concurrency/cooldown timings, HTTP timings, exact failures, originating cooldown request, context slot, burst maxima, inter-arrival statistics and normalized summaries. It also retains existing workflow, reservation, funnel, scanner-history and dispatch diagnostics, plus Raptor legal-send events and per-size planned/completed/compatible/fresh coverage, age/skew/economics distributions and nearest observations.

Bounded raw trace retention is 2,048 completed RPC traces per endpoint between collections, with delta snapshots every 30 seconds. Detailed cache-mismatch/jitter, response first-byte, and OS-level transport timing are not claimed. WebSocket protocol traffic and external processes are not counted as governed HTTP sends. Raptor telemetry does not redesign or revalidate reservations; a real admitted owner must exercise them. Cold-start service estimates lack production samples and remain a measurement limitation.

No long live soak was run in this iteration. There is no new genuine READY result, production method ranking, production before/after Raptor percentile, or production normalized 429 reduction to claim. Zero raw positives must be assessed against compatible fresh coverage and provider/RPC suppression, not classified as market absence merely because the elapsed-time check passed. Send the operator report back for that assessment.

`.env`, signer material, execution freshness, profitability, alignment, risk caps, token/provider restrictions, manual approval and owned reservations remain unchanged. Validation produced zero approvals, submissions and broadcasts. No merge was performed.

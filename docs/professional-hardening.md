# Professional hardening

Base: `85f9fc070873cb6bfd5e21b93050547e6dfda50d`.
All development validation is no-broadcast and does not load the local `.env`.

## Persistent risk semantics (v2)

The existing flat session counters now have a persistent `sessionId` and
`sessionStartedAt`. A process restart resumes that session. The session trade cap
is explicitly bounded to 1–100. `beginReviewedSession` is an operator-only API,
not connected to startup or the dashboard; it cannot clear duplicate identities,
daily loss, unresolved submissions, or a review halt.

Daily loss uses an explicit UTC date key. Midnight changes only the daily bucket;
it does not reset session losses/counts. Backwards clock movement blocks execution.
Delayed reconciliation charges the current accounting day conservatively, rather
than allowing a historical transaction to avoid today's risk budget.

Both daily and single-transaction configured limits are wired into live execution.
An oversized realized single-transaction loss latches an operator-review halt.
Confirmed USDC deltas remain separate from risk-adjusted loss: the risk ledger
also charges the larger of the wallet SOL debit and actual fee, converted with
`EXECUTION_SOL_PRICE_CEILING_USDC`, rounded upward. SOL credits and intermediate
dust are not credited as USDC profit. Failed confirmed transaction fees count;
timeouts and local failures do not invent on-chain losses.

The confirmed outcome is written idempotently to risk state before the journal
becomes terminal. A failure to obtain accounting or persist it leaves the journal
in `CONFIRMING`, requiring reconciliation, not resubmission.

Legacy risk files retain all counters and duplicate identities but migrate to
`LEGACY_RISK_STATE_REQUIRES_OPERATOR_REVIEW`: they do not contain enough dated
fee history to reconstruct daily protection safely. Do not delete/reset them.
Reconcile historical outcomes and review the retained state before any operator
migration; no automatic unlock or fabricated history is provided.

## Scanner and telemetry

Aggregator first-leg work is independent of direct first legs. Continuous scans
publish the fast lane before bounded direct/mixed background work finishes.
Direct deadlines affect scanner work only, not execution freshness. Outstanding
first-leg work is deduplicated and capped; background direct cycles are capped at
four. Subscription capacity is unchanged, with leased priority/LRU ownership.

Aggregator handoff v2 binds policy and normalized pool/program/amount evidence.
Historical v1 records remain readable, but cannot create new live approvals.
Fresh executor pool/program/amount-chain alignment remains mandatory.

The dashboard now separates scanner observations from actual executor attempts.
READY, user approval, submission and confirmation are distinct states. The funnel
reports process-session totals and rolling 60s/5m/15m windows (bounded to 100,000
events), the last ten positives, constrained costs and explicit live-size caps.
Timing percentiles are absent, not fabricated zero-latency successes, when no
matching start/end evidence exists. The funnel begins at process startup; it does
not invent telemetry for historical journal entries.

Provider work metrics describe logical quote tasks, including any existing
provider retries; they are not individual HTTP-attempt counters. Queue time and
task time are separate, with rolling 60s percentiles. Existing HTTP/rate-limit
counters remain available separately. Read-only observation is never a trade or
realized PnL.

## CI and deployment notes

Supported runtime: Node22 (local validation22.23.2); CI runs the full suite on
Ubuntu and Windows. The GitHub jobs have not run until this branch is pushed.
`npm run audit:review` saves an ignored JSON artifact and enforces the dated,
reviewed advisory/version baseline; it does not describe remaining exposures as
fixed. See dependency-security-audit.md and hardening-benchmarks.md.

Scanner RPC options are validated centrally and exposed without endpoint secrets
in `/api/health`. The example environment has empty wallet identity and a generic
external WSL path; the real `.env` was not touched. Scanner queues and pending
pair-support discovery are bounded, including after soft deadlines. An executable
subscription gets a short priority lease so a normal HOT/WARM scheduling pass
cannot immediately demote it; this is not a quote-freshness relaxation.

Before deploying, review migration from legacy risk state. This branch deliberately
does not invent historical daily fee accounting or automatically clear its review
halt. Terminal-history archival and long-duration soak validation remain future
work; unresolved submission records are never removed to improve throughput.

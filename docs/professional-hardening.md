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

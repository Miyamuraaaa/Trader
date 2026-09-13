# P0 recovery contract

Production authority remains automatic. Recovery never constructs, signs or sends a transaction.

Journal v2 records the original signature, byte hash, recent blockhash, last valid block height, public route identity, transport and attempt identity before submission. Legacy unresolved entries without these fields stay blocked. No journal deletion or wall-clock expiry is permitted.

Each scheduler turn gives submission-possible journal records precedence over transient pending state. Multiple unresolved submissions are an invariant failure. A single unresolved record enters read-only reconciliation. New sends remain blocked until risk settlement and terminal journal persistence succeed.

Expiry requires two fresh monotonic execution-RPC block heights strictly above the persisted last valid height, at least one polling interval apart, followed by a final status AND transaction lookup. Any landing observation wins over expiry. Missing, stale, contradictory or failed observations do not release the gate. Restart discards in-memory height evidence and requires two new observations.

Fault boundaries: SUBMITTING persistence; attempt persistence; pre-send; ambiguous transport; landed observation; risk settlement; terminal journal write. Each is exercised without real transports. Risk precedes terminal journal settlement; replay must either match exactly or halt. An unlanded outcome settles zero loss/fee without refunding attempt counters.

No-broadcast capability rejects transport/broadcaster factories before client construction. Counters distinguish factory construction, transport construction, submit invocation, network send and returned signatures. The long infrastructure soak is operator-run only; deterministic tests are the recovery evidence.

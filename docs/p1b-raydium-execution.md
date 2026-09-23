# P1-B: bounded Raptor -> Raydium CLMM execution

## 2026-09-23 retained-soak rejection diagnosis

Read-only inspection of `data/production-soak-1790085639588.json` found the three
distinct Raptor -> Raydium positives (IDs starting `d39bc27e`, `2bf9a162`,
`e80cf051`). Each was size 500000 and used WSOL as the intermediate mint.
Their Raydium pool counts were respectively 2, 1, 2. All recorded
`RAYDIUM_NON_NATIVE_SINGLE_POOL_CAPABILITY_ONLY`, no constrained-leg starts,
and no P0 handoff. These are expected unsupported-intent rejections, NOT proof
of capability loss. Two also violate the single-pool restriction.

The combined reason is now split into native-mint, single-pool and single-route-
step subreasons (joined when several apply), with unchanged rejection behavior.
Generic discovery quotes intentionally remain unmarked. The prefilter replaces
supported intent with `quoteRaydiumExecutablePool` from fresh checked state;
that producer already stamps the bounded capability. No normalization/cache is
between that local quote and prefilter policy/evidence generation. Existing pair
refresh applies only to Jupiter/Raptor, not Raydium. No generic quote stamping or
policy relaxation was warranted. Regression fixtures cover local producer ->
clone -> policy -> v2 evidence and unmarked discovery -> constrained prefilter.
Tests have been written, not run by the agent.

Status: implementation and offline test cases written; **not typechecked, built,
tested, simulated against live infrastructure, or traded in this task**. The user
explicitly reserved validation. This document is not evidence of a successful
READY candidate, profitability, or audited deployed-program equivalence.

## Observed scope

The retained production report `data/production-soak-1789637532287.json` counted
55 Raptor -> Raydium signals. Pool IDs remained available for 44: 28 single-pool
routes and 16 multi-pool routes. All 28 retained single-pool routes resolved to
CLMM account owners/layouts. A CPMM pool appeared only in multi-pool evidence.
Eleven signals lacked retained pool evidence and cannot be classified.

Public account inspection used confirmed slot 447781812. Classification used
program owner and layout, not the shared Anchor PoolState discriminator alone.
These historical observations do not prove current liquidity or executability.

## Capability and restrictions

Only `raptor:raydium` is added to the existing six executable pairs. Policy
version 3 hashes the bounded capability, including builder/inspector version 1,
plan schema 1, fingerprint 2, classic SPL, exact-in, and one Raydium pool.

CLMM program: `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`.
Adapter: `raydium:clmm:swap:static-cell:builder1:inspector1:plan1:fp2`.

This first implementation is intentionally narrower than generic CLMM support:

- The Raptor first leg must itself use one supported Raydium CLMM adapter,
  one branch/hop, without fees, proxy accounts, wrapping or extra setup/cleanup.
- The direct second leg uses locally constructed legacy `swap`, exact input,
  zero sqrt-price limit (full-fill semantics), and exactly ten accounts.
- Both wallet ATAs must already exist. Native SOL/WSOL, account creation,
  closure and rent-bearing setup are rejected.
- Local integer quoting supports static input fees and movement strictly inside
  the current tick-spacing cell. Traversal is rejected, never approximated,
  clipped or resized. Current-array coverage must be sufficient without bitmap
  extension or remaining arrays.
- Dynamic fees, permissioned pools, fee-on-output, limit orders, CPMM, AMM V4,
  multi-pool Raydium and unknown layouts remain unsupported.

These restrictions can reject otherwise legitimate market routes. They are not
a claim that all 28 observed single-pool routes will execute.

## Authority and amount chain

The scanner uses an exact-pool local constrained requote; Trade API discovery
does not carry the executable capability. Pool-family hints are bounded to 256
entries/60 seconds and never cache authoritative pool state.

The existing strict handoff carries only intent. The existing validator selects
`buildRaptorRaydiumCycle`, independently rebuilds the Raptor quote/instruction,
fetches fresh execution-RPC CLMM state and ALTs, compares route fingerprints,
inspects, simulates, then calculates existing executor economics.

The immutable atomic chain is:

`Raydium input == Raptor minAmountOut == first-leg otherAmountThreshold`.

Expected output is never substituted for that minimum. All token arithmetic is
integer atomic. Raydium expected/minimum outputs are independently recomputed by
the inspector. Scanner totals cannot change executor economics.

`autoExecute`, signer, broadcaster, risk, journal, recovery, confirmation,
one-send behavior, concurrency and economic/freshness limits are unchanged.
The old generic Raydium Trade API transaction prototype now explicitly fails
closed; it cannot bypass the capability-specific builder.

## Inspection and simulation

Fresh RPC validation checks pool/config PDAs, owner/discriminators/layouts,
mint ordering, vault authorities, observation identity, current tick-array PDA,
start/order/coverage, classic mint/token accounts and program executability.
The final inspector binds instruction bytes, exact amounts, account roles,
pool/mint direction, hashes and capability. Unknown remaining layouts reject.

Raptor inspection decodes the complete supported 76-byte V1 swap layout, not
just a quote or instruction hash: input/expected/minimum, split amount, branch,
hop, adapter, weight and zero fee/unwrap fields must match.

Unsigned simulation additionally validates the exact compiled message and fresh
ALT contents; permitted CPI programs; one modeled first-leg CLMM CPI; four exact
token-transfer roles; propagated amount; output minima; SOL fee delta; unchanged
token authorities; no account creation/closure; pool identity; compute usage;
and complete, non-truncated effect evidence. Missing parsed effects reject.

The pre-account snapshot and simulation must have the **same confirmed slot**.
Different banks reject rather than attributing unrelated changes to the trade.
This deliberately conservative condition may reduce liveness and needs user
validation. No retry or freshness reset is added.

## Protocol references and dependency decision

- Raydium official source: https://github.com/raydium-io/raydium-clmm
  (`swap.rs`, pool/config/tick-array/oracle layouts and integer math libraries).
- Raptor published IDL:
  https://idl-one.vercel.app/api/idl?programId=RaptorD5ojtsqDDtJeRsunPLg6GvLYNnwKJWxYE4m87
  IDL metadata RaptorV1 0.1.0. SHA-256 of the fetched JSON.stringify(idl):
  `bf1b047cc53c6ed0455284a5317ed1ee3d47839c4fc9ef294c167afd7bcac766`.
- Raptor binary repository: https://github.com/solanatracker/raptor-binary

Published interface/source review is not reproducible-build verification of the
currently deployed binaries. Program upgrades/layout changes must fail closed.
No Raydium SDK or other dependency was added; no SDK send/execute helper or Trade
API serialized transaction is used. The existing scanner SDK stays isolated.

## User-run no-broadcast validator (not run here)

From the repository, with a current strict v2 handoff containing policy v3/hash:

```powershell
npm.cmd run execution:raptor-raydium-validate -- --candidate="C:\path\candidate.json" --wallet="PUBLIC_WALLET_ADDRESS"
```

It accepts only a public wallet, independently rebuilds, aligns, inspects,
simulates unsigned and evaluates unchanged final economics. It does not load a
signer or construct a broadcaster/transport. Accidental Connection send-method
access throws before calling the underlying client. No approval or submission
is produced. Reports are `data/raptor-raydium-validation-<timestamp>.json`.

`wouldBeReadyAfterMarketChecks` is NOT full READY authorization: balance/reserve,
persistent risk, journal, final freshness and submission capability remain live
authority gates. Report counters describe this validator only.

## Changed files and tests

New capability, Raptor decoder, atomic builder, simulation-effects module,
read-only validator/CLI and `test/raydium-execution.test.ts` accompany changes to
the existing Raydium builder, scanner prefilter/eligibility, policy, handoff
dispatch, inspector, simulator, plan types, scanner labels and package script.
The mixed builder exports existing schemas/helpers; no old-pair builder logic
is changed. Isolation tests permit only the new local builder, not scanner SDKs.

Tests written cover binary/amount/account/capability mutations, exact chaining,
classic token authorities, unsupported pool state, traversal rejection, ALTs,
strict handoffs, scanner economics independence, packet bounds, zero-send
protection, CPI/token/SOL/account/compute/log/context simulation anomalies and
the six prior provider pairs. **All remain unrun.** Real instruction fixtures,
typecheck/full regression execution and live no-broadcast simulation remain
required before treating this implementation as validated.

# Solana arbitrage scanner and guarded atomic executor

A live-market scanner for direct and aggregated Solana quotes with explicit `paper`, `dry-run`, and guarded `live` modes. Live submission is available only to an already inspected, simulated, fingerprinted, locally signed opportunity after all runtime guards and local manual approval pass.

## Safety boundary

This application never stores a private key in the repository. Its scanner only:

- requests quote data;
- reads public pool/RPC state;
- compares venues;
- estimates costs and profitability; and
- records live quote observations and independent quote confirmations.

`EXECUTION_MODE=paper` is the default. `dry-run` constructs, strictly inspects, locally signs only the approved transaction message, and simulates without broadcasting. `live` additionally requires every hard guard plus a local `ACCEPT & EXECUTE` action. A detected spread is never guaranteed profit.

The `/api/readiness` endpoint lists every gate and its status. This prevents quote capability from being confused with dry-run or execution capability.

## Architecture

```text
Jupiter GET quote -----------\
Raptor HTTP + /stream -------+--> normalized atomic quote
Raydium compute GET ---------+             |
Orca pool state + core math -+             +--> five-provider comparison
Meteora state + swapQuote ---/             |
                                             +--> exact two-leg matrix
                                                  |
                          DIRECT_CROSS_DEX <------+--> AGGREGATOR_ROUTE
                                                  |
                                      estimated live-quote profitability
```

The existing top-level module layout was preserved to avoid a cosmetic rewrite. Shared Phase 3 pieces are:

- `src/aggregators/types.ts` — normalized quote, full/partial fill, pool, and provider types.
- `src/provider-runtime.ts` — direct-provider pacing, cache, coalescing, metrics, and circuit cooldown.
- `src/pool-registry.ts` — TTL-cached Orca/Meteora pool metadata.
- `src/routes.ts` — exact-output propagation, full matrix, classifications, overlap, stale checks, and display.
- `src/tokens.ts` — verified SOL/WSOL, USDC, and USDT allowlist.
- `src/dynamic-token-universe.ts` — low-frequency Jupiter top-trending, top-traded, and organic-score discovery with liquidity/volume filters, exact-mint RPC validation, deny/allow lists, and HOT/WARM/DISCOVERY tiers.
- `src/token-universe.ts` — core plus currently selected dynamic token cycles.
- `src/wallet-reader.ts` — public-address-only native/SPL/Token-2022 balance reader; it cannot sign.
- `src/execution-readiness.ts` — fail-closed capability and real-money readiness inventory.
- `src/raptor-stream.ts` — quote-only WebSocket updates and reconnect handling.
- `src/opportunity-lifecycle.ts` — identities, NEW/IMPROVED/DEGRADED/EXPIRED events, and lifetime metrics.

Jupiter and Raptor remain independent and keep their existing integrations.

## How quotes are obtained

| Provider | Read-only path | Discovery/state |
|---|---|---|
| Jupiter | `GET /swap/v1/quote` | Existing Phase 2 route API; current V2 migration remains separate |
| Raptor | `GET /quote` and quote-only `WSS /stream` | Hosted Raptor beta |
| Raydium | `GET /compute/swap-base-in` | Raydium-only Trade API route; no transaction POST |
| Orca | `swapQuoteByInputToken` from `@orca-so/whirlpools-core` | Official Orca API filters candidate Whirlpools; official client fetches pool/tick/oracle accounts |
| Meteora | `DLMM.createMultiple`, `getBinArrayForSwap`, `swapQuote` | Official Meteora Data API discovers DLMM pools; SDK reads current state |

Direct pool/tick/bin accounts discovered for Orca, Raydium, and Meteora are subscribed read-only. Updates invalidate only the affected state and wake the affected pair. Orca and Meteora calculate quotes using installed official local SDK/core math; Raydium continues to use the official Trade API compute endpoint until a pool-type-specific SDK executor is audited.

Orca and Meteora quote the best full-fill result among the configured top liquid candidates. Meteora requests partial-fill information; a quote whose `consumedInAmount` differs from the requested raw input is marked partial and excluded from direct comparison and arbitrage math.

## Execution modes

| Mode | Current behavior |
|---|---|
| `paper` | Real quotes, discovery, opportunity lifecycle, and deterministic paper accounting. No transaction. Default. |
| `dry-run` | Constructs, inspects, simulates, fingerprints, and locally signs supported routes; never broadcasts. |
| `live` | Continuously scans; supported positive routes are independently rebuilt and simulated, then wait for local manual approval before the exact bytes can be submitted. |

Audited execution coverage currently includes Orca→Orca and Raptor/Jupiter/Orca mixed two-leg cycles listed in `docs/execution-capability-matrix.md`. Raydium and Meteora remain discovery/quote-only for execution.

## Scanning modes

`DIRECT_DEX_ONLY=true` asks only Raydium, Orca, and Meteora. Otherwise, the scanner first evaluates and prints the direct matrix, then adds routes involving Jupiter/Raptor.

For every route, leg 2 receives the exact integer `outAmount` from leg 1. The scanner never independently compares two unrelated forward quotes.

Routes are labeled:

- `DIRECT_CROSS_DEX` — two distinct direct providers;
- `AGGREGATOR_ROUTE` — one aggregator and one direct venue;
- `AGGREGATOR_ARBITRAGE` — Jupiter versus Raptor.

Aggregator route labels are normalized to Raydium, Orca, and Meteora where possible. Shared venues are marked `OVERLAP`; missing route metadata is `UNKNOWN`, not assumed independent. Known overlap is rejected. Unknown overlap may remain a `QUOTE_CANDIDATE` but cannot be promoted to `CONSERVATIVE_CANDIDATE`.

The dashboard records real route evaluations even when they are negative or below threshold. Positive routes are independently re-quoted and become `CONFIRMED_QUOTE` only if the fresh exact round trip remains positive. There is no randomized execution or randomized PnL.

`CONFIRMED_QUOTE` is a market observation, not a completed paper fill. Confirmed-quote count and projected quote profit are stored separately from `completedTrades`, realized P&L, win rate, volume, and the paper reference balance. In the current detector-only build, realized execution metrics correctly remain zero.

Opportunity validation is deliberately tiered:

- `OBSERVATION` — a measured route that is negative, below threshold, stale, or overlapping.
- `QUOTE_CANDIDATE` — positive expected paper profit, but independence or conservative minimum output is not fully proven.
- `CONSERVATIVE_CANDIDATE` — fresh, confirmed non-overlapping liquidity whose minimum-output result remains positive after estimated costs.

Even a `CONSERVATIVE_CANDIDATE` is only a research signal. Quotes can move and this application never builds, signs, simulates, or sends a transaction.

`PROFIT_MODE=expected` uses expected output (`quote` remains a compatibility alias). `PROFIT_MODE=conservative` uses provider minimum output when available. Venue fees and price impact are already reflected in quoted output and are not subtracted again. The displayed slippage buffer and worst-case result remain visible in both modes. Only estimated network cost is separately subtracted.

Jupiter and Raptor are evaluated first as a fast lane. The highest-priority route is independently re-quoted before slower enrichment occupies provider queues. Every other positive route is still persisted, but only one route per size is confirmed to protect free quotas. Raydium, Orca, and Meteora then add direct-cross-DEX and mixed-provider coverage.

Stage 1 compares same-size first-leg outputs. Only provider directions exceeding `PREFILTER_SPREAD_BPS` are promoted to the Stage 2 exact round trip. This is a request-saving heuristic, not an opportunity result.

## Configuration

Copy `.env.example` and adjust provider flags. New direct providers default to disabled when variables are absent, so upgrading an existing `.env` does not unexpectedly increase RPC/API use.

Important controls:

| Variable | Purpose |
|---|---|
| `ENABLE_*` | Independently enable each provider |
| `SCAN_TOKENS` | Core connectivity tokens (`USDC,SOL,USDT`) |
| `DISCOVERY_MODE` | `core` or filtered dynamic `expanded` discovery |
| `DYNAMIC_DISCOVERY_*` | Refresh interval, bounded source/selection counts, and minimum liquidity/volume |
| `TOKEN_ALLOWLIST`, `TOKEN_DENYLIST` | Exact mint-address discovery overrides |
| `DIRECT_DEX_ONLY` | Skip all aggregator-involving routes |
| `POOL_CACHE_TTL_SECONDS` | Cache static pool metadata, not quote state |
| `POOL_STATE_CACHE_TTL_MS` | Briefly reuse one direct-pool state snapshot across same-scan amount comparisons; capped at 5 seconds |
| `*_MAX_POOLS_PER_PAIR` | Bound direct candidate RPC work |
| `QUOTE_CACHE_TTL_MS` | Coalesce identical near-simultaneous quote requests |
| `MAX_QUOTE_AGE_MS` | Reject legs too far apart in time |
| `SCAN_AMOUNTS_USDC` | USDC sizes rotated across scans (`TRADE_SIZES_USDC` remains an alias) |
| `TRADE_SIZES_PER_SCAN` | Rotate through this many configured sizes per scan; defaults to `1` for free-tier RPC safety |
| `PROFIT_MODE` | `expected` or `conservative` |
| `PREFILTER_SPREAD_BPS` | Cheap first-stage spread threshold before exact round trips |
| `ENABLE_RAPTOR_STREAM` | Use only Raptor `/stream` quotes as debounced market-change triggers |
| `SOLANA_RPC_URLS` | Optional ordered read-only RPC fallback list |
| `EXECUTION_RPC_URL`, `EXECUTION_WS_URL` | Dedicated fail-fast execution RPC/state stream; do not share public scanner capacity when targeting sub-second preparation |
| `EXECUTION_PRIORITY_FEE_*` | Bounded background landed-fee sample used by both the exact message and conservative P&L |
| `EXECUTION_SUBMISSION_TRANSPORT` | `rpc` (default) or explicit `jito`; neither retries an ambiguous submission |
| `MIN_NET_PROFIT_USDC`, `MIN_PROFIT_BPS` | Meaningful-opportunity thresholds |
| `PROVIDER_FAILURE_THRESHOLD`, `PROVIDER_COOLDOWN_MS` | Circuit-breaker controls |

Core mode rotates `USDC -> SOL -> USDC` and `USDC -> USDT -> USDC`. Expanded mode periodically reads official Jupiter market categories, filters candidates, validates each exact mint account and decimals over RPC, and promotes a bounded set to HOT/WARM/DISCOVERY scanning. A trending score is discovery priority—not execution approval. Token-2022 and uncertain authority/risk states stay visible as `UNKNOWN` or `FAIL`. Triangular and same-DEX cross-pool arbitrage remain disabled until two-leg cycles have enough live operational history.

`SCAN_INTERVAL_MS` is the polling fallback. A quote-only Raptor WebSocket update can wake the scanner earlier, subject to `MARKET_EVENT_DEBOUNCE_MS`, `EVENT_SCAN_MIN_INTERVAL_MS`, provider-local pacing, and a deduplicated pair queue.

## Install and run

```bash
npm install
npm run typecheck
npm test
npm run scan:once
npm run scan:live
npm start
npm run execution:jito-benchmark
```

Paper is the normal long-running mode:

```powershell
$env:EXECUTION_MODE='paper'
$env:LIVE_TRADING_ENABLED='false'
npm run dev
```

Readiness-only dry run:

```powershell
$env:EXECUTION_MODE='dry-run'
$env:LIVE_TRADING_ENABLED='false'
npm run dev
```

Continuous live operation remains locked unless all explicit guards are set.
The five-provider scanner keeps running when a scan has no eligible route or
the isolated Orca executor rejects a candidate. Submission remains bounded by
the matching transaction/session caps; use a deliberately chosen `N` from 1
through 100 rather than removing the cap:

```powershell
$env:EXECUTION_MODE='live'
$env:LIVE_TRADING_ENABLED='true'
$env:LIVE_CONTINUOUS_ENABLED='true'
$env:REAL_MONEY_READINESS='READY'
$env:LIVE_MAX_TRANSACTIONS='N'
$env:MAX_TRADES_PER_SESSION='N'
npm run execution:live
```

In live mode the paper ledger, paper P&L, paper balance, and paper confirmation
table are inactive. The public `BOT_WALLET_ADDRESS` balance is authoritative;
the scanner and live route-evaluation table remain active. Only audited Orca
two-pool atomic handoffs are execution eligible. The intermediate may be WSOL,
USDT, or a dynamically discovered mint, but only when two distinct USDC-paired
Whirlpools exist and every executor-side token, authority, quote, economics,
inspection, freshness, and simulation check passes. Jupiter, Raptor, Raydium,
Meteora, and unsupported Orca routes remain visible discovery data.

## Dedicated-wallet preparation on Windows

Use only the dedicated low-value bot wallet; never provide a primary Phantom
seed or recovery phrase. Current Solana documentation recommends using WSL for
the CLI on Windows:

1. From an elevated PowerShell terminal, install WSL if needed: `wsl --install -d Ubuntu`, then restart Windows if prompted.
2. In Ubuntu/WSL, install the official Solana/Agave toolchain using the command shown by the current official installation page. Re-open the shell and verify with `solana --version` and `solana-keygen --version`.
3. Create a directory outside the repository: `mkdir -p ~/.config/solana`.
4. Create a brand-new dedicated low-value keypair: `solana-keygen new --outfile ~/.config/solana/arb-bot-keypair.json`.
5. Protect it: `chmod 600 ~/.config/solana/arb-bot-keypair.json`. Never paste its recovery phrase or file into `.env`, VS Code chat, logs, or source control.
6. Print only its public address: `solana address -k ~/.config/solana/arb-bot-keypair.json`.
7. Select mainnet for CLI inspection: `solana config set --url mainnet-beta`; verify with `solana config get`.
8. Put only that public address in `.env` as `BOT_WALLET_ADDRESS=...`. `/api/wallet` can then read its live balances without the keypair.
9. Once a future audited readiness report says READY, send only the intended experiment funds from Phantom to this public address. Never import the Phantom seed into the bot.
10. Verify native balance with `solana balance <PUBLIC_ADDRESS> --url mainnet-beta` and verify SPL token accounts using the dashboard or a trusted explorer before enabling anything.

For dry-run/live execution, set `BOT_KEYPAIR_PATH` to the dedicated keypair
outside the project and set `BOT_WALLET_ADDRESS` to its public address. The
loader fails closed when they do not match and never logs secret bytes. Paper
mode and read-only wallet display use only `BOT_WALLET_ADDRESS` and do not load
the signer. `.gitignore` excludes `keys/`, `*.keypair.json`, and
`bot-keypair*.json` as defense in depth.

The current Orca client declares a `@solana/kit ^5` peer while this project uses Kit 6. The narrow account-fetch/client and core quote APIs compile and were exercised successfully without importing Orca's transaction-building high-level package. Meteora 1.9.14's published ESM build has a Node 22 named-export incompatibility with Anchor; the integration loads its published CommonJS entry and uses only its quote methods.

The current Jupiter documentation labels Swap V1 as superseded by Swap V2. This project deliberately retains the working Phase 2 V1 quote integration instead of forcing an unrelated migration; it uses only the quote endpoint. Moving to V2 should be treated as a separate, tested change.

## Additional direct-venue research

| Venue | Current finding | Recommendation |
|---|---|---|
| Phoenix Legacy spot | Official SDK can decode market/orderbook state, but the repository labels it Legacy and current direct spot liquidity is small relative to the primary AMMs | Not yet; reassess after a bounded orderbook-state prototype |
| OpenBook V2 | On-chain books are readable, but current SDK/indexer options are fragmented and the actively maintained community client is marked WIP | No current production integration |
| Lifinity | No sufficiently current, stable official read-only TypeScript quote surface was verified | No |
| Manifest / newer orderbooks | Appears in current Jupiter routes and may provide distinct orderbook liquidity | Best next research candidate, after direct account-subscription work |

Raptor and Jupiter already expose current routes through PancakeSwap, Phoenix/Manifest-style books, prop AMMs, and other venues. Those remain aggregator liquidity and are never mislabeled as direct independent providers.

## Documentation verified 2026-08-26

- Solana current client guidance: https://solana.com/docs/frontend/client
- Solana official Windows/WSL installation guidance: https://solana.com/docs/intro/installation
- Jupiter current API overview (V2 recommended): https://developers.jup.ag/docs/llms.txt
- Jupiter current token category API: https://developers.jup.ag/docs/api-reference/tokens/category
- Jupiter plans and rate limits: https://developers.jup.ag/docs/portal/plans
- Raptor HTTP quote: https://docs.solanatracker.io/raptor/http/get-swap-quote
- Raydium base-input compute quote: https://docs.raydium.io/api-reference/route-api-v2-endpoints/compute/compute-swap-quote-base-input
- Orca Whirlpool API: https://docs.orca.so/api-reference/whirlpools
- Orca official SDK repository: https://github.com/orca-so/whirlpools
- Meteora DLMM SDK reference: https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/reference
- Meteora pool Data API: https://docs.meteora.ag/api-reference/dlmm/pools/pools

Raptor's quote-only `/stream` is enabled as an optional event/cache source. The transaction-producing `/stream/swap` and every transaction endpoint are deliberately absent.
# Execution readiness (fail closed)

The production scanner defaults to `EXECUTION_MODE=paper`. It never needs a
signer in PAPER mode. A separate developer command loads and verifies the
dedicated keypair, constructs and inspects one complete Orca `two_hop_swap_v2`
transaction, simulates its unsigned serialized v0 form with `sigVerify=false`,
then locally signs the fingerprint-locked approved message and simulates it
again with `sigVerify=true`. Solana documents the unsigned mode for a transaction with a valid
blockhash that does not need a cryptographic signature. It does not call an
RPC send method.

```powershell
$env:EXECUTION_MODE='dry-run'
npm run execution:validate
```

The initial supported construction is intentionally narrow: USDC -> an
intermediate mint -> USDC through two distinct Orca Whirlpools in one atomic
instruction. Required token accounts must already exist. Native SOL wrapping,
ATA creation, transfer-fee tokens, transfer hooks, arbitrary programs, and
non-atomic legs are blocked. A quote is evidence, not guaranteed profit.

Dynamic-token selection uses canonical mint addresses from the live discovery
universe, never symbols. Only HOT/WARM classic SPL mints whose discovery
precheck passes are considered, capped by `ORCA_DYNAMIC_EXECUTION_MAX_TOKENS`.
The executor independently reads the mint and rejects Token-2022, active or
unknown mint authority, and active or unknown freeze authority. A token such as
ZOE or Pistacio is therefore recognized automatically only if its current mint
is discovered; it becomes execution eligible only if the required independent
Orca liquidity and every normal approval condition also exist.

`execution:validate` probes only `EXECUTION_VALIDATION_INTERMEDIATE_MINT`.
It does not fall through to several unrelated mints after a public-RPC 429.
For reliable simulation, configure a mainnet RPC endpoint with sufficient
account-read capacity in `SOLANA_RPC_URL`/`SOLANA_RPC_URLS`; the default public
endpoint can legitimately rate-limit validation without implying a bad route.

`execution:validate` first performs a no-compute-budget probe, derives the
final compute-unit limit from observed consumption (+15% and 5,000 units, under
a 1,400,000-unit cap), reconstructs the final transaction, and simulates that
complete transaction. It reports packet size, static accounts, ALT usage,
required signatures, logs, returned compute units, ATA/rent status, and a
post-simulation zero-balance-change check. The intermediate token is passed
directly from one Whirlpool vault to the other, so no wallet intermediate ATA
or WSOL wrapping is required for this particular atomic instruction.

The confirmation/accounting module is deliberately read-only and unconnected:
given a future transaction signature, it waits for confirmation, retrieves the
transaction, records its actual fee and pre/post wallet balances, calculates
realized base-token P&L, and flags intermediate dust. It has no transaction
construction or submission API.

## Dedicated wallet setup on Windows

Use WSL for the current official Solana CLI. Never enter a Phantom seed or
recovery phrase into this project.

1. In WSL, install the official toolchain:
   `curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash`
2. Restart the WSL shell and verify `solana --version`.
3. Create a directory outside this repository and a brand-new keypair:
   `mkdir -p ~/.config/sol-arb-bot && chmod 700 ~/.config/sol-arb-bot`
4. Generate it:
   `solana-keygen new --outfile ~/.config/sol-arb-bot/bot.json`
5. Protect it: `chmod 600 ~/.config/sol-arb-bot/bot.json`.
6. Print only its public address:
   `solana-keygen pubkey ~/.config/sol-arb-bot/bot.json`.
7. Configure/check mainnet:
   `solana config set --url https://api.mainnet.solana.com` then
   `solana config get`.
8. From Phantom, send only the intended low-value experiment funds to that
   public address: a small SOL fee reserve and USDC trading capital. Do not
   import either wallet's recovery phrase into the other.
9. Verify native SOL with
   `solana balance <PUBLIC_ADDRESS> --url https://api.mainnet.solana.com`.
10. Set `BOT_WALLET_ADDRESS` to the public address and `BOT_KEYPAIR_PATH` to a
    Windows-readable path for the external key file. Do not copy it into this
    repository.

Commands:

```powershell
# PAPER: real quotes, no signer, no transaction construction
$env:EXECUTION_MODE='paper'; $env:LIVE_TRADING_ENABLED='false'; npm run dev

# DRY RUN: builds/inspects/simulates, never broadcasts
$env:EXECUTION_MODE='dry-run'; $env:LIVE_TRADING_ENABLED='false'; npm run execution:validate

# LIVE: one current scan, at most one submission attempt, then automatic stop
$env:EXECUTION_MODE='live'; $env:LIVE_TRADING_ENABLED='true'; $env:REAL_MONEY_READINESS='READY'; $env:LIVE_MAX_TRANSACTIONS='1'; npm run execution:live
```

The live command never submits a developer-validation route. It submits only
an in-process `ApprovedSignedExecution` created from a genuine current scanner
candidate after independent reconstruction, conservative economics,
inspection, unsigned simulation, final revalidation, fingerprinted signing,
and signed simulation. Any ambiguous submission leaves a persistent unresolved
signature and is never retried.

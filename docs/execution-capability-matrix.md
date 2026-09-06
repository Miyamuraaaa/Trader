# Execution capability matrix

Audited against installed packages and current official provider documentation on 2026-08-29.

## Provider surfaces

| Provider | Quote | Raw instructions | ALT/setup behavior | Atomic composition | Implemented executor coverage |
|---|---:|---:|---|---:|---|
| Jupiter | Yes | Yes: Swap V1 `swap-instructions`; this project validates Swap V2 `build` instruction fields | V0, setup/other/cleanup instructions, independently resolved ALTs | Yes when the complete route fits one v0 packet | First or second leg with Raptor or direct Orca; Whirlpool-only CPI surface; classic SPL mints |
| Raptor | Yes | Yes: `POST /swap-instructions` | Legacy/V0, setup/cleanup, ALT addresses | Yes for reviewed direct routes that fit one v0 packet | First or second leg with Jupiter or direct Orca; Raydium CLMM/PancakeSwap-only CPI surface; classic SPL mints |
| Raydium | Yes | Trade API returns serialized transaction wrapper(s), not a stable raw-instruction composition response | V0/legacy; setup may be multiple transactions | Not from the installed Trade API integration; needs a pool-type-specific SDK adapter | Discovery/quote only |
| Orca | Yes | Yes: installed generated client exposes `swap_v2` and `two_hop_swap_v2` | Raw instruction; local v0 composer | Yes | Distinct-pool atomic `two_hop_swap_v2` cycle |
| Meteora | Yes | Installed DLMM SDK builds a Web3.js `Transaction`; instructions can technically be extracted | Builder owns ATA/WSOL/Token-2022 setup details | Feasible only after setup/cleanup reconciliation and protocol inspection | Discovery/quote only |

Installed versions: `@orca-so/whirlpools-client 7.0.0`, `@orca-so/whirlpools-core 3.1.1`, `@meteora-ag/dlmm 1.9.14`, `@solana/kit 6.9.0`, and `@solana/web3.js 1.98.4`. No Raydium SDK is installed; the scanner uses the official Trade API compute endpoint.

## Route-class matrix

`SUPPORTED` means the executor independently requotes, reconstructs, resolves ALTs, inspects, unsigned-simulates, revalidates, fingerprints, signs locally, and signed-simulates. It does not imply a current candidate is profitable.

| Route class | Raw instruction source | Exact intermediate rule | Setup/cleanup | Atomic status | Implementation |
|---|---|---|---|---|---|
| Orca -> Orca | Generated `two_hop_swap_v2` | Program-native vault-to-vault transfer | Existing ATAs; explicit WSOL policy | Native atomic two-hop | **SUPPORTED** |
| Raptor -> Jupiter | Both providers return reviewed bundles | Jupiter consumes Raptor's enforceable `minAmountOut`; surplus is dust | Idempotent ATA setup deduped; missing non-WSOL ATA rent charged; transient WSOL ATA may close to same wallet | One v0 transaction if size/compute passes | **SUPPORTED** for allowlisted CPI programs and classic SPL intermediates |
| Jupiter -> Raptor | Both providers return reviewed bundles | Raptor consumes Jupiter's enforceable `otherAmountThreshold`; surplus is dust | Same policy; first-leg cleanup rejected | One v0 transaction if size/compute passes | **SUPPORTED** for allowlisted CPI programs and classic SPL intermediates |
| Jupiter -> Orca | Jupiter bundle plus raw Orca `swap_v2` | Orca consumes Jupiter's enforceable minimum | Reviewed ATA lifecycle; independently resolved Jupiter ALTs | One v0 transaction if size/compute passes | **SUPPORTED** for classic SPL intermediates |
| Orca -> Jupiter | Raw Orca `swap_v2` plus Jupiter bundle | Jupiter consumes Orca's enforceable minimum | Reviewed ATA lifecycle; independently resolved Jupiter ALTs | One v0 transaction if size/compute passes | **SUPPORTED** for classic SPL intermediates |
| Raptor -> Orca | Raptor bundle plus raw Orca `swap_v2` | Orca consumes Raptor's enforceable minimum | Reviewed ATA lifecycle; independently resolved Raptor ALTs | One v0 transaction if size/compute passes | **SUPPORTED** for classic SPL intermediates |
| Orca -> Raptor | Raw Orca `swap_v2` plus Raptor bundle | Raptor consumes Orca's enforceable minimum | Reviewed ATA lifecycle; independently resolved Raptor ALTs | One v0 transaction if size/compute passes | **SUPPORTED** for classic SPL intermediates |
| Meteora <-> Jupiter/Raptor/Orca | Meteora transaction instructions plus other raw bundle | Must prove DLMM quote/bin state and threshold semantics | Meteora setup/cleanup must be separated and inspected | Feasible subset; account/compute heavy | Not implemented |
| Raydium <-> any venue | Trade API serialized wrapper(s) | Cannot safely splice the current wrapper | API may return multiple transactions | Not generally atomic via current integration | Not implemented; needs pool-type SDK |
| Three-swap cycles | Depends on every leg | Each next leg needs enforceable predecessor threshold or safe runtime balance | Global lifecycle reconciliation required | Route-dependent; packet/compute often bind | Not implemented |

## Runtime safety boundaries

- The scanner stays broad. Unsupported routes remain visible and are never relabeled executable.
- Handoffs contain identifiers and diagnostic scanner economics only—never instructions or signer material.
- Composed aggregator routes use one direct Raptor hop and a Whirlpool-only Jupiter surface. Executable accounts are resolved from chain state and compared with an explicit CPI allowlist.
- Classic SPL dynamic intermediates use canonical mint identity. Active/unknown mint or freeze authority fails closed. Token-2022 stays discovery-only until modeled end-to-end.
- A missing intermediate ATA must be created by a reviewed idempotent ATA instruction. Its rent is charged unless it is transient WSOL closed atomically to the wallet.
- First-leg cleanup is rejected because it could destroy the intermediate account.
- ALTs are fetched from chain, owner-checked, deserialized, and Jupiter address evidence is checked against resolved contents.
- The complete v0 message must fit Solana's packet limit. Developer validators run both unsigned and `sigVerify=true` simulations. The live hot path runs one execution-critical unsigned simulation, then verifies the exact message fingerprint and Ed25519 signature locally before submission approval.
- Gemini-added generic Raydium/Meteora builders are not reachable from the live validator: Raydium spliced an API-owned serialized wrapper, and Meteora setup/cleanup was not decoded deeply enough for the strict inspector.
- Execution mint/ATA policy is batch-preloaded outside the hot path. Orca pool/tick/oracle state is kept warm through the dedicated execution WebSocket and rebuilt coherently after targeted invalidation.
- The priority-fee price is sampled from recent landed fees in the background, bounded by configuration, embedded in the inspected Compute Budget instruction, and charged by the same conservative economics calculation.
- `EXECUTION_SUBMISSION_TRANSPORT=jito` uses Jito's official single-transaction endpoint for the exact approved bytes. It is non-default, has no retry/fallback after ambiguity, and does not replace local simulation or inspection. `npm run execution:jito-benchmark` performs only the read-only `getTipAccounts` probe.

## Official sources

- [Jupiter swap instructions](https://developers.jup.ag/docs/api-reference/swap/v1/swap-instructions)
- [Jupiter Swap V2 build](https://developers.jup.ag/docs/api-reference/swap/build)
- [Raptor swap instructions](https://docs.solanatracker.io/raptor/http/build-swap-instructions)
- [Raptor overview](https://docs.solanatracker.io/raptor/overview)
- [Raydium Trade API](https://docs.raydium.io/tr/api-reference/route-api-v2/overview)
- [Orca Whirlpools SDK](https://dev.orca.so/ts/modules/_orca-so_whirlpools.html)
- [Meteora DLMM SDK](https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk)
- [Solana transactions](https://solana.com/docs/core/transactions)

# Dependency security audit — execution path

Audit date: 2026-08-29. Versions come from the installed lock tree and the
advisory identifiers from `npm audit`. This is an execution-path assessment,
not a claim that an advisory is harmless merely because it is transitive.

| Package / installed version | Advisory / dependency path | Direct? | Execution-path reachability | Security effect | Patch status / recommendation | Classification |
|---|---|---:|---|---|---|---|
| `bigint-buffer@1.1.5` | `CVE-2025-3194` / `GHSA-3gc7-fjrx-p6mg`; `@meteora-ag/dlmm -> @solana/spl-token -> @solana/buffer-layout-utils -> bigint-buffer` | No | Not imported by the isolated live-execution child, handoff validator, broadcaster, signer, transaction builder, or confirmation path. It remains in the separate scanner process/dependency graph under Meteora. | Native `toBigIntLE()` overflow can affect scanner availability if the native binding is present. It has no signer or submission reachability in this architecture. | No patched upstream release. Keep Meteora discovery outside the isolated executor process and retain the architecture import test. | **NOT REACHABLE in executor; scanner risk remains** |
| `@solana/buffer-layout-utils@0.3.0` | Inherits `bigint-buffer`; scanner path above | No | Not imported by execution code; reached only through the Meteora scanner dependency tree. | Scanner parsing/availability surface. | No independent fix; retain process/entry-point isolation. | **NOT REACHABLE in executor** |
| `@solana/spl-token@0.4.15` | Audit aggregate for vulnerable `buffer-layout-utils`, Web3, token group/metadata dependencies | No | Root execution code removed this import. Mint and ATA validation use RPC `jsonParsed`; Token-2022 remains fail-closed. The package exists only transitively below Meteora in the scanner process. | Scanner dependency surface; no signer or broadcaster path. | Do not force an incompatible upgrade. Keep it outside the isolated executor process. | **NOT REACHABLE in executor** |
| `@meteora-ag/dlmm@1.9.14` | Audit aggregate: Anchor, SPL Token, Web3 | Yes | Not imported by the isolated live executor graph; it remains in the scanner process for quote discovery. The Gemini-added Meteora execution prototype is quarantined and absent from the live capability map. | No separate code-execution advisory identified; inherits the listed dependency exposure. | Keep quote-only isolated from the signer process, or upgrade when Meteora publishes an audited dependency update. | RELEVANT BUT MITIGATED for scanner; **not approved** in executor |
| `@coral-xyz/anchor@0.31.0` | Audit aggregate via `@coral-xyz/borsh` / Web3 | No | Not imported by the Orca dry-run path; reached by Meteora SDK. | Serialization/RPC dependency surface, no direct signing path in this app. | No safe patch surfaced by audit; remove from execution process through process isolation. | NOT REACHABLE in `execution:validate` |
| `@coral-xyz/borsh@0.31.0` | Audit aggregate via Web3 | No | Same as Anchor/Meteora. | Serialization surface only through Meteora path. | No available non-breaking fix. | NOT REACHABLE in `execution:validate` |
| `@solana/spl-token-group@0.0.7` | Audit aggregate via Web3 | No | Loaded transitively by SPL Token but no group APIs are called by execution code. | No known direct signer/key handling. | Remove with a future token-client migration. | RELEVANT BUT MITIGATED |
| `@solana/spl-token-metadata@0.1.6` | Audit aggregate via Web3 | No | Loaded transitively; execution code does not use metadata APIs. | No known direct signer/key handling. | Remove with a future token-client migration. | RELEVANT BUT MITIGATED |
| `@solana/web3.js@1.98.4` | `jayson@4.3.0 -> uuid@8.3.2`, `GHSA-w5hq-g745-h8pq` / `CVE-2026-41907` | Yes | Reached for the already-simulated Orca/Web3 transaction adapter, RPC, confirmation, and the one-shot submit transport. Installed `jayson/lib/generateRequest.js` imports only `require('uuid').v4` and calls it with no arguments. | The child advisory affects UUID v3/v5/v6 only when a caller supplies an undersized buffer or invalid offset. No RPC, transaction, token, signer, or on-chain input reaches those APIs. | A Kit-native rewrite would replace the runtime-proven transaction adapter. Forcing uuid >=11.1.1 below CommonJS Jayson is also an unreviewed major override. Retain the tested stack for this one-shot executor and migrate separately. | **MITIGATED / NOT REACHABLE advisory path** |
| `jayson@4.3.0` | `uuid` advisory; `@solana/web3.js -> jayson -> uuid@8.3.2` | No | Reached for JSON-RPC request generation. Its installed request generator calls only `uuid.v4()` with no buffer or offset. | JSON-RPC request IDs only; affected UUID functions are not invoked. | Keep RPC URLs trusted/HTTPS and retain the source reachability audit. | **MITIGATED / NOT REACHABLE advisory path** |
| `uuid@8.3.2` | `GHSA-w5hq-g745-h8pq`; bounds validation missing in v3/v5/v6 external-buffer modes | No | Jayson invokes v4 without arguments. Application code does not import UUID. | No signing, key handling, transaction bytes, or RPC response data reaches v3/v5/v6. | Patched at >=11.1.1. Do not force the transitive major beneath Jayson without a compatibility review. | **NOT REACHABLE** |

## Conclusion

`npm audit` currently reports 11 advisories (4 high, 7 moderate). The
`bigint-buffer` / legacy SPL-token remains a scanner-only transitive chain and
is excluded from the one-shot execution entry point. The only advisory beneath
an executor-reachable package is UUID's v3/v5/v6 external-buffer issue; the
installed Jayson source calls only v4 without arguments, so the vulnerable API
is not reachable. No automatic `npm audit fix --force` is appropriate because
it would install or override incompatible Solana packages.

Sources:

- GitHub advisory for `bigint-buffer`: https://github.com/advisories/GHSA-3gc7-fjrx-p6mg
- GitHub advisory for `uuid`: https://github.com/advisories/GHSA-w5hq-g745-h8pq
- Solana `sendTransaction` semantics: https://solana.com/docs/rpc/http/sendtransaction
- Solana confirmation guidance: https://solana.com/developers/cookbook/transactions/confirmation
- Solana `simulateTransaction` semantics: https://solana.com/docs/rpc/http/simulatetransaction
- Orca SDK overview: https://docs.orca.so/developers/sdks/overview

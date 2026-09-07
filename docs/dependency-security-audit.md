# Dependency security review — 2026-09-07

Base: `85f9fc0`; installed Node 22.23.2 tree on Windows. This supersedes the
2026-08-29 document. Full `npm audit --json` initially reported **16 affected
packages: 6 high, 10 moderate**. After the reviewed `qs@6.16.0` override it reports
**13 affected packages: 6 high, 7 moderate**. Aggregate package counts are not
distinct advisory counts. Install console summaries disagreed with full audit
responses; the saved JSON is authoritative.

No Solana SDK changed; no `audit fix --force`. The qs minor-version override
explicitly exceeds Meteora's bundled Express 4 `~6.15.1` range. Root Express 5
already permits it. The review and tests cover this compatibility decision,
rather than silently overriding a Solana serialization dependency.

## Installed paths and reachability

D = direct dependency; all other rows are transitive. These are production
dependencies, not development-only. Classification refers to vulnerable
functionality, not just package load.

| Package/version/severity | Dependency path | Reachability and mitigation | Safe upgrade / breaking risk |
|---|---|---|---|
| @meteora-ag/dlmm 1.9.14 D, high | Project → DLMM → Anchor/SPL/Web3 | Scanner only; executor recursive import graph excludes it. RELEVANT BUT MITIGATED for signer isolation, unresolved native scanner parsing exposure. | No reviewed SDK migration; keep execution prototype quarantined. |
| @coral-xyz/anchor 0.31.0, high | DLMM → Anchor → toml/Borsh/Web3 | Scanner loaded; executor absent. Workspace TOML getter is not used by scanner's program construction. NOT REACHABLE parser APIs under current code. | No non-breaking patch advertised by audit; major TOML override needs review. |
| @coral-xyz/borsh 0.31.0, moderate | DLMM → Borsh → Web3 | Scanner only; inherits Web3 findings, no separate Borsh issue. NOT REACHABLE affected APIs. | Avoid unreviewed serialization migration. |
| @solana/spl-token 0.4.15, high | DLMM → SPL → utils/group/metadata/Web3 | Scanner parsing; not executor, which uses RPC mint parsing and blocks Token-2022. RELEVANT BUT MITIGATED for executor isolation, not scanner immunity. | No patched bigint-buffer release; SDK dependency replacement needs review. |
| @solana/buffer-layout-utils 0.3.0, high | SPL → utils → bigint-buffer | Scanner bigint layouts call toBigIntLE on decoded buffers; executor absent. RELEVANT BUT MITIGATED for executor only. | Requires reviewed upstream replacement; audit's fixAvailable does not establish a safe execution upgrade. |
| bigint-buffer 1.1.5, high | utils → bigint-buffer | Native buffer overflow/availability exposure in scanner depending on binding/layout. NOT REACHABLE in executor; scanner risk remains. | No patched release; do not infer safety from one machine's JS fallback. |
| @solana/spl-token-group 0.0.7, moderate | SPL → group → Web3 | Scanner transitive load, no executor import. Inherited Web3 findings; NOT REACHABLE affected APIs. | Future SDK migration must preserve account encoding. |
| @solana/spl-token-metadata 0.1.6, moderate | SPL → metadata → Web3 | Scanner transitive load; executor absent. Inherited Web3 findings; NOT REACHABLE affected APIs. | Same dependency migration requirement. |
| @solana/web3.js 1.98.4 D, moderate | Project → Web3 → Jayson | Both processes use RPC/transactions. Installed CJS imports Jayson browser client, not server/stream utilities. MITIGATED / NOT REACHABLE advisory paths below. | Retain tested adapter; Kit rewrite or Web3 major upgrade is separate compatibility work. |
| jayson 4.3.0, moderate | Web3 → Jayson → uuid/stream-json | Browser client and request generator use uuid.v4() with no arguments and JSON.parse for replies. No stream-json filter imports. NOT REACHABLE vulnerable methods. | No non-breaking aggregate patch advertised; source-shape regression tests added. |
| uuid 8.3.2, moderate | Jayson → uuid | Only v4() without external buffers/offsets is called. v3/v5/v6 are not used; no signer/token/RPC response input reaches them. NOT REACHABLE. | Patched >=11.1.1; unreviewed major override under Jayson avoided. rpc-websockets' separate uuid14.0.2 unaffected. |
| stream-json 1.9.1, moderate | Jayson → stream-json | Vulnerable pick/ignore/filter/replace APIs absent from Web3 browser-client path. NOT REACHABLE. | Nested-filter quadratic DoS; full audit reports no patched version. |
| toml 3.0.0, high | Anchor → toml | Scanner package loaded, but no provider data enters local Anchor.workspace TOML parser. Executor absent. NOT REACHABLE parser path. | Recursion fixed4.2.0; prototype pollution fixed4.1.2; Anchor requires3.x, major override not assumed safe. |

## Advisory identities and removed exposure

- bigint-buffer: GHSA-3gc7-fjrx-p6mg / CVE-2025-3194, native toBigIntLE overflow.
- UUID: GHSA-w5hq-g745-h8pq / CVE-2026-41907, v3/v5/v6 caller-buffer bounds.
- stream-json: GHSA-528h-pc64-c93x / CVE-2026-71429, nested filter CPU DoS.
- TOML: GHSA-82x6-q7mm-w9cf / CVE-2026-77465, recursion; and
  GHSA-v5mp-jgw5-2x6j / CVE-2026-63376, prototype pollution.
- Removed qs6.15.3: GHSA-x5fp-wj9c-mxmx / CVE-2026-82562 (bracket/comma
  array-limit bypass) and GHSA-4mjr-xmp4-gh2g / CVE-2026-82417 (attacker-provided
  isBuffer object DoS). Installed qs6.16.0 covers both. The affected qs entry and
  inherited DLMM Express4.22.2/body-parser1.20.6 entries disappeared. Dashboard
  uses Express JSON input, not arbitrary-object qs parsing or comma mode, but
  patching avoids relying solely on that. No executor imports Express/qs.

## Evidence and CI gate

Inspected Web3 `lib/index.cjs.js`, Jayson browser client and
`generateRequest.js`, Jayson stream utilities, Anchor `workspace.js`, and
buffer-layout-utils `bigint.js`. Recursive TypeScript runtime-import tests
start at the isolated child, erase type-only imports, reject unreviewed computed
imports and prohibit scanner SDKs/quarantined builders. Separate tests pin
the reviewed Jayson call shape.

Linux and Windows CI run `npm run audit:review`, upload full JSON, and fail
on unavailable audit data, new/unreviewed advisory IDs or affected package versions, critical severity, or
review expiry (2026-10-08). This is a reviewed-exposure gate, NOT a clean audit.
Artifacts are ignored locally, not committed. No application environment file
or signer is needed.

Scanner native dependency risk remains unresolved. Isolation protects execution
authority but does not guarantee scanner availability or a vulnerability-free
application. No new live provider execution is authorized by this review.

## Primary sources

- [bigint-buffer](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)
- [UUID](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
- [stream-json](https://github.com/advisories/GHSA-528h-pc64-c93x)
- [TOML recursion](https://github.com/advisories/GHSA-82x6-q7mm-w9cf)
- [TOML prototype pollution](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j)
- [qs array limit](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)
- [qs isBuffer](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)

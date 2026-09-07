import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

// Run only via npm; no dotenv, application imports, signer, or submission path.
if (!process.env.npm_execpath) throw new Error('Use npm run audit:review');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--json'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 });
let audit;
try { audit = JSON.parse(result.stdout); } catch { throw new Error('Dependency audit unavailable; no clean result can be inferred'); }
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/dependency-audit.json', JSON.stringify(audit, null, 2), { mode: 0o600 });
if (result.error || audit.error || !audit.metadata?.vulnerabilities || !audit.vulnerabilities) throw new Error('Dependency audit failed; inspect artifact');
// These are reviewed exposures, NOT a claim of zero vulnerabilities. Review expires.
if (Date.now() > Date.parse('2026-10-08T00:00:00Z')) throw new Error('Dependency reachability review expired; refresh documentation and baseline');
const reviewed = new Set(['GHSA-3gc7-fjrx-p6mg', 'GHSA-w5hq-g745-h8pq', 'GHSA-528h-pc64-c93x', 'GHSA-82x6-q7mm-w9cf', 'GHSA-v5mp-jgw5-2x6j']);
const unknown = new Set();
const versions = { '@meteora-ag/dlmm': '1.9.14', '@coral-xyz/anchor': '0.31.0', '@coral-xyz/borsh': '0.31.0',
  '@solana/spl-token': '0.4.15', '@solana/buffer-layout-utils': '0.3.0', '@solana/spl-token-group': '0.0.7',
  '@solana/spl-token-metadata': '0.1.6', '@solana/web3.js': '1.98.4', 'bigint-buffer': '1.1.5',
  jayson: '4.3.0', uuid: '8.3.2', 'stream-json': '1.9.1', toml: '3.0.0' };
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const value of Object.values(audit.vulnerabilities)) {
  for (const node of value.nodes) if (lock.packages[node]?.version !== versions[value.name]) unknown.add(`version-review:${value.name}`);
  if (value.severity === 'critical') unknown.add(`critical:${value.name}`);
  for (const advisory of value.via) if (typeof advisory !== 'string') {
    const id = advisory.url.split('/').at(-1);
    if (!reviewed.has(id)) unknown.add(id);
  }
}
console.log(JSON.stringify(audit.metadata.vulnerabilities));
if (unknown.size) throw new Error(`Unreviewed advisories: ${[...unknown].join(', ')}`);
console.log('Known exposures remain documented; architecture reachability tests are mandatory. This is not a clean audit.');

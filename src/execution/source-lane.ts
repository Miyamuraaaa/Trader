import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EXECUTABLE_POLICY_HASH } from './executable-route-policy.js';

export const SOURCE_LANES = ['BROAD_MATRIX', 'EXECUTABLE_FAST_LANE', 'UNRESTRICTED_CONTROL', 'PAIR_REFRESH', 'ORCA_CROSS_POOL', 'ABOVE_CAP_SHADOW'] as const;
export type SourceLane = typeof SOURCE_LANES[number];
export const LEGACY_COHORT_WARNING = 'LEGACY_RAW_POSITIVE_COHORT_CONTAINS_UNPROVEN_FAST_LANE_ATTEMPTS';
function checkoutCommit(): string | null {
  try {
    const head = readFileSync(new URL('../../.git/HEAD', import.meta.url), 'utf8').trim();
    if (/^[a-f0-9]{40}$/.test(head)) return head;
    if (!/^ref: refs\/heads\/[a-zA-Z0-9_\-/]+$/.test(head)) return null;
    const ref = head.slice(5);
    try { const value=readFileSync(new URL(`../../.git/${ref}`,import.meta.url),'utf8').trim();return /^[a-f0-9]{40}$/.test(value)?value:null; }
    catch { const line=readFileSync(new URL('../../.git/packed-refs',import.meta.url),'utf8').split('\n').find(line=>line.endsWith(` ${ref}`));return line&&/^[a-f0-9]{40} /.test(line)?line.slice(0,40):null; }
  } catch { return null; }
}
export const telemetryRun = Object.freeze({ telemetrySchemaVersion: 2 as const, runId: randomUUID(), startedAt: Date.now(), executablePolicyHash: EXECUTABLE_POLICY_HASH,
  buildCommit: checkoutCommit(), buildIdentitySource: 'checkout HEAD; not a dirty-worktree integrity attestation' });

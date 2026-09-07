import { mkdtemp, rm, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAtomicJson, updateAtomicJson } from '../src/persistence/atomic-json-file.js';
import { PersistentRiskManager } from '../src/execution/risk-manager.js';
import { PersistentExecutionJournal } from '../src/execution/execution-journal.js';
import { OrcaHandoffInbox } from '../src/execution/handoff-inbox.js';
import { AggregatorHandoffInbox } from '../src/execution/aggregator-handoff-inbox.js';
import { parseOrcaAtomicHandoff } from '../src/execution/handoff-dto.js';
import { parseAggregatorAtomicHandoff } from '../src/execution/aggregator-handoff-dto.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const dirs: string[] = [];
afterEach(async () => { vi.mocked(rename).mockReset(); const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'); vi.mocked(rename).mockImplementation(actual.rename); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const dir = await mkdtemp(path.join(os.tmpdir(), 'trader-persistence-test-')); dirs.push(dir); return { dir, file: path.join(dir, 'state.json') }; }
const lock = (code: string) => Object.assign(new Error(`TEST DATA ${code}`), { code });
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sol = 'So11111111111111111111111111111111111111112';
const observation = { expectedOutputAmount: '1', minimumOutputAmount: '1', projectedNetAmount: '-1', roiBps: '-1', quoteTimestamp: 1 };

describe('TEST DATA: Windows atomic persistence', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries transient %s and leaves a valid replacement without temporary files', async (code) => {
    const f = await fixture(); await writeAtomicJson(f.file, { generation: 0 });
    vi.mocked(rename).mockRejectedValueOnce(lock(code)); await writeAtomicJson(f.file, { generation: 1 });
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual({ generation: 1 }); expect(await readdir(f.dir)).toEqual(['state.json']);
  });
  it('permanent replacement failure preserves destination and cleans its own temporary', async () => {
    const f = await fixture(); await writeAtomicJson(f.file, { unresolved: ['SUBMITTING'] });
    vi.mocked(rename).mockRejectedValue(lock('EPERM'));
    await expect(writeAtomicJson(f.file, { unresolved: [] })).rejects.toThrow('EPERM');
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual({ unresolved: ['SUBMITTING'] }); expect(await readdir(f.dir)).toEqual(['state.json']);
  });
  it('never retries a non-transient error', async () => {
    const f = await fixture(); vi.mocked(rename).mockRejectedValueOnce(lock('ENOSPC'));
    await expect(writeAtomicJson(f.file, {})).rejects.toThrow('ENOSPC'); expect(rename).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent updates including reads and preserves newest document', async () => {
    const f = await fixture(); await writeAtomicJson(f.file, { count: 0 });
    await Promise.all(Array.from({ length: 20 }, () => updateAtomicJson(f.file, async () => ({ count: JSON.parse(await readFile(f.file, 'utf8')).count + 1 }))));
    expect(JSON.parse(await readFile(f.file, 'utf8')).count).toBe(20);
    await Promise.all([writeAtomicJson(f.file, { version: 1 }), writeAtomicJson(f.file, { version: 2 })]);
    expect(JSON.parse(await readFile(f.file, 'utf8')).version).toBe(2);
  });
  it.each(['risk', 'journal', 'orca', 'aggregator'])('%s uses the shared transient-lock recovery', async (kind) => {
    const f = await fixture(); vi.mocked(rename).mockRejectedValueOnce(lock('EPERM'));
    if (kind === 'risk') await new PersistentRiskManager({ maxTrades: 1, maxConsecutiveFailures: 1, maxSessionLossAtomic: 1n }, f.file).load();
    if (kind === 'journal') await new PersistentExecutionJournal(f.file).begin('TEST DATA');
    if (kind === 'orca') await new OrcaHandoffInbox(f.file).publish([parseOrcaAtomicHandoff({ schema: 'sol-arb.execution-handoff', version: 1, opportunityId: 'TEST DATA', detectedAt: 1, opportunityType: 'ORCA_TWO_HOP_ATOMIC', venue: 'orca', inputMint: usdc, intermediateMint: sol, outputMint: usdc, pools: [usdc, sol], proposedInputAmount: '1', scannerObservation: { ...observation, stateSlots: [] }, discovery: { source: 'TEST DATA', metadata: {} } })]);
    if (kind === 'aggregator') await new AggregatorHandoffInbox(f.file).publish(parseAggregatorAtomicHandoff({ schema: 'sol-arb.aggregator-execution-handoff', version: 1, opportunityId: 'TEST DATA', detectedAt: 1, opportunityType: 'JUPITER_RAPTOR_ATOMIC', providers: ['jupiter', 'raptor'], inputMint: usdc, intermediateMint: sol, outputMint: usdc, proposedInputAmount: '1', scannerPools: [[usdc], [sol]], scannerObservation: observation }));
    expect(rename).toHaveBeenCalledTimes(2); expect(await readdir(f.dir)).toEqual(['state.json']);
  });
  it('journal/risk fail closed after permanent persistence failure', async () => {
    const f = await fixture(); const journal = new PersistentExecutionJournal(f.file); await journal.begin('TEST DATA');
    vi.mocked(rename).mockRejectedValue(lock('ENOSPC'));
    await expect(journal.transition('TEST DATA', 'VALIDATING')).rejects.toThrow();
    expect(() => journal.get('TEST DATA')).toThrow('persistence failed');
    const resumed = new PersistentExecutionJournal(f.file); await resumed.load();
    expect(resumed.unresolved()[0]?.state).toBe('DETECTED');
    const risk = new PersistentRiskManager({ maxTrades: 1, maxConsecutiveFailures: 1, maxSessionLossAtomic: 1n }, path.join(f.dir, 'risk.json'));
    await expect(risk.load()).rejects.toThrow(); expect(() => risk.assertCanExecute('TEST DATA')).toThrow('persistence failed');
  });
});

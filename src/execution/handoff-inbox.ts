import { readFile } from 'node:fs/promises';
import { updateAtomicJson } from '../persistence/atomic-json-file.js';
import path from 'node:path';
import { parseOrcaAtomicHandoff, type OrcaAtomicHandoff } from './handoff-dto.js';

interface InboxFile { version: 1; updatedAt: number; candidates: OrcaAtomicHandoff[]; }

const MAX_QUEUED_CANDIDATES = 8;

/** Public scanner-to-executor inbox. It intentionally contains no transaction or secret. */
export class OrcaHandoffInbox {
  constructor(private readonly filePath = path.resolve('data/orca-handoff-candidates.json')) {}

  async publish(candidates: OrcaAtomicHandoff[]): Promise<void> {
    const verified = candidates.map(parseOrcaAtomicHandoff).slice(0, 20);
    await updateAtomicJson(this.filePath, async () => {
      const existing = await this.recent(MAX_QUEUED_CANDIDATES);
      const deduped = new Map<string, OrcaAtomicHandoff>();
      for (const candidate of [...verified, ...existing]) {
        const key = `${candidate.pools[0]}:${candidate.pools[1]}:${candidate.proposedInputAmount}:${candidate.detectedAt}`;
        if (!deduped.has(key)) deduped.set(key, candidate);
      }
      const queued = [...deduped.values()].sort((a, b) => b.detectedAt - a.detectedAt).slice(0, MAX_QUEUED_CANDIDATES);
      return { version: 1, updatedAt: Date.now(), candidates: queued } satisfies InboxFile;
    });
  }

  async latest(): Promise<OrcaAtomicHandoff | undefined> {
    return (await this.recent(1))[0];
  }

  async recent(limit = MAX_QUEUED_CANDIDATES): Promise<OrcaAtomicHandoff[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<InboxFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.candidates)) throw new Error('Malformed Orca handoff inbox');
      return parsed.candidates.map(parseOrcaAtomicHandoff)
        .sort((a, b) => b.detectedAt - a.detectedAt)
        .slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

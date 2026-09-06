import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseOrcaAtomicHandoff, type OrcaAtomicHandoff } from './handoff-dto.js';

interface InboxFile { version: 1; updatedAt: number; candidates: OrcaAtomicHandoff[]; }

const MAX_QUEUED_CANDIDATES = 8;
let publishChain: Promise<void> = Promise.resolve();

/** Public scanner-to-executor inbox. It intentionally contains no transaction or secret. */
export class OrcaHandoffInbox {
  constructor(private readonly filePath = path.resolve('data/orca-handoff-candidates.json')) {}

  async publish(candidates: OrcaAtomicHandoff[]): Promise<void> {
    const verified = candidates.map(parseOrcaAtomicHandoff).slice(0, 20);
    const write = async (): Promise<void> => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const existing = await this.recent(MAX_QUEUED_CANDIDATES).catch(() => []);
      const deduped = new Map<string, OrcaAtomicHandoff>();
      for (const candidate of [...verified, ...existing]) {
        const key = `${candidate.pools[0]}:${candidate.pools[1]}:${candidate.proposedInputAmount}:${candidate.detectedAt}`;
        if (!deduped.has(key)) deduped.set(key, candidate);
      }
      const queued = [...deduped.values()].sort((a, b) => b.detectedAt - a.detectedAt).slice(0, MAX_QUEUED_CANDIDATES);
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, updatedAt: Date.now(), candidates: queued } satisfies InboxFile), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    };
    publishChain = publishChain.catch(() => undefined).then(write);
    await publishChain;
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

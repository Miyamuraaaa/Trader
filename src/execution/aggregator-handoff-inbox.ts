import { readFile } from 'node:fs/promises';
import { updateAtomicJson } from '../persistence/atomic-json-file.js';
import path from 'node:path';
import {
  parseAggregatorAtomicHandoff,
  type AggregatorAtomicHandoff,
} from './aggregator-handoff-dto.js';

interface InboxFile { version: 1; updatedAt: number; candidates: AggregatorAtomicHandoff[]; }

const MAX_QUEUED_CANDIDATES = 8;

export class AggregatorHandoffInbox {
  constructor(private readonly filePath = path.resolve('data/aggregator-handoff-candidates.json')) {}

  async publish(candidate: AggregatorAtomicHandoff): Promise<void> {
    const verified = parseAggregatorAtomicHandoff(candidate);
    // Scanner cycles can finish together. Serialize local mailbox updates so
    // one positive candidate cannot overwrite another before the executor's
    // next 100ms poll.
    await updateAtomicJson(this.filePath, async () => {
      const existing = await this.recent(MAX_QUEUED_CANDIDATES);
      const candidates = [verified, ...existing.filter((item) => item.opportunityId !== verified.opportunityId)]
        .sort((a, b) => b.detectedAt - a.detectedAt)
        .slice(0, MAX_QUEUED_CANDIDATES);
      return {
        version: 1, updatedAt: Date.now(), candidates,
      } satisfies InboxFile;
    });
  }

  async latest(): Promise<AggregatorAtomicHandoff | undefined> {
    return (await this.recent(1))[0];
  }

  async recent(limit = MAX_QUEUED_CANDIDATES): Promise<AggregatorAtomicHandoff[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<InboxFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.candidates)) throw new Error('Malformed aggregator handoff inbox');
      return parsed.candidates.map(parseAggregatorAtomicHandoff)
        .sort((a, b) => b.detectedAt - a.detectedAt)
        .slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

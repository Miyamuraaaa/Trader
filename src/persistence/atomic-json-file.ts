import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

type Io = { mkdir: typeof mkdir; open: typeof open; rename: typeof rename; unlink: typeof unlink };
const queues = new Map<string, { tail: Promise<void>; pending: number }>();
const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** One process-wide FIFO per destination, including read/modify/write inbox updates. */
export function createAtomicJsonWriter(io: Io = { mkdir, open, rename, unlink }) {
  return async function updateJson(destination: string, produce: () => unknown | Promise<unknown>): Promise<void> {
    const resolved = path.resolve(destination);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const queue = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= 64) throw new Error('Atomic JSON write queue capacity exceeded');
    queues.set(key, queue); queue.pending++;
    const job = queue.tail.then(async () => {
      const document = JSON.stringify(await produce());
      if (document === undefined) throw new Error('Atomic JSON producer returned no document');
      await io.mkdir(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
      let created = false;
      try {
        const file = await io.open(temporary, 'wx', 0o600); created = true;
        try { await file.writeFile(document, 'utf8'); await file.sync(); }
        finally { await file.close(); }
        for (let attempt = 0; ; attempt++) {
          try { await io.rename(temporary, resolved); created = false; break; }
          catch (error) {
            if (!transient.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 4) throw error;
            await new Promise((resolve) => setTimeout(resolve, [10, 25, 75, 150][attempt]! + Math.floor(Math.random() * 5)));
          }
        }
      } catch (error) {
        if (created) {
          try { await io.unlink(temporary); }
          catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Atomic JSON replacement and temporary cleanup failed');
          }
        }
        throw error;
      }
    });
    queue.tail = job.catch(() => undefined);
    try { await job; }
    finally { if (--queue.pending === 0 && queues.get(key) === queue) queues.delete(key); }
  };
}

export const updateAtomicJson = createAtomicJsonWriter();
export function writeAtomicJson(destination: string, value: unknown): Promise<void> {
  // Snapshot on invocation, not after waiting for the previous writer.
  const snapshot: unknown = JSON.parse(JSON.stringify(value));
  return updateAtomicJson(destination, () => snapshot);
}

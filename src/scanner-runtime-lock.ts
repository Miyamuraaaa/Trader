import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

interface RuntimeLockRecord {
  pid: number;
  startedAt: number;
}

export interface ScannerRuntimeLock {
  readonly path: string;
  release(): Promise<void>;
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but cannot be signalled by this process.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readExistingLock(lockPath: string): Promise<RuntimeLockRecord | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<RuntimeLockRecord>;
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid)) return null;
    return { pid: value.pid, startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

/**
 * Guarantees that only one dashboard/scanner parent can own the persistent
 * execution journal. A second `npm run dev` used to create a second isolated
 * executor, causing journal rename races and duplicate stale handoffs.
 */
export async function acquireScannerRuntimeLock(
  lockPath = path.resolve('data/scanner-runtime.lock'),
): Promise<ScannerRuntimeLock> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies RuntimeLockRecord));
      await handle.close();

      let released = false;
      return {
        path: lockPath,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          const current = await readExistingLock(lockPath);
          // Never delete another process's lock during shutdown.
          if (current?.pid === process.pid) await unlink(lockPath).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readExistingLock(lockPath);
      if (current && await processIsAlive(current.pid)) {
        throw new Error(
          `Another scanner runtime is already active (pid=${current.pid}). Stop duplicate npm run dev processes before starting this one.`,
        );
      }
      // The owner is demonstrably gone (or the lock is malformed), so remove
      // only this exact stale lock and retry acquisition once.
      await unlink(lockPath).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      });
    }
  }
  throw new Error('Could not acquire scanner runtime lock');
}

import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export class PersistentExecutionLock {
  constructor(private readonly lockPath = path.resolve('data/execution.lock')) {}

  private async clearDeadOwner(): Promise<boolean> {
    let owner: string;
    try { owner = await readFile(this.lockPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const match = /^(\d+):(\d+):(.+)$/.exec(owner);
    if (!match) throw new Error(`Execution lock has malformed owner data: ${owner}`);
    const pid = Number(match[1]);
    let alive = true;
    try { process.kill(pid, 0); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') alive = false;
      else if (code !== 'EPERM') throw error;
    }
    if (alive) return false;
    // Re-read before unlinking so a newly acquired lock can never be removed.
    if (await readFile(this.lockPath, 'utf8').catch(() => '') !== owner) return false;
    await unlink(this.lockPath);
    return true;
  }

  async recoverDeadOwner(): Promise<boolean> {
    return this.clearDeadOwner();
  }

  async acquire(opportunityId: string): Promise<() => Promise<void>> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    let handle;
    try {
      handle = await open(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && await this.clearDeadOwner()) {
        handle = await open(this.lockPath, 'wx', 0o600);
      } else {
        let owner = 'unknown';
        try { owner = await readFile(this.lockPath, 'utf8'); } catch { /* keep fail-closed */ }
        throw new Error(`Execution lock is already held: ${owner}`);
      }
    }
    const nonce = `${process.pid}:${Date.now()}:${opportunityId}`;
    await handle.writeFile(nonce, 'utf8');
    await handle.close();
    let released = false;
    return async () => {
      if (released) return;
      const current = await readFile(this.lockPath, 'utf8').catch(() => '');
      if (current === nonce) await unlink(this.lockPath);
      released = true;
    };
  }
}

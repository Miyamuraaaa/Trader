import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { acquireScannerRuntimeLock } from '../src/scanner-runtime-lock.js';

describe('scanner runtime lock', () => {
  it('rejects a second active scanner and releases ownership safely', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sol-arb-runtime-lock-'));
    const lockPath = path.join(directory, 'scanner.lock');
    const lock = await acquireScannerRuntimeLock(lockPath);
    await expect(acquireScannerRuntimeLock(lockPath)).rejects.toThrow('Another scanner runtime is already active');
    await lock.release();
    const replacement = await acquireScannerRuntimeLock(lockPath);
    await replacement.release();
    await rm(directory, { recursive: true, force: true });
  });
});

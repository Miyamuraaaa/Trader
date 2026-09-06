import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import type { SignerContext } from './types.js';

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function loadDedicatedSigner(
  mode = CONFIG.executionMode,
  keypairPath = CONFIG.botKeypairPath,
  expectedWallet = CONFIG.botWalletAddress,
): Promise<SignerContext | null> {
  if (mode === 'paper') return null;
  if (!keypairPath) throw new Error('BOT_KEYPAIR_PATH is required outside PAPER mode');
  if (!expectedWallet) throw new Error('BOT_WALLET_ADDRESS is required outside PAPER mode');

  const resolved = path.resolve(keypairPath);
  const workspace = path.resolve(process.cwd());
  if (isInside(resolved, workspace)) {
    throw new Error('BOT_KEYPAIR_PATH must be outside the project directory');
  }
  // UNC/WSL filesystem metadata operations can each take seconds on Windows.
  // Read and stat concurrently; a failed read already proves the file is not
  // accessible, so a separate access() syscall only adds latency and a TOCTOU
  // window without strengthening the boundary.
  const [fileStat, serializedKeypair] = await Promise.all([
    stat(resolved),
    readFile(resolved, 'utf8'),
  ]);
  if (!fileStat.isFile()) throw new Error('BOT_KEYPAIR_PATH must point to a regular file');
  if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
    throw new Error('BOT_KEYPAIR_PATH permissions are too broad; require chmod 600');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedKeypair);
  } catch {
    throw new Error('BOT_KEYPAIR_PATH is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 64
    || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error('BOT_KEYPAIR_PATH must contain a Solana CLI 64-byte keypair array');
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    throw new Error('BOT_KEYPAIR_PATH contains a malformed keypair');
  }
  const publicKey = keypair.publicKey.toBase58();
  if (expectedWallet !== publicKey) {
    throw new Error('BOT_WALLET_ADDRESS does not match BOT_KEYPAIR_PATH');
  }
  return { keypair, publicKey, sourcePath: resolved };
}

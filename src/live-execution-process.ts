import { startLiveExecutionWorker, type LiveExecutionWorker } from './live-execution-worker.js';
import { log } from './logger.js';
import { loadDedicatedSigner } from './execution/signer.js';
import type { ManualApprovalResponse } from './execution/manual-approval.js';

let worker: LiveExecutionWorker | null = null;

async function main(): Promise<void> {
  // This process must only exist as the IPC child selected by src/index.ts (or
  // its co-located compiled equivalent). Direct invocation can never start a
  // live worker.
  if (!process.send) throw new Error('Isolated live executor has no IPC channel');
  log.info('Isolated live executor signer initialization started');
  const signerStartedAt = Date.now();
  log.info('Isolated live executor reading dedicated signer file');
  const signer = await loadDedicatedSigner('dry-run');
  if (!signer) throw new Error('Dedicated live signer is unavailable');
  log.info('Isolated live executor signer verified', {
    publicKey: signer.publicKey,
    elapsedMs: Date.now() - signerStartedAt,
  });
  const workerStartedAt = Date.now();
  log.info('Isolated live executor worker initialization started');
  worker = await startLiveExecutionWorker(signer, {
    noBroadcast: process.env.TRADER_PRODUCTION_SOAK === '1',
    onManualApprovalUpdate: (view) => process.send?.({ type: 'LIVE_APPROVAL_UPDATE', view }),
  });
  log.info('Isolated live executor worker created', { elapsedMs: Date.now() - workerStartedAt });
  process.send({ type: 'LIVE_EXECUTOR_READY' });
  log.info('Isolated live executor IPC ready sent');
}

function shutdown(signal: string): void {
  log.info('Live executor process stopping', { signal });
  worker?.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('disconnect', () => shutdown('IPC_DISCONNECT'));

process.on('message', async (message: unknown) => {
  if (!process.send || typeof message !== 'object' || message === null) return;
  const value = message as {
    type?: string; requestId?: string; executionId?: string; messageHash?: string; approvalToken?: string;
    candidate?: unknown; mints?: unknown;
  };
  if (value.type === 'LIVE_EXECUTOR_PREWARM') {
    if (Array.isArray(value.mints)) {
      worker?.prewarmMints(value.mints.filter((mint): mint is string => typeof mint === 'string').slice(0, 32));
    }
    return;
  }
  if (value.type === 'LIVE_EXECUTOR_HANDOFF') {
    worker?.enqueueCandidate(value.candidate);
    return;
  }
  if ((value.type !== 'LIVE_APPROVAL_ACCEPT' && value.type !== 'LIVE_APPROVAL_REJECT') || !value.requestId) return;
  const valid = [value.executionId, value.messageHash, value.approvalToken]
    .every((item) => typeof item === 'string' && item.length > 0 && item.length < 512);
  let response: ManualApprovalResponse;
  if (!worker || !valid) {
    response = { ok: false, view: null, error: 'Malformed approval request or executor unavailable' };
  } else if (value.type === 'LIVE_APPROVAL_ACCEPT') {
    response = await worker.approveManual(value.executionId!, value.messageHash!, value.approvalToken!);
  } else {
    response = await worker.rejectManual(value.executionId!, value.messageHash!, value.approvalToken!);
  }
  process.send({ type: 'LIVE_APPROVAL_RESPONSE', requestId: value.requestId, response });
});

main().catch((error) => {
  log.fatal('Live executor process failed closed', {
    reason: error instanceof Error ? error.stack : String(error),
  });
  process.exit(1);
});

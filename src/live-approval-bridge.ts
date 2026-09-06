import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { ManualApprovalResponse, ManualApprovalView } from './execution/manual-approval.js';

interface PendingRequest {
  resolve: (value: ManualApprovalResponse) => void;
  timer: NodeJS.Timeout;
}

/** Parent-process IPC bridge; it cannot access a signed transaction. */
export class LiveApprovalBridge {
  private child: ChildProcess | null = null;
  private view: ManualApprovalView | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(view: ManualApprovalView | null) => void>();

  attach(child: ChildProcess): void {
    this.child = child;
    child.on('message', (message: unknown) => this.onMessage(message));
    child.once('exit', () => {
      if (this.child === child) this.child = null;
      this.setView(null);
      for (const [requestId, request] of this.pending) {
        clearTimeout(request.timer);
        request.resolve({ ok: false, view: null, error: 'Live executor is unavailable' });
        this.pending.delete(requestId);
      }
    });
  }

  snapshot(): ManualApprovalView | null { return this.view ? { ...this.view } : null; }

  subscribe(listener: (view: ManualApprovalView | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setView(view: ManualApprovalView | null): void {
    this.view = view;
    for (const listener of this.listeners) listener(view ? { ...view } : null);
  }

  async accept(executionId: string, messageHash: string, approvalToken: string): Promise<ManualApprovalResponse> {
    return this.request('LIVE_APPROVAL_ACCEPT', executionId, messageHash, approvalToken);
  }

  async reject(executionId: string, messageHash: string, approvalToken: string): Promise<ManualApprovalResponse> {
    return this.request('LIVE_APPROVAL_REJECT', executionId, messageHash, approvalToken);
  }

  private request(type: 'LIVE_APPROVAL_ACCEPT' | 'LIVE_APPROVAL_REJECT', executionId: string, messageHash: string, approvalToken: string): Promise<ManualApprovalResponse> {
    if (!this.child?.connected) return Promise.resolve({ ok: false, view: this.snapshot(), error: 'Live executor is unavailable' });
    const requestId = randomUUID();
    return new Promise<ManualApprovalResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, view: this.snapshot(), error: 'Approval request timed out; no transaction was retried' });
      }, 10_000);
      this.pending.set(requestId, { resolve, timer });
      this.child!.send({ type, requestId, executionId, messageHash, approvalToken }, (error) => {
        if (!error) return;
        const request = this.pending.get(requestId);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(requestId);
        resolve({ ok: false, view: this.snapshot(), error: `Could not deliver approval request: ${error.message}` });
      });
    });
  }

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const value = message as { type?: string; view?: ManualApprovalView | null; requestId?: string; response?: ManualApprovalResponse };
    if (value.type === 'LIVE_APPROVAL_UPDATE') {
      this.setView(value.view ?? null);
      return;
    }
    if (value.type === 'LIVE_APPROVAL_RESPONSE' && value.requestId && value.response) {
      this.setView(value.response.view);
      const pending = this.pending.get(value.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.requestId);
      pending.resolve(value.response);
    }
  }
}

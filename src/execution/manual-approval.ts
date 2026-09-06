export type ManualApprovalState =
  | 'READY_TO_EXECUTE'
  | 'EXECUTING'
  | 'SUBMITTED'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'SUBMISSION_UNKNOWN'
  | 'TRANSACTION_FAILED';

/** Safe dashboard projection. It contains no serialized transaction or secret. */
export interface ManualApprovalView {
  /** UI-only fixture. The executor never creates a mock view. */
  mock?: boolean;
  state: ManualApprovalState;
  executionId: string;
  messageHash: string;
  approvalToken: string;
  providers: [string, string];
  routeType: string;
  intermediateMint: string;
  inputUsdc: string;
  expectedOutputAtomic: string;
  minimumOutputAtomic: string;
  conservativeNetUsdc: string;
  roiBps: string;
  confidenceScore: number | null;
  quoteAgeMs: number;
  candidateToReadyLatencyMs: number;
  simulation: { passed: boolean; unitsConsumed?: number; transactionBytes: number };
  expiresAt: number;
  signature?: string;
  actualNetworkFeeLamports?: string;
  realizedUsdcPnl?: string;
  intermediateDustAtomic?: string;
  confirmationTimeMs?: number;
  reason?: string;
  updatedAt: number;
}

export interface ManualApprovalResponse {
  ok: boolean;
  view: ManualApprovalView | null;
  error?: string;
}

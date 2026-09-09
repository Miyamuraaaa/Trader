/** Payload-free exact causes; a local quota/cooldown error is never called HTTP_429. */
export function providerFailureReason(error: unknown): string {
  const value = error as { code?: string; name?: string; status?: number; message?: string } | null;
  const message = value?.message ?? '';
  if (value?.status === 429) return 'HTTP_429';
  if (value?.code === 'SCANNER_RPC_BACKPRESSURE' || value?.name === 'ScannerRpcBackpressureError') return 'SCANNER_RPC_RETRY_AFTER_COOLDOWN';
  if (/RESERVATION/.test(value?.code ?? message)) return value?.code ?? message.split(':')[0]!;
  if (/QUEUE_DEADLINE|QUEUE_CANCELLED|PARENT_WORKFLOW_DEADLINE/.test(message)) return 'NEXT_LEGAL_SEND_AFTER_DEADLINE';
  if (/cooldown|backpressure/i.test(message)) return 'PROVIDER_RETRY_AFTER_COOLDOWN';
  if (/capacity|OVERFLOW/i.test(message)) return 'INTERNAL_QUEUE_CAPACITY';
  if (/timed? ?out|timeout|AbortError/i.test(message + value?.name)) return 'HTTP_TIMEOUT';
  if (/fetch failed|network|ECONN|ENOTFOUND/i.test(message)) return 'HTTP_NETWORK_ERROR';
  if (/shape|non-JSON|JSON|malformed/i.test(message)) return 'HTTP_MALFORMED_RESPONSE';
  if (/audited|policy|partial|mint|pool|propagation/i.test(message)) return 'ROUTE_POLICY_REJECTED';
  return 'UNCLASSIFIED_LOCAL_FAILURE';
}

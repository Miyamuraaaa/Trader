/** Immutable parent budget; projections share the existing provider governors, not new limiters. */
export interface WorkflowProjection {
  provider: string; serviceMs: number; predictedStartMono: number; predictedCompletionMono: number; cooldownUntilMono: number;
}
export function workflowParentDeadline(nowMono: number, nowWall: number, evidenceAt: number, windowMs: number): number {
  if (![nowMono, nowWall, evidenceAt, windowMs].every(Number.isFinite) || evidenceAt > nowWall || windowMs <= 0) throw new Error('PREFILTER_STALE');
  return nowMono + windowMs - (nowWall - evidenceAt);
}
export function projectWorkflow(parentDeadline: number, first: WorkflowProjection, downstream: WorkflowProjection, localReserveMs: number) {
  const completion = downstream.predictedCompletionMono + localReserveMs;
  return { parentDeadline, first, downstream, localReserveMs, predictedCompletion: completion,
    leg1Deadline: parentDeadline - downstream.serviceMs - localReserveMs,
    leg2Deadline: parentDeadline - localReserveMs,
    feasible: first.predictedCompletionMono <= downstream.predictedStartMono && completion <= parentDeadline,
    cause: completion <= parentDeadline ? 'FEASIBLE' : Math.max(first.cooldownUntilMono, downstream.cooldownUntilMono) > 0 && Math.max(first.cooldownUntilMono, downstream.cooldownUntilMono) > parentDeadline
      ? 'PROVIDER_RATE_LIMIT_OR_MANDATORY_COOLDOWN' : 'PROVIDER_SERVICE_TOO_SLOW_FOR_REMAINING_BUDGET' };
}
const projections: Array<{ candidateId: string; stage: string; projection: ReturnType<typeof projectWorkflow> }> = [];
export function recordWorkflowProjection(candidateId: string | undefined, stage: string, projection: ReturnType<typeof projectWorkflow>): void {
  projections.push({ candidateId: candidateId ?? 'UNATTRIBUTED', stage, projection });
  if (projections.length > 128) projections.shift();
}
export function workflowProjectionSnapshot() { return [...projections]; }

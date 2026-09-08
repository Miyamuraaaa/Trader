import { describe, expect, it } from 'vitest';
import { QuoteAdmission } from '../src/quote-admission.js';
import { projectWorkflow, workflowParentDeadline } from '../src/execution/prefilter-workflow.js';
import { readFile } from 'node:fs/promises';

describe('dependent constrained workflow admission', () => {
  it('anchors immutable parent deadline to original evidence, not each child request', () => {
    const parent = workflowParentDeadline(1000, 10000, 9700, 1800);
    expect(parent).toBe(2500);
    expect(workflowParentDeadline(1200, 10200, 9700, 1800)).toBe(parent);
    expect(() => workflowParentDeadline(1000, 10000, 10001, 1800)).toThrow('PREFILTER_STALE');
  });
  it('rejects a feasible first request when the whole dependent workflow is impossible', () => {
    const first = { provider: 'jupiter', serviceMs: 300, predictedStartMono: 100, predictedCompletionMono: 400, cooldownUntilMono: 0 };
    const second = { provider: 'raptor', serviceMs: 400, predictedStartMono: 1500, predictedCompletionMono: 1900, cooldownUntilMono: 0 };
    expect(first.predictedCompletionMono).toBeLessThan(1800);
    expect(projectWorkflow(1800, first, second, 45)).toMatchObject({ feasible: false, predictedCompletion: 1945, leg1Deadline: 1355, leg2Deadline: 1755 });
  });
  it('uses actual legal-send state without omitting or double-counting overlapping pacing', () => {
    const admission = new QuoteAdmission('raptor', 1000, () => 100, () => 1000,
      () => ({ nextLegalSendMono: 500, cooldownUntilMono: 0 }));
    expect(admission.forecast(800, 400)).toMatchObject({ predictedStartMono: 500, predictedCompletionMono: 900 });
    expect(admission.forecast(800, 700)).toMatchObject({ predictedStartMono: 700, predictedCompletionMono: 1100 });
  });
  it('attributes provider-wide cooldown instead of calling it generic queue wait', () => {
    const admission = new QuoteAdmission('raptor', 1000, () => 100, () => 1000,
      () => ({ nextLegalSendMono: 500, cooldownUntilMono: 5000 }));
    const second = admission.forecast(800, 400);
    const first = { ...second, provider: 'jupiter', predictedStartMono: 100, predictedCompletionMono: 400, cooldownUntilMono: 0 };
    expect(projectWorkflow(1800, first, second, 45)).toMatchObject({ feasible: false, cause: 'PROVIDER_RATE_LIMIT_OR_MANDATORY_COOLDOWN' });
  });
  it('blocks soak manual acceptance before journal approval or broadcaster construction', async () => {
    const source = await readFile('src/live-execution-worker.ts', 'utf8');
    const approve = source.slice(source.indexOf('const approveManual ='));
    expect(approve.indexOf('if (noBroadcast) return')).toBeLessThan(approve.indexOf("'APPROVED_BY_USER'"));
    expect(approve.indexOf('if (noBroadcast) return')).toBeLessThan(approve.indexOf('new OneShotBroadcaster'));
    expect(source).toContain('No-broadcast validation requires LIVE_TRADING_ENABLED=false');
  });
});

import { describe, expect, it } from 'vitest';
import { QuoteAdmission } from '../src/quote-admission.js';

describe('dependent leg future service reservation', () => {
  it('reproduces the measured slot theft and protects the downstream legal send', () => {
    let now = 165863;
    const admission = new QuoteAdmission('raptor', 1000, () => now);
    const release = admission.reserveWorkflow(167302, 166604, 362);
    // An early slot remains borrowable: the next legal send still fits.
    expect(admission.discoveryReservationDelayMs()).toBe(0);
    // Production trace: discovery tried using 166549 while leg1 was about to finish.
    now = 166549;
    expect(now + 1000 + 362).toBeGreaterThan(167302);
    expect(admission.discoveryReservationDelayMs()).toBeGreaterThan(0);
    now = 166558; release(); // Exact minimum now known; leg2 joins P0.
    expect(admission.discoveryReservationDelayMs()).toBe(0);
    expect(now + 362 + 45).toBeLessThan(167347);
    expect(admission.snapshot().active_workflow_reservations).toBe(0);
  });
  it('bounds reservations, expires abandoned work, and allows discovery to resume', () => {
    let now = 0; const admission = new QuoteAdmission('raptor', 1000, () => now);
    const releases = Array.from({length:16},()=>admission.reserveWorkflow(1500,500,350));
    expect(()=>admission.reserveWorkflow(1500,500,350)).toThrow('PREFILTER_QUEUE_OVERFLOW');
    now = 1000; expect(admission.discoveryReservationDelayMs()).toBeGreaterThan(0);
    now = 1500; expect(admission.discoveryReservationDelayMs()).toBe(0);
    releases.forEach((release)=>{release();release();});
    expect(admission.snapshot().active_workflow_reservations).toBe(0);
  });
  it('does not admit an impossible reservation or change provider cooldown authority', () => {
    const admission = new QuoteAdmission('raptor',1000,()=>100,()=>1000,()=>({nextLegalSendMono:200,cooldownUntilMono:5000}));
    expect(()=>admission.reserveWorkflow(900,800,350)).toThrow('PREFILTER_QUEUE_DEADLINE_EXCEEDED');
    const release = admission.reserveWorkflow(1800,500,350);
    expect(admission.forecast(800).predictedStartMono).toBe(5000);
    release();
  });
});

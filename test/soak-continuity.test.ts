import { describe, expect, it } from 'vitest';
import { soakContinuity } from '../src/soak-continuity.js';
describe('production soak evidence validity', () => {
  it('does not count host suspension as a completed continuous soak', () => {
    const times = [...Array.from({length:21},(_,i)=>(i+1)*30000),11444973];
    expect(soakContinuity(times,1800000)).toMatchObject({ validProductionSoak:false,continuousPrefixMs:630000,reason:'HOST_OR_PROCESS_STALL_INVALIDATED_SOAK' });
  });
  it('accepts thirty minutes of continuous samples, not a shorter interrupted run', () => {
    expect(soakContinuity(Array.from({length:60},(_,i)=>(i+1)*30000),1800000).validProductionSoak).toBe(true);
    expect(soakContinuity([30000,60000],1800000).validProductionSoak).toBe(false);
  });
});

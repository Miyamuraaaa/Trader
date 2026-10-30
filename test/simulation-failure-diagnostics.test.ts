import { describe, expect, it } from 'vitest';
import { describeSimulationFailure } from '../src/execution/simulation-failure-diagnostics.js';

const ix = (id: string) => ({ programId: { toBase58: () => id } });
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RAPTOR = 'RaptorD5ojtsqDDtJeRsunPLg6GvLYNnwKJWxYE4m87';

describe('describeSimulationFailure', () => {
  it('names instruction program and the program that raised the custom error', () => {
    const logs = [
      `Program ${RAPTOR} invoke [1]`,
      `Program ${RAPTOR} success`,
      `Program ${JUP} invoke [1]`,
      'Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.',
      `Program ${JUP} failed: custom program error: 0x1771`,
    ];
    const d = describeSimulationFailure({ InstructionError: [3, { Custom: 6001 }] },
      logs, [ix('cu'), ix('cu'), ix(RAPTOR), ix(JUP)]);
    expect(d.instructionIndex).toBe(3);
    expect(d.instructionProgramId).toBe(JUP);
    expect(d.failingProgramId).toBe(JUP);
    expect(d.anchorErrorName).toBe('SlippageToleranceExceeded');
    expect(d.customCode).toBe(6001);
    expect(d.summary.length).toBeLessThanOrEqual(700);
  });
  it('flags a mismatch between index program and log program', () => {
    const logs = [`Program ${JUP} failed: custom program error: 0x1771`];
    const d = describeSimulationFailure({ InstructionError: [3, { Custom: 6001 }] },
      logs, [ix('a'), ix('b'), ix('c'), ix(RAPTOR)]);
    expect(d.instructionProgramId).toBe(RAPTOR);
    expect(d.failingProgramId).toBe(JUP);
  });
  it('tolerates missing logs and unknown error shapes', () => {
    const d = describeSimulationFailure('weird', undefined, []);
    expect(d.instructionIndex).toBeUndefined();
    expect(d.summary).toContain('failingProgram=not-in-logs');
  });
});

/**
 * Diagnostics only. Turns a failed unsigned simulation into a bounded,
 * human-readable reason that names the failing instruction, its program and,
 * when the logs say so, the program that actually raised the custom error.
 * It never changes pass/fail: callers still reject on any simulation error.
 */
export interface InstructionLike { programId: { toBase58(): string } }

export interface SimulationFailureDetail {
  instructionIndex?: number;
  instructionProgramId?: string;
  customCode?: number;
  failingProgramId?: string;
  anchorErrorName?: string;
  anchorErrorNumber?: number;
  tailLogs: string[];
  summary: string;
}

const BASE58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const FAILED_RE = new RegExp(`^Program (${BASE58}) failed: custom program error: (0x[0-9a-fA-F]+)`);
const ANCHOR_RE = /Error Code: (\w+)\. Error Number: (\d+)/;
const MAX_LOG_LINE = 160;
const MAX_SUMMARY = 700;

function parseInstructionError(error: unknown): { index?: number; custom?: number } {
  if (!error || typeof error !== 'object') return {};
  const ie = (error as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length < 2) return {};
  const index = typeof ie[0] === 'number' ? ie[0] : undefined;
  const detail = ie[1];
  const custom = detail && typeof detail === 'object' && typeof (detail as { Custom?: unknown }).Custom === 'number'
    ? (detail as { Custom: number }).Custom : undefined;
  return { index, custom };
}

export function describeSimulationFailure(
  error: unknown,
  logs: readonly string[] | null | undefined,
  instructions: readonly InstructionLike[],
): SimulationFailureDetail {
  const { index, custom } = parseInstructionError(error);
  const lines = (logs ?? []).map((line) => String(line));
  let failingProgramId: string | undefined;
  let anchorErrorName: string | undefined;
  let anchorErrorNumber: number | undefined;
  // The first "failed" line is the innermost program; outer callers repeat it.
  for (const line of lines) {
    const failed = FAILED_RE.exec(line);
    if (failed) { failingProgramId = failed[1]; break; }
  }
  for (const line of lines) {
    const anchor = ANCHOR_RE.exec(line);
    if (anchor) { anchorErrorName = anchor[1]; anchorErrorNumber = Number(anchor[2]); break; }
  }
  const instructionProgramId = index !== undefined ? instructions[index]?.programId.toBase58() : undefined;
  const tailLogs = lines.slice(-4).map((line) => line.slice(0, MAX_LOG_LINE));
  const parts = [
    `index=${index ?? 'unknown'}`,
    `ixProgram=${instructionProgramId ?? 'unknown'}`,
    `custom=${custom ?? 'n/a'}`,
    `failingProgram=${failingProgramId ?? 'not-in-logs'}`,
    ...(anchorErrorName ? [`anchor=${anchorErrorName}(${anchorErrorNumber})`] : []),
    `tail=${JSON.stringify(tailLogs)}`,
  ];
  const summary = parts.join(' ').slice(0, MAX_SUMMARY);
  return { instructionIndex: index, instructionProgramId, customCode: custom, failingProgramId, anchorErrorName, anchorErrorNumber, tailLogs, summary };
}

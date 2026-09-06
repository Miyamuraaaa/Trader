/** Tiny structured logger. Every line carries an ISO timestamp. */

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'OPP';

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const base = `[${ts}] ${level.padEnd(5)} ${msg}`;
  if (extra && Object.keys(extra).length > 0) {
    console.log(base + ' ' + JSON.stringify(extra));
  } else {
    console.log(base);
  }
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('DEBUG', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('INFO', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('WARN', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('ERROR', msg, extra),
  fatal: (msg: string, extra?: Record<string, unknown>) => emit('FATAL', msg, extra),
  /** Highlighted line used only when a qualifying estimated opportunity is found. */
  opportunity: (msg: string, extra?: Record<string, unknown>) => emit('OPP', msg, extra),
};

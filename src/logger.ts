// A deliberately tiny structured logger. The daemon is fail-fast (eng review
// 6A): logs go to stderr and launchd captures them.

export interface Logger {
  /** Verbose tracing; emitted only when debug logging is enabled (NAGI_DEBUG). */
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function emit(level: string, msg: string, meta?: Record<string, unknown>): void {
  const suffix = meta && 0 < Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`[nagi:${level}] ${msg}${suffix}\n`);
}

/**
 * Debug logging is opt-in via the NAGI_DEBUG env var (any value except empty/"0"/"false").
 * Read at call time so it can be toggled without rebuilding, and so tests can set it.
 */
export function debugEnabled(): boolean {
  const v = process.env['NAGI_DEBUG'];
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export const logger: Logger = {
  debug: (msg, meta) => {
    if (debugEnabled()) emit('debug', msg, meta);
  },
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};

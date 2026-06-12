// A deliberately tiny structured logger. The daemon is fail-fast (eng review
// 6A): logs go to stderr and launchd captures them.

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function emit(level: string, msg: string, meta?: Record<string, unknown>): void {
  const suffix = meta && 0 < Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`[nagi:${level}] ${msg}${suffix}\n`);
}

export const logger: Logger = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};

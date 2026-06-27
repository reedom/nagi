import { appendFileSync } from 'node:fs';
import type { Logger } from './logger.js';
import type { Outcome } from './types.js';

// Append-only JSONL audit log (D14). Writes are best-effort: a logging failure
// must never crash the request path.

export interface AuditEntry {
  ts: string;
  teamId: string;
  userId: string;
  channel?: string;
  threadTs?: string;
  text: string;
  workflowId?: string;
  args?: unknown;
  approvals?: number;
  tokens?: number;
  outcome: Outcome;
  detail?: string;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, 'ts'>): void;
}

export function makeAuditLog(path: string, log: Logger, clock: () => string = () => new Date().toISOString()): AuditLog {
  return {
    record(entry) {
      const line = `${JSON.stringify({ ts: clock(), ...entry })}\n`;
      try {
        appendFileSync(path, line);
      } catch (err) {
        log.warn('audit write failed', { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

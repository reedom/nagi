import type { QueueStatus } from './queue.js';

// Presentation helpers for the dispatcher's in-thread replies. Kept pure so the
// exact wording stays under test.

export function shortLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 48 ? oneLine : `${oneLine.slice(0, 47)}…`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatStatus(status: QueueStatus): string {
  const active = status.active ? `Running: *${status.active}*` : 'Idle — nothing running.';
  if (status.queued.length === 0) return active;
  const queued = status.queued.map((label, i) => `  ${i + 1}. ${label}`).join('\n');
  return `${active}\nQueued (${status.queued.length}):\n${queued}`;
}

export function formatResult(result: unknown): string {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const summary = record['summary'] ?? record['answer'];
    if (typeof summary === 'string') return summary;
  }
  return `\`\`\`${JSON.stringify(result, null, 2)}\`\`\``;
}

import { execFileSync } from 'node:child_process';
import type { Logger } from '../logger.js';

// `cancel` must stop the active run (D12). The engine spawns agent CLIs
// (claude/codex) as children of THIS process but exposes no AbortSignal, so v1
// cancellation is a best-effort process-tree kill: terminate every descendant
// of the daemon. The killed CLI exits non-zero, the engine's runProcess
// rejects, and the dispatcher reports the cancellation in-thread.
//
// (A clean engine-level AbortSignal is the documented follow-up; see README.)

function readProcessTable(): Map<number, number[]> {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  return children;
}

export function descendantPids(root: number, table: Map<number, number[]>): number[] {
  const result: number[] = [];
  const stack = [...(table.get(root) ?? [])];
  while (stack.length !== 0) {
    const pid = stack.pop();
    if (pid === undefined) continue;
    result.push(pid);
    stack.push(...(table.get(pid) ?? []));
  }
  return result;
}

export function killActiveRunDescendants(log: Logger, rootPid: number = process.pid): number {
  let pids: number[];
  try {
    pids = descendantPids(rootPid, readProcessTable());
  } catch (err) {
    log.warn('could not enumerate processes to cancel', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  // Kill leaves first (deepest discovered last) to reduce reparenting races.
  for (const pid of pids.reverse()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone; nothing to do.
    }
  }
  return pids.length;
}

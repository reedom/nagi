export interface RunBinding {
  channel: string;
  threadTs: string;
  ceilingMs: number;
  surfaceRef?: string;
}

export type Schedule = (fn: () => void, ms: number) => () => void;
const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

interface Entry extends RunBinding {
  resolve: (text: string) => void;
  reject: (reason: Error) => void;
  cancelTimer: () => void;
}

function bindingOf(e: Entry): RunBinding {
  const b: RunBinding = { channel: e.channel, threadTs: e.threadTs, ceilingMs: e.ceilingMs };
  if (e.surfaceRef !== undefined) b.surfaceRef = e.surfaceRef;
  return b;
}

/** Tracks concurrent surfaced runs: runId -> thread binding + the awaited result. */
export class PendingRuns {
  private readonly map = new Map<string, Entry>();

  await(runId: string, binding: RunBinding, deps: { schedule?: Schedule } = {}): Promise<{ text: string }> {
    const schedule = deps.schedule ?? defaultSchedule;
    return new Promise<{ text: string }>((resolve, reject) => {
      const cancelTimer = schedule(() => {
        this.map.delete(runId);
        reject(new Error('surfaced run exceeded its wait ceiling'));
      }, binding.ceilingMs);
      this.map.set(runId, {
        ...binding,
        resolve: (text) => resolve({ text }),
        reject,
        cancelTimer,
      });
    });
  }

  get(runId: string): RunBinding | undefined {
    const e = this.map.get(runId);
    return e ? bindingOf(e) : undefined;
  }

  setSurfaceRef(runId: string, surfaceRef: string): void {
    const e = this.map.get(runId);
    if (e) e.surfaceRef = surfaceRef;
  }

  resolveResult(runId: string, text: string): boolean {
    const e = this.map.get(runId);
    if (!e) return false;
    this.map.delete(runId);
    e.cancelTimer();
    e.resolve(text);
    return true;
  }

  cancel(runId: string): RunBinding | undefined {
    const e = this.map.get(runId);
    if (!e) return undefined;
    this.map.delete(runId);
    e.cancelTimer();
    e.reject(new Error('surfaced run cancelled'));
    return bindingOf(e);
  }

  active(): string[] {
    return [...this.map.keys()];
  }

  /** Cancels every active run; returns how many. Bindings are returned via the iterator for surface cleanup. */
  cancelAll(): number {
    const ids = this.active();
    for (const id of ids) this.cancel(id);
    return ids.length;
  }
}

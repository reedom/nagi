import type { Logger } from '../logger.js';

// Single-flight policy for v1: one workflow runs at a time; a second request is
// accepted, parked in an in-memory FIFO, and run when the current one finishes.
// No persistence — queue loss on restart is accepted and documented (6A).

export interface QueueJob {
  /** Short human label for "busy with ..." replies and status output. */
  label: string;
  run(): Promise<void>;
}

export type Admission =
  | { accepted: true }
  | { accepted: false; busyWith: string; position: number };

export interface QueueStatus {
  active?: string;
  queued: string[];
}

export class WorkQueue {
  private active: QueueJob | undefined;
  private readonly pending: QueueJob[] = [];

  constructor(private readonly log: Logger) {}

  /** Returns whether the job starts now or is queued behind the active one. */
  enqueue(job: QueueJob): Admission {
    const idle = this.active === undefined && this.pending.length === 0;
    this.pending.push(job);
    if (this.active === undefined) void this.pump();
    if (idle) return { accepted: true };
    const busyWith = this.active?.label ?? 'a queued task';
    return { accepted: false, busyWith, position: this.pending.length };
  }

  status(): QueueStatus {
    return {
      ...(this.active ? { active: this.active.label } : {}),
      queued: this.pending.map((job) => job.label),
    };
  }

  /** Drops not-yet-started jobs (used by `cancel`); the active run is killed elsewhere. */
  clearPending(): number {
    const dropped = this.pending.length;
    this.pending.length = 0;
    return dropped;
  }

  private async pump(): Promise<void> {
    while (this.pending.length !== 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.active = job;
      try {
        await job.run();
      } catch (err) {
        // run() owns its own error reporting; this is a last-resort guard so the
        // pump never dies and strands the queue.
        this.log.error('queue job threw past its handler', {
          label: job.label,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.active = undefined;
      }
    }
  }
}

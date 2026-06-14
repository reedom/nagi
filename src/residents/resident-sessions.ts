/** One live resident: a cmux surface bound to a Slack thread, identified by a stable runId. */
export interface ResidentSession {
  runId: string;
  surfaceRef: string;
  channel: string;
  threadTs: string;
}

/**
 * Tracks resident agents: thread-addressed for input routing (getByThread) and
 * runId-addressed for output routing (getByRun). Kept distinct from PendingRuns,
 * which only models the turn-1 run() await.
 */
export class ResidentSessions {
  private readonly byThread = new Map<string, ResidentSession>();
  private readonly threadByRun = new Map<string, string>();

  add(session: ResidentSession): void {
    this.byThread.set(session.threadTs, session);
    this.threadByRun.set(session.runId, session.threadTs);
  }

  getByThread(threadTs: string): ResidentSession | undefined {
    return this.byThread.get(threadTs);
  }

  getByRun(runId: string): ResidentSession | undefined {
    const threadTs = this.threadByRun.get(runId);
    return threadTs === undefined ? undefined : this.byThread.get(threadTs);
  }

  remove(threadTs: string): ResidentSession | undefined {
    const session = this.byThread.get(threadTs);
    if (!session) return undefined;
    this.byThread.delete(threadTs);
    this.threadByRun.delete(session.runId);
    return session;
  }

  list(): ResidentSession[] {
    return [...this.byThread.values()];
  }
}

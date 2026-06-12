// In-memory map of threadTs -> pending clarification (8A). Escalation approvals
// use Block Kit buttons and never consume thread replies (D11), so the only
// thing parked here is an unanswered triage clarification.
//
// Entries carry a TTL with check-on-access PLUS a periodic sweep (8A/D9): an
// expired clarification means a late reply is treated as a fresh request.

export interface PendingClarification {
  /** The original request text, so a reply re-runs triage with full context. */
  originalText: string;
  /** The question we asked, for the audit trail. */
  question: string;
  expiresAt: number;
}

export interface ThreadStore {
  get(threadTs: string): PendingClarification | undefined;
  set(threadTs: string, pending: Omit<PendingClarification, 'expiresAt'>): void;
  delete(threadTs: string): void;
  sweep(): number;
  size(): number;
}

export interface ThreadStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

export function makeThreadStore(opts: ThreadStoreOptions = {}): ThreadStore {
  const ttlMs = opts.ttlMs ?? 15 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, PendingClarification>();

  const live = (entry: PendingClarification | undefined): PendingClarification | undefined => {
    if (!entry) return undefined;
    return now() < entry.expiresAt ? entry : undefined;
  };

  return {
    get(threadTs) {
      const entry = live(entries.get(threadTs));
      if (!entry) entries.delete(threadTs); // check-on-access eviction
      return entry;
    },
    set(threadTs, pending) {
      entries.set(threadTs, { ...pending, expiresAt: now() + ttlMs });
    },
    delete(threadTs) {
      entries.delete(threadTs);
    },
    sweep() {
      const cutoff = now();
      let removed = 0;
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= cutoff) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    size() {
      return entries.size;
    },
  };
}

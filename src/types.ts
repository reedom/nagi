// Shared domain types for the concierge. The engine's own types are imported
// from 'ai-workflow-engine' where needed; these describe the Slack front door.

/** A normalized inbound request, independent of Slack's event shape. */
export interface RequestContext {
  teamId: string;
  channel: string;
  /** The thread root timestamp; replies land here. */
  threadTs: string;
  userId: string;
  text: string;
}

/** Minimal port for posting plain replies into a single thread. */
export interface ThreadReplier {
  say(text: string): Promise<void>;
}

/** Outcome categories recorded in the audit log for every request. */
export type Outcome =
  | 'refused'
  | 'clarification'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'control';

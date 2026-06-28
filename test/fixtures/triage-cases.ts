// Golden triage cases (7A). One per registry entry, plus clarification triggers
// and an unknown-repo case. Grown over time from dogfood audit-log misfires.
//
// `expect` is the EXPECTED DECISION, not the raw triage output: either a
// concrete dispatch target or a clarification.

export type CaseExpectation = { workflowId: string } | { clarify: true };

export interface TriageCase {
  name: string;
  input: string;
  expect: CaseExpectation;
}

export const triageCases: TriageCase[] = [
  // review-repo dispatches
  { name: 'review engine', input: 'review the engine repo', expect: { workflowId: 'review-repo' } },
  { name: 'audit web', input: 'audit the web repo for security issues', expect: { workflowId: 'review-repo' } },
  { name: 'review engine diff', input: 'look over the engine working diff and flag risks', expect: { workflowId: 'review-repo' } },
  { name: 'assess web', input: 'can you assess the web codebase?', expect: { workflowId: 'review-repo' } },
  { name: 'review engine focus', input: 'review engine, focus on error handling', expect: { workflowId: 'review-repo' } },

  // research dispatches
  { name: 'research db', input: 'research the trade-offs of SQLite vs Postgres for a job queue', expect: { workflowId: 'research' } },
  { name: 'investigate rate limiting', input: 'investigate options for rate limiting in node', expect: { workflowId: 'research' } },
  { name: 'compare jobs', input: 'compare approaches to background job processing', expect: { workflowId: 'research' } },
  { name: 'best practices', input: 'what are the current best practices for socket-mode slack bots?', expect: { workflowId: 'research' } },

  // investigate-ticket dispatches
  { name: 'investigate ticket dea', input: 'investigate ticket DEA-1234', expect: { workflowId: 'investigate-ticket' } },
  { name: 'investigate ticket soa', input: 'look into SOA-42 and find the root cause', expect: { workflowId: 'investigate-ticket' } },

  // surface dispatches
  { name: 'surface engine', input: 'open a surface and run auth review on engine', expect: { workflowId: 'surface' } },

  // clarification triggers
  { name: 'vague do', input: 'do the thing', expect: { clarify: true } },
  { name: 'help', input: 'help', expect: { clarify: true } },
  { name: 'review no repo', input: 'review my code', expect: { clarify: true } },
  { name: 'unknown repo', input: 'review the foobar repo', expect: { clarify: true } },
  { name: 'which project', input: 'can you look at my project', expect: { clarify: true } },
  { name: 'ambiguous run', input: 'run a workflow for me', expect: { clarify: true } },
  { name: 'bare summarize', input: 'summarize', expect: { clarify: true } },
];

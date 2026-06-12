import type { NagiConfig } from '../config.js';
import type { RequestContext } from '../types.js';

// The auth gate pins the workspace/team ID alongside the user allowlist (D14).
// A request must clear BOTH before it can reach triage or the engine — the
// claude adapter grants unrestricted Bash on the host, so this is a v1
// requirement, not an option.

export interface AuthResult {
  allowed: boolean;
  reason?: string;
}

export function checkAuth(config: NagiConfig, req: Pick<RequestContext, 'teamId' | 'userId'>): AuthResult {
  if (req.teamId !== config.slack.allowedTeamId) {
    return { allowed: false, reason: 'workspace not allowlisted' };
  }
  if (!config.slack.allowedUserIds.includes(req.userId)) {
    return { allowed: false, reason: 'user not allowlisted' };
  }
  return { allowed: true };
}

export const REFUSAL_MESSAGE =
  "Sorry, I can't act on requests from this account. Ask the operator to add you to the allowlist.";

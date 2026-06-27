// The deterministic security boundary: only repos whose host/owner segments
// match a configured scope may ever be provisioned or handed to an agent.

export interface ScopeResult { approved: string[]; rejected: string[] }

// "github.com/acme/*" -> matches a path whose last 3 segments are
// github.com / acme / <name>. We compare segments, never substrings.
function matches(repoPath: string, scope: string): boolean {
  const scopeParts = scope.split('/').filter((s) => s.length !== 0);
  if (scopeParts.length < 2) return false;
  const wildcard = scopeParts[scopeParts.length - 1] === '*';
  const needed = wildcard ? scopeParts.slice(0, -1) : scopeParts;
  const parts = repoPath.split('/').filter((s) => s.length !== 0);
  // Owner-level match: the needed segments must appear as the tail, with one
  // more segment (the repo name) after them when the scope ends in '*'.
  const tailLen = wildcard ? needed.length + 1 : needed.length;
  if (parts.length < tailLen) return false;
  const ownerTail = wildcard ? parts.slice(-tailLen, -1) : parts.slice(-tailLen);
  return needed.every((seg, i) => seg === ownerTail[i]);
}

export function filterScope(repoPaths: string[], scopes: string[]): ScopeResult {
  const approved: string[] = [];
  const rejected: string[] = [];
  for (const p of repoPaths) {
    if (scopes.some((s) => matches(p, s))) approved.push(p);
    else rejected.push(p);
  }
  return { approved, rejected };
}

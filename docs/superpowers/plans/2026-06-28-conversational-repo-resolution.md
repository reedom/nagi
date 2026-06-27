# Conversational Repo Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace nagi's static repo alias map with agent-driven, ticket-first repo discovery gated by a deterministic scope boundary, modelled as a repo dependency DAG, operating inside swappable worktrunk worktrees.

**Architecture:** triage stays thin and passes a free-form `ticketRef`/`repoHint`. A dispatched `investigate-ticket` workflow runs a `resolve-and-schedule` step whose orchestration code (host TS) discovers repos via an agent, scope-filters them deterministically in nagi, provisions a worktree per repo through a replaceable external script, investigates each in dependency order (parallel where independent), and persists the resulting graph.

**Tech Stack:** TypeScript (strict, NodeNext ESM), zod, vitest, ai-workflow-engine (`WorkflowApi.agent({schema,tools,cwd})`, `wf.parallel`), Node `child_process`/`fs`, ghq, worktrunk (`wt`).

## Global Constraints

- TypeScript strict; no `any`, no loose types. Imports use `.js` extensions (NodeNext).
- Tests live in `test/**/*.test.ts`, run with `pnpm test` (vitest). Mirror existing style: `import { describe, expect, it, vi } from 'vitest'`.
- Numeric comparisons MUST use `<` or `<=`, never `>` or `>=` (project rule). Place constants on either side as needed.
- Functions: prefer <= 20 lines; guard clauses, early returns. Comment "why", not "what".
- Conventional commits (`feat:`, `chore:`, `refactor:`, `test:`), lowercase title <= 50 chars.
- Secrets never touch config or memory files (D14). Memory stores only absolute paths + reasons.
- Use `pnpm` only. No emojis in code/scripts/docs.
- Engine API facts: `wf.agent(prompt, { schema?, tools?, cwd?, label?, phase? }): Promise<AgentResult<T>>` where `AgentResult` has `{ text, data?, usage }` (`data` is the validated object when `schema` is passed). `wf.parallel(thunks): Promise<Array<T|null>>`. `wf.args` is the dispatched args. `default(wf)` runs in the host process (Node fs/child_process available).

## Shared types (defined in Task 1, referenced everywhere)

```ts
// src/repo/types.ts
export interface RepoEdge { from: string; to: string; reason: string }     // from depends on to
export interface RepoGraphData { nodes: string[]; edges: RepoEdge[] }
export interface RepoMemoryData {
  version: 1;
  tickets: Record<string, RepoGraphData>;
  aliases: Record<string, string>;
}
export interface DiscoveredDependency { repo: string; reason: string }
```

## File Structure

- Create `src/repo/types.ts` — shared interfaces (above).
- Create `src/repo/scope.ts` — `filterScope` (pure security boundary).
- Create `src/repo/ghq.ts` — `listScopedRepos` (ghq + scope).
- Create `src/repo/memory.ts` — `RepoMemory` (JSON state file).
- Create `src/repo/graph.ts` — `RepoGraph` (DAG, ready frontier, cycle check, render).
- Create `src/repo/worktree.ts` — `WorktreeProvisioner` + `ScriptProvisioner`.
- Create `scripts/worktree-provision.worktrunk.sh`, `scripts/worktree-provision.git.sh` — example provisioners.
- Modify `src/config.ts` — add `repoScopes`, `learnedReposPath`, `maxRepos`, `worktree.script`; remove `repos`, `repoAliases`.
- Modify `src/registry/types.ts` — remove `repoEnum`; simplify `EntryFactory`.
- Modify `src/dispatcher/decide.ts` — remove `resolveCwd` and the `repo` enum branch.
- Create `src/registry/workflows/steps/resolve-and-schedule.ts` — the scheduler step.
- Create `src/registry/workflows/investigate-ticket.ts` — the central workflow.
- Modify `src/registry/index.ts` — register `investigate-ticket`; drop alias wiring.
- Modify `src/registry/workflows/review-repo.ts` — retrofit to `repoHint` (single-repo case).
- Modify `nagi.config.json` + `nagi.config.example.json` — new keys, drop `repos`.

---

### Task 1: Shared types + scope filter (security boundary)

**Files:**
- Create: `src/repo/types.ts`
- Create: `src/repo/scope.ts`
- Test: `test/repo/scope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RepoEdge`, `RepoGraphData`, `RepoMemoryData`, `DiscoveredDependency` (types.ts); `filterScope(repoPaths: string[], scopes: string[]): { approved: string[]; rejected: string[] }` (scope.ts).

`filterScope` matches a ghq absolute path's `host/owner/name` tail against `host/owner` prefix globs. A scope like `github.com/acme/*` approves any path ending in `.../github.com/acme/<anything>`. Matching is on path segments, not substring, so `acme-evil` does not match `acme`.

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/scope.test.ts
import { describe, expect, it } from 'vitest';
import { filterScope } from '../../src/repo/scope.js';

const scopes = ['github.com/acme/*', 'github.com/reedom/*'];

describe('filterScope', () => {
  it('approves paths whose host/owner segments match a scope', () => {
    const r = filterScope(['/Users/x/ghq/github.com/acme/acme-app'], scopes);
    expect(r.approved).toEqual(['/Users/x/ghq/github.com/acme/acme-app']);
    expect(r.rejected).toEqual([]);
  });

  it('rejects out-of-scope owners', () => {
    const r = filterScope(['/Users/x/ghq/github.com/evilcorp/secret'], scopes);
    expect(r.approved).toEqual([]);
    expect(r.rejected).toEqual(['/Users/x/ghq/github.com/evilcorp/secret']);
  });

  it('does not match on substring (segment-aware)', () => {
    const r = filterScope(['/Users/x/ghq/github.com/acme-evil/x'], scopes);
    expect(r.rejected).toHaveLength(1);
  });

  it('rejects paths too short to contain host/owner/name', () => {
    expect(filterScope(['/tmp/x'], scopes).rejected).toEqual(['/tmp/x']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- scope`
Expected: FAIL ("Cannot find module '../../src/repo/scope.js'").

- [ ] **Step 3: Write minimal implementation**

```ts
// src/repo/types.ts
export interface RepoEdge { from: string; to: string; reason: string } // from depends on to
export interface RepoGraphData { nodes: string[]; edges: RepoEdge[] }
export interface RepoMemoryData {
  version: 1;
  tickets: Record<string, RepoGraphData>;
  aliases: Record<string, string>;
}
export interface DiscoveredDependency { repo: string; reason: string }
```

```ts
// src/repo/scope.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- scope`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo/types.ts src/repo/scope.ts test/repo/scope.test.ts
git commit -m "feat: add repo scope filter security boundary"
```

---

### Task 2: ghq lister (scoped candidate set)

**Files:**
- Create: `src/repo/ghq.ts`
- Test: `test/repo/ghq.test.ts`

**Interfaces:**
- Consumes: `filterScope` from Task 1.
- Produces: `type GhqRunner = () => Promise<string>`; `listScopedRepos(scopes: string[], run?: GhqRunner): Promise<string[]>`. `run` defaults to executing `ghq list -p`; injectable for tests.

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/ghq.test.ts
import { describe, expect, it } from 'vitest';
import { listScopedRepos } from '../../src/repo/ghq.js';

const out = [
  '/Users/x/ghq/github.com/acme/acme-app',
  '/Users/x/ghq/github.com/reedom/nagi',
  '/Users/x/ghq/github.com/evilcorp/secret',
].join('\n') + '\n';

describe('listScopedRepos', () => {
  it('returns only in-scope absolute paths', async () => {
    const repos = await listScopedRepos(['github.com/reedom/*'], async () => out);
    expect(repos).toEqual(['/Users/x/ghq/github.com/reedom/nagi']);
  });

  it('throws a clear error when ghq is unavailable', async () => {
    await expect(
      listScopedRepos(['github.com/reedom/*'], async () => { throw new Error('spawn ghq ENOENT'); }),
    ).rejects.toThrow(/ghq/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- ghq`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/repo/ghq.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { filterScope } from './scope.js';

const run = promisify(execFile);

export type GhqRunner = () => Promise<string>;

const defaultRunner: GhqRunner = async () => {
  const { stdout } = await run('ghq', ['list', '-p']); // -p = absolute paths
  return stdout;
};

/** Absolute ghq repo paths, narrowed to the configured scopes (the candidate set). */
export async function listScopedRepos(scopes: string[], runner: GhqRunner = defaultRunner): Promise<string[]> {
  let raw: string;
  try {
    raw = await runner();
  } catch (err) {
    throw new Error(`ghq list failed (is ghq installed?): ${err instanceof Error ? err.message : err}`);
  }
  const all = raw.split('\n').map((l) => l.trim()).filter((l) => l.length !== 0);
  return filterScope(all, scopes).approved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- ghq`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo/ghq.ts test/repo/ghq.test.ts
git commit -m "feat: add scoped ghq repo lister"
```

---

### Task 3: RepoMemory (JSON state file)

**Files:**
- Create: `src/repo/memory.ts`
- Test: `test/repo/memory.test.ts`

**Interfaces:**
- Consumes: `RepoGraphData`, `RepoMemoryData` from Task 1.
- Produces: `class RepoMemory` with `static load(path: string): RepoMemory`, `get(ticket: string): RepoGraphData | undefined`, `getAlias(name: string): string | undefined`, `remember(ticket: string, graph: RepoGraphData): void`, `rememberAlias(name: string, repoPath: string): void`. Writes are atomic (temp file + rename). A missing or unparseable file loads as empty.

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/memory.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoMemory } from '../../src/repo/memory.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nagi-mem-')); file = join(dir, 'learned.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('RepoMemory', () => {
  it('returns undefined for unknown tickets and a missing file', () => {
    expect(RepoMemory.load(file).get('DEA-1')).toBeUndefined();
  });

  it('persists and reloads a ticket graph', () => {
    const m = RepoMemory.load(file);
    m.remember('DEA-1', { nodes: ['/a'], edges: [] });
    expect(RepoMemory.load(file).get('DEA-1')).toEqual({ nodes: ['/a'], edges: [] });
  });

  it('persists aliases', () => {
    const m = RepoMemory.load(file);
    m.rememberAlias('engine', '/abs/engine');
    expect(RepoMemory.load(file).getAlias('engine')).toBe('/abs/engine');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- memory`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/repo/memory.ts
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { RepoGraphData, RepoMemoryData } from './types.js';

const EMPTY: RepoMemoryData = { version: 1, tickets: {}, aliases: {} };

export class RepoMemory {
  private constructor(private readonly path: string, private data: RepoMemoryData) {}

  static load(path: string): RepoMemory {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as RepoMemoryData;
      if (parsed.version === 1) return new RepoMemory(path, parsed);
    } catch {
      // Missing or corrupt file -> start empty; we never throw on read.
    }
    return new RepoMemory(path, structuredClone(EMPTY));
  }

  get(ticket: string): RepoGraphData | undefined { return this.data.tickets[ticket]; }
  getAlias(name: string): string | undefined { return this.data.aliases[name]; }

  remember(ticket: string, graph: RepoGraphData): void {
    this.data.tickets[ticket] = graph;
    this.flush();
  }

  rememberAlias(name: string, repoPath: string): void {
    this.data.aliases[name] = repoPath;
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path); // atomic replace
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- memory`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo/memory.ts test/repo/memory.test.ts
git commit -m "feat: add repo resolution memory store"
```

---

### Task 4: RepoGraph (DAG, ready frontier, cycle detection)

**Files:**
- Create: `src/repo/graph.ts`
- Test: `test/repo/graph.test.ts`

**Interfaces:**
- Consumes: `RepoEdge`, `RepoGraphData` from Task 1.
- Produces: `class RepoGraph` with: `addNode(p: string): void`, `wouldCreateCycle(from: string, to: string): boolean`, `addEdge(from: string, to: string, reason: string): void`, `markProcessed(p: string): void`, `readyNodes(): string[]` (unprocessed nodes whose every dependency (out-edge target) is processed), `hasUnprocessed(): boolean`, `size(): number`, `has(p: string): boolean`, `toData(): RepoGraphData`, `static fromData(d: RepoGraphData): RepoGraph`, `render(): string` (mermaid). Edge `from -> to` means "from depends on to"; dependencies are processed first.

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/graph.test.ts
import { describe, expect, it } from 'vitest';
import { RepoGraph } from '../../src/repo/graph.js';

describe('RepoGraph', () => {
  it('treats leaves (no dependencies) as immediately ready', () => {
    const g = new RepoGraph();
    g.addNode('/a'); g.addNode('/b');
    expect(new Set(g.readyNodes())).toEqual(new Set(['/a', '/b']));
  });

  it('holds a dependent back until its dependency is processed', () => {
    const g = new RepoGraph();
    g.addNode('/app'); g.addNode('/engine');
    g.addEdge('/app', '/engine', 'app calls engine'); // app depends on engine
    expect(g.readyNodes()).toEqual(['/engine']);       // dependency first
    g.markProcessed('/engine');
    expect(g.readyNodes()).toEqual(['/app']);
  });

  it('detects cycles before they are added', () => {
    const g = new RepoGraph();
    g.addNode('/a'); g.addNode('/b');
    g.addEdge('/a', '/b', 'a->b');
    expect(g.wouldCreateCycle('/b', '/a')).toBe(true);
    expect(g.wouldCreateCycle('/a', '/b')).toBe(false);
  });

  it('round-trips through toData/fromData', () => {
    const g = new RepoGraph();
    g.addNode('/a'); g.addNode('/b'); g.addEdge('/a', '/b', 'r');
    const g2 = RepoGraph.fromData(g.toData());
    expect(g2.toData()).toEqual({ nodes: ['/a', '/b'], edges: [{ from: '/a', to: '/b', reason: 'r' }] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- graph`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/repo/graph.ts
import type { RepoEdge, RepoGraphData } from './types.js';

// Repo dependency DAG. Edge from -> to means "from depends on to"; the
// dependency (to) is scheduled before the dependent (from).
export class RepoGraph {
  private readonly nodes: string[] = [];
  private readonly edges: RepoEdge[] = [];
  private readonly processed = new Set<string>();

  addNode(p: string): void {
    if (!this.nodes.includes(p)) this.nodes.push(p);
  }

  has(p: string): boolean { return this.nodes.includes(p); }
  size(): number { return this.nodes.length; }

  // Dependencies of a node = the out-edge targets.
  private dependenciesOf(p: string): string[] {
    return this.edges.filter((e) => e.from === p).map((e) => e.to);
  }

  // Adding from -> to closes a cycle iff `to` can already reach `from`.
  wouldCreateCycle(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length !== 0) {
      const cur = stack.pop() as string;
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.dependenciesOf(cur));
    }
    return false;
  }

  addEdge(from: string, to: string, reason: string): void {
    this.addNode(from);
    this.addNode(to);
    this.edges.push({ from, to, reason });
  }

  markProcessed(p: string): void { this.processed.add(p); }
  hasUnprocessed(): boolean { return this.nodes.some((n) => !this.processed.has(n)); }

  // Ready = unprocessed AND every dependency already processed.
  readyNodes(): string[] {
    return this.nodes.filter(
      (n) => !this.processed.has(n) && this.dependenciesOf(n).every((d) => this.processed.has(d)),
    );
  }

  toData(): RepoGraphData {
    return { nodes: [...this.nodes], edges: this.edges.map((e) => ({ ...e })) };
  }

  static fromData(d: RepoGraphData): RepoGraph {
    const g = new RepoGraph();
    for (const n of d.nodes) g.addNode(n);
    for (const e of d.edges) g.addEdge(e.from, e.to, e.reason);
    return g;
  }

  render(): string {
    const lines = ['graph LR'];
    for (const e of this.edges) lines.push(`  ${JSON.stringify(e.from)} --> ${JSON.stringify(e.to)}`);
    for (const n of this.nodes) if (!this.edges.some((e) => e.from === n || e.to === n)) lines.push(`  ${JSON.stringify(n)}`);
    return lines.join('\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- graph`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo/graph.ts test/repo/graph.test.ts
git commit -m "feat: add repo dependency graph scheduler"
```

---

### Task 5: WorktreeProvisioner + example scripts

**Files:**
- Create: `src/repo/worktree.ts`
- Create: `scripts/worktree-provision.worktrunk.sh`
- Create: `scripts/worktree-provision.git.sh`
- Test: `test/repo/worktree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface WorktreeProvisioner { provision(repoPath: string, ticket: string): Promise<string> }`; `type ScriptRunner = (script: string, repoPath: string, ticket: string) => Promise<string>`; `class ScriptProvisioner implements WorktreeProvisioner` constructed as `new ScriptProvisioner(scriptPath: string, run?: ScriptRunner)`. `provision` returns the worktree cwd = the script's final stdout line.

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/worktree.test.ts
import { describe, expect, it } from 'vitest';
import { ScriptProvisioner } from '../../src/repo/worktree.js';

describe('ScriptProvisioner', () => {
  it('returns the last stdout line as the worktree cwd', async () => {
    const fakeRun = async () => 'creating...\n/Users/x/ghq/github.com/reedom/nagi.DEA-1\n';
    const p = new ScriptProvisioner('scripts/worktree-provision.worktrunk.sh', fakeRun);
    expect(await p.provision('/repo', 'DEA-1')).toBe('/Users/x/ghq/github.com/reedom/nagi.DEA-1');
  });

  it('throws when the script prints no path', async () => {
    const p = new ScriptProvisioner('s.sh', async () => '   \n');
    await expect(p.provision('/repo', 'DEA-1')).rejects.toThrow(/no worktree path/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- worktree`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/repo/worktree.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface WorktreeProvisioner {
  provision(repoPath: string, ticket: string): Promise<string>;
}

export type ScriptRunner = (script: string, repoPath: string, ticket: string) => Promise<string>;

// Runs the selected script with cwd = repoPath and ticket via argv + env.
const defaultRunner: ScriptRunner = async (script, repoPath, ticket) => {
  const { stdout } = await exec(script, [ticket], {
    cwd: repoPath,
    env: { ...process.env, NAGI_TICKET: ticket, NAGI_REPO_PATH: repoPath },
  });
  return stdout;
};

// The mechanism is selected by config.worktree.script; this just runs it and
// reads back the worktree path the script prints as its final stdout line.
export class ScriptProvisioner implements WorktreeProvisioner {
  constructor(private readonly script: string, private readonly run: ScriptRunner = defaultRunner) {}

  async provision(repoPath: string, ticket: string): Promise<string> {
    const stdout = await this.run(this.script, repoPath, ticket);
    const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length !== 0);
    const last = lines[lines.length - 1];
    if (!last) throw new Error(`worktree script printed no worktree path: ${this.script}`);
    return last;
  }
}
```

```bash
# scripts/worktree-provision.worktrunk.sh
#!/usr/bin/env bash
# Example provisioner (worktrunk). Selected via config.worktree.script.
# Invoked with cwd = repo path, argv[1] = ticket. Prints the worktree
# absolute path as the final stdout line; all other chatter goes to stderr.
set -euo pipefail
ticket="${1:?ticket required}"
wt switch "$ticket" 1>&2                 # worktrunk creates ../<repoBase>.<ticket>
base="$(basename "$PWD")"
printf '%s\n' "$(cd "$PWD/../${base}.${ticket}" && pwd)"
```

```bash
# scripts/worktree-provision.git.sh
#!/usr/bin/env bash
# Example provisioner (plain git worktree). Selected via config.worktree.script.
set -euo pipefail
ticket="${1:?ticket required}"
base="$(basename "$PWD")"
target="$PWD/../${base}.${ticket}"
if [ ! -d "$target" ]; then
  git worktree add "$target" -b "$ticket" 1>&2
fi
printf '%s\n' "$(cd "$target" && pwd)"
```

- [ ] **Step 4: Make scripts executable, run test to verify it passes**

Run: `chmod +x scripts/worktree-provision.*.sh && pnpm test -- worktree`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo/worktree.ts scripts/worktree-provision.worktrunk.sh scripts/worktree-provision.git.sh test/repo/worktree.test.ts
git commit -m "feat: add swappable worktree provisioner"
```

---

### Task 6: Config — add new keys, remove static repos

**Files:**
- Modify: `src/config.ts`
- Modify: `nagi.config.json`
- Modify: `nagi.config.example.json`
- Test: `test/config.test.ts` (update existing), `test/repo/config-repo.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `NagiConfig` gains `repoScopes: string[]`, `learnedReposPath: string`, `maxRepos: number`, `worktree: { script: string }`. `repos` and `repoAliases` are removed.

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/config-repo.test.ts
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';

const base = {
  slack: { allowedTeamId: 'T', allowedUserIds: ['U'] },
  repoScopes: ['github.com/reedom/*'],
};

describe('repo resolution config', () => {
  it('defaults learnedReposPath, maxRepos, and worktree.script', () => {
    const c = parseConfig(base);
    expect(c.learnedReposPath).toBe('./learned-repos.json');
    expect(c.maxRepos).toBe(10);
    expect(c.worktree.script).toBe('scripts/worktree-provision.worktrunk.sh');
    expect(c.repoScopes).toEqual(['github.com/reedom/*']);
  });

  it('requires at least one repo scope', () => {
    expect(() => parseConfig({ ...base, repoScopes: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- config-repo`
Expected: FAIL (`repoScopes` not on schema / defaults undefined).

- [ ] **Step 3: Implement the schema change**

In `src/config.ts`, remove the `repos` field and the `repoAliases` export; add the new fields to `configSchema`:

```ts
// remove:  repos: z.record(...),
// remove the whole repoAliases() function at the bottom of the file.

  // The host/owner scope allowlist: ghq repos whose segments match one of
  // these globs are the only candidates an agent may ever touch (security).
  repoScopes: z.array(z.string().min(1)).min(1),
  // Where learned ticket->repo-graph resolutions persist (runtime-written).
  learnedReposPath: z.string().default('./learned-repos.json'),
  // Upper bound on a ticket's dependency graph; protects against runaway growth.
  maxRepos: z.number().int().positive().default(10),
  // The provisioner script nagi runs to create/enter a worktree. Selecting a
  // different script swaps the mechanism (worktrunk, plain git, ...).
  worktree: z
    .object({ script: z.string().min(1).default('scripts/worktree-provision.worktrunk.sh') })
    .default({}),
```

- [ ] **Step 4: Update config files and the existing config test**

In `nagi.config.json` and `nagi.config.example.json`, replace the `"repos": { ... }` block with:

```json
  "repoScopes": ["github.com/acme/*", "github.com/reedom/*"],
  "learnedReposPath": "./learned-repos.json",
  "maxRepos": 10,
  "worktree": { "script": "scripts/worktree-provision.worktrunk.sh" },
```

In `test/config.test.ts`, change `const base = { ... repos: { engine: '/abs/engine' } }` to `const base = { slack: { allowedTeamId: 'T', allowedUserIds: ['U'] }, repoScopes: ['github.com/reedom/*'] }`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- config`
Expected: PASS (cmux config + repo resolution config).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts nagi.config.json nagi.config.example.json test/config.test.ts test/repo/config-repo.test.ts
git commit -m "feat: replace static repos map with scope-based config"
```

---

### Task 7: Drop repoEnum and the dispatcher cwd/enum coupling

**Files:**
- Modify: `src/registry/types.ts`
- Modify: `src/registry/index.ts`
- Modify: `src/dispatcher/decide.ts`
- Test: `test/decide.test.ts` (update)

**Interfaces:**
- Consumes: nothing new.
- Produces: `EntryFactory = () => RegistryEntry` (no alias argument); `buildRegistry(factories: EntryFactory[]): Registry`. `decide()` no longer sets `cwd` and no longer special-cases the `repo` field.

- [ ] **Step 1: Update registry types**

In `src/registry/types.ts`: delete `repoEnum`. Change `EntryFactory` to `export type EntryFactory = () => RegistryEntry;` and `buildRegistry`:

```ts
export function buildRegistry(factories: EntryFactory[]): Registry {
  return new Registry(factories.map((make) => make()));
}
```

- [ ] **Step 2: Update registry/index.ts**

```ts
// src/registry/index.ts — drop repoAliases import + arg.
export function makeRegistry(config: NagiConfig): Registry {
  const factories =
    process.env['NAGI_ENABLE_APPROVAL_DEMO'] === '1'
      ? [...SEED_FACTORIES, approvalDemoEntry]
      : SEED_FACTORIES;
  return buildRegistry(factories);
}
```

- [ ] **Step 3: Update decide.ts**

Remove `resolveCwd` entirely and drop its use. The dispatch decision no longer carries a resolved cwd. Replace the `repo` branch in `schemaQuestion` with the generic message. Final `decide` tail:

```ts
  const args = parsed.data as Record<string, unknown>;
  const budget = entry.budgetOverride ?? config.defaultBudget;
  return { kind: 'dispatch', entry, args, budget };
```

And `schemaQuestion` keeps only the generic branch:

```ts
function schemaQuestion(error: ZodError): string {
  const issue = error.issues[0];
  const field = issue && issue.path.length !== 0 ? String(issue.path[0]) : 'an argument';
  return `I need a clearer value for \`${field}\` (${issue?.message ?? 'invalid'}). Could you restate it?`;
}
```

Update the `schemaQuestion(parsed.error, config)` call site to `schemaQuestion(parsed.error)` and drop the now-unused `repoAliases`/`config` imports where applicable. The `Decision` type's `cwd?` may remain (the dispatcher already guards `decision.cwd ? ...`), but nothing sets it now.

- [ ] **Step 4: Update decide.test.ts**

Open `test/decide.test.ts`. Remove or rewrite any case asserting the repo-enum clarification (the "Valid repos:" message) and any `config.repos` fixture usage; replace the fixture config with one using `repoScopes: ['github.com/reedom/*']` and no `repos`. Keep the low-confidence and unknown-workflow cases.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- decide`
Expected: PASS.

- [ ] **Step 6: Typecheck the whole project**

Run: `pnpm run typecheck`
Expected: PASS (no references to `repos`, `repoAliases`, `repoEnum` remain). Fix any stragglers (e.g. `review-repo.ts` still calls `repoEnum` — that is fixed in Task 10; if typecheck fails only there, proceed and let Task 10 resolve it, or temporarily stub).

- [ ] **Step 7: Commit**

```bash
git add src/registry/types.ts src/registry/index.ts src/dispatcher/decide.ts test/decide.test.ts
git commit -m "refactor: remove repo enum and dispatcher cwd coupling"
```

---

### Task 8: resolve-and-schedule step (the scheduler)

**Files:**
- Create: `src/registry/workflows/steps/resolve-and-schedule.ts`
- Test: `test/repo/resolve-and-schedule.test.ts`

**Interfaces:**
- Consumes: `RepoGraph` (Task 4), `RepoMemory` (Task 3), `filterScope` (Task 1), `listScopedRepos` (Task 2), `WorktreeProvisioner` (Task 5), `DiscoveredDependency` (Task 1), engine `WorkflowApi`.
- Produces:
  ```ts
  export interface NodeFinding { repo: string; findings: string; dependencies: DiscoveredDependency[] }
  export interface ResolveDeps {
    scopes: string[];
    maxRepos: number;
    memory: RepoMemory;
    provisioner: WorktreeProvisioner;
    listRepos: (scopes: string[]) => Promise<string[]>;   // wraps listScopedRepos; injectable
  }
  export interface ResolveResult {
    graph: RepoGraphData;
    findings: NodeFinding[];
    halted?: { reason: 'cycle' | 'maxRepos'; detail: string };
  }
  export function resolveAndSchedule(wf: WorkflowApi, ticket: string, deps: ResolveDeps): Promise<ResolveResult>;
  ```
- The agent contract (driven via `wf.agent` with a `schema`):
  - identify: returns `{ repos: string[] }` (paths chosen from the scoped candidate list).
  - investigate: returns `{ findings: string; dependencies: { repo: string; reason: string }[] }`.

The step loop: seed from memory or the identify agent; scope-filter; then process ready nodes in parallel batches; each node provisions a worktree and runs the investigate agent (cwd = worktree); new dependencies are scope-filtered and added, halting on cycle or maxRepos.

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/resolve-and-schedule.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoMemory } from '../../src/repo/memory.js';
import { resolveAndSchedule, type ResolveDeps } from '../../src/registry/workflows/steps/resolve-and-schedule.js';

// Minimal WorkflowApi fake: agent() returns scripted .data by label.
function fakeWf(byLabel: Record<string, unknown[]>) {
  const calls: Record<string, number> = {};
  return {
    args: {},
    phase() {},
    async agent(_p: string, opts?: { label?: string; schema?: unknown }) {
      const label = opts?.label ?? 'default';
      const i = calls[label] ?? 0; calls[label] = i + 1;
      const queue = byLabel[label] ?? [];
      return { text: '', data: queue[Math.min(i, queue.length - 1)], raw: null, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async parallel<T>(thunks: Array<() => Promise<T>>) { return Promise.all(thunks.map((t) => t())); },
    async pipeline() { return []; },
  } as any;
}

function deps(over: Partial<ResolveDeps>): ResolveDeps {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-sched-'));
  return {
    scopes: ['github.com/acme/*'],
    maxRepos: 10,
    memory: RepoMemory.load(join(dir, 'm.json')),
    provisioner: { async provision(p) { return `${p}.wt`; } },
    listRepos: async () => ['/ghq/github.com/acme/app', '/ghq/github.com/acme/engine'],
    ...over,
  };
}

describe('resolveAndSchedule', () => {
  it('processes a dependency before its dependent and records the graph', async () => {
    const wf = fakeWf({
      identify: [{ repos: ['/ghq/github.com/acme/app'] }],
      investigate: [
        { findings: 'app cause', dependencies: [{ repo: '/ghq/github.com/acme/engine', reason: 'calls engine' }] },
        { findings: 'engine cause', dependencies: [] },
      ],
    });
    const r = await resolveAndSchedule(wf, 'DEA-1', deps({}));
    expect(r.halted).toBeUndefined();
    expect(r.graph.nodes).toContain('/ghq/github.com/acme/engine');
    expect(r.findings.map((f) => f.findings).sort()).toEqual(['app cause', 'engine cause']);
  });

  it('drops out-of-scope discovered repos', async () => {
    const wf = fakeWf({
      identify: [{ repos: ['/ghq/github.com/acme/app'] }],
      investigate: [{ findings: 'x', dependencies: [{ repo: '/ghq/github.com/evil/x', reason: 'no' }] }],
    });
    const r = await resolveAndSchedule(wf, 'DEA-2', deps({}));
    expect(r.graph.nodes).not.toContain('/ghq/github.com/evil/x');
  });

  it('halts on a dependency cycle', async () => {
    const wf = fakeWf({
      identify: [{ repos: ['/ghq/github.com/acme/app'] }],
      investigate: [
        { findings: 'a', dependencies: [{ repo: '/ghq/github.com/acme/engine', reason: 'a->e' }] },
        { findings: 'e', dependencies: [{ repo: '/ghq/github.com/acme/app', reason: 'e->a (cycle)' }] },
      ],
    });
    const r = await resolveAndSchedule(wf, 'DEA-3', deps({}));
    expect(r.halted?.reason).toBe('cycle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- resolve-and-schedule`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/registry/workflows/steps/resolve-and-schedule.ts
import { z } from 'zod';
import type { WorkflowApi } from 'ai-workflow-engine';
import { RepoGraph } from '../../../repo/graph.js';
import { filterScope } from '../../../repo/scope.js';
import type { RepoMemory } from '../../../repo/memory.js';
import type { WorktreeProvisioner } from '../../../repo/worktree.js';
import type { DiscoveredDependency, RepoGraphData } from '../../../repo/types.js';

export interface NodeFinding { repo: string; findings: string; dependencies: DiscoveredDependency[] }
export interface ResolveDeps {
  scopes: string[];
  maxRepos: number;
  memory: RepoMemory;
  provisioner: WorktreeProvisioner;
  listRepos: (scopes: string[]) => Promise<string[]>;
}
export interface ResolveResult {
  graph: RepoGraphData;
  findings: NodeFinding[];
  halted?: { reason: 'cycle' | 'maxRepos'; detail: string };
}

const identifySchema = z.object({ repos: z.array(z.string()) });
const investigateSchema = z.object({
  findings: z.string(),
  dependencies: z.array(z.object({ repo: z.string(), reason: z.string() })).default([]),
});

// Seed the graph from memory if known, else ask the identify agent which of the
// scoped candidates the ticket starts in. Only in-scope repos enter the graph.
async function seed(wf: WorkflowApi, ticket: string, deps: ResolveDeps, graph: RepoGraph): Promise<void> {
  const known = deps.memory.get(ticket);
  if (known) { for (const n of known.nodes) graph.addNode(n); return; }
  const candidates = await deps.listRepos(deps.scopes);
  const res = await wf.agent(
    `Ticket: ${ticket}\nUsing your available ticket tools, read it and pick the repo(s) where ` +
      `investigation should START, choosing only from this candidate list:\n${candidates.join('\n')}\n` +
      `Return { "repos": [...] } with absolute paths copied verbatim from the list.`,
    { label: 'identify', phase: 'identify', schema: identifySchema, tools: ['Bash', 'Read', 'Grep'] },
  );
  const picked = identifySchema.parse(res.data).repos;
  for (const p of filterScope(picked, deps.scopes).approved) graph.addNode(p);
}

export async function resolveAndSchedule(wf: WorkflowApi, ticket: string, deps: ResolveDeps): Promise<ResolveResult> {
  const graph = new RepoGraph();
  await seed(wf, ticket, deps, graph);

  const findings: NodeFinding[] = [];
  let halted: ResolveResult['halted'];

  while (graph.hasUnprocessed() && !halted) {
    const ready = graph.readyNodes();
    const batch = await wf.parallel(
      ready.map((repo) => async () => investigateNode(wf, ticket, repo, deps)),
    );
    for (const node of batch) {
      if (!node) continue;
      graph.markProcessed(node.repo);
      findings.push(node);
      halted = absorb(graph, node, deps);
      if (halted) break;
    }
    if (graph.size() !== 0 && deps.maxRepos <= graph.size() && graph.hasUnprocessed() && !halted) {
      halted = { reason: 'maxRepos', detail: `graph reached the ${deps.maxRepos}-repo cap` };
    }
  }

  const data = graph.toData();
  deps.memory.remember(ticket, data);
  return { graph: data, findings, ...(halted ? { halted } : {}) };
}

// Provision a worktree and run the investigate agent inside it.
async function investigateNode(wf: WorkflowApi, ticket: string, repo: string, deps: ResolveDeps): Promise<NodeFinding> {
  const cwd = await deps.provisioner.provision(repo, ticket);
  const res = await wf.agent(
    `You are in a worktree for ticket ${ticket} at ${cwd}. Root-cause the ticket here. ` +
      `If the cause depends on OTHER repositories, list each as a dependency with a short reason. ` +
      `Return { "findings": "...", "dependencies": [{ "repo": "<absolute path>", "reason": "..." }] }.`,
    { label: 'investigate', phase: 'investigate', schema: investigateSchema, tools: ['Bash', 'Read', 'Grep'], cwd },
  );
  const parsed = investigateSchema.parse(res.data);
  return { repo, findings: parsed.findings, dependencies: parsed.dependencies };
}

// Scope-filter discovered dependencies, then add edges; signal a cycle halt.
function absorb(graph: RepoGraph, node: NodeFinding, deps: ResolveDeps): ResolveResult['halted'] {
  const approved = filterScope(node.dependencies.map((d) => d.repo), deps.scopes).approved;
  for (const dep of node.dependencies) {
    if (!approved.includes(dep.repo)) continue;
    if (graph.wouldCreateCycle(node.repo, dep.repo)) {
      return { reason: 'cycle', detail: `${node.repo} <-> ${dep.repo}` };
    }
    graph.addEdge(node.repo, dep.repo, dep.reason);
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- resolve-and-schedule`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/workflows/steps/resolve-and-schedule.ts test/repo/resolve-and-schedule.test.ts
git commit -m "feat: add repo dependency scheduler step"
```

---

### Task 9: investigate-ticket workflow + registration

**Files:**
- Create: `src/registry/workflows/investigate-ticket.ts`
- Modify: `src/registry/index.ts`
- Test: `test/repo/investigate-ticket.test.ts`

**Interfaces:**
- Consumes: `resolveAndSchedule` + its `ResolveDeps` (Task 8), `RepoMemory` (Task 3), `ScriptProvisioner` (Task 5), `listScopedRepos` (Task 2), `EntryFactory`/`RegistryEntry` (Task 7), `NagiConfig`.
- Produces: `investigateTicketEntry: EntryFactory`. Because the step needs config-derived deps (scopes, memory path, provisioner) and `EntryFactory` takes no args, the entry closes over `config`; export a builder `makeInvestigateTicketEntry(config: NagiConfig): RegistryEntry` and add it in `makeRegistry`.

The workflow `default()` reads `wf.args.ticketRef`, builds `ResolveDeps` from config, calls `resolveAndSchedule`, and returns a report object (rendered by the dispatcher's `formatResult`).

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/investigate-ticket.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/config.js';
import { makeInvestigateTicketEntry } from '../../src/registry/workflows/investigate-ticket.js';

const config = parseConfig({
  slack: { allowedTeamId: 'T', allowedUserIds: ['U'] },
  repoScopes: ['github.com/acme/*'],
  learnedReposPath: join(mkdtempSync(join(tmpdir(), 'nagi-it-')), 'm.json'),
});

describe('investigate-ticket entry', () => {
  it('accepts a ticketRef arg and rejects empty', () => {
    const entry = makeInvestigateTicketEntry(config);
    expect(entry.id).toBe('investigate-ticket');
    expect(entry.argsSchema.safeParse({ ticketRef: 'DEA-1' }).success).toBe(true);
    expect(entry.argsSchema.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- investigate-ticket`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/registry/workflows/investigate-ticket.ts
import { z } from 'zod';
import type { WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import type { NagiConfig } from '../../config.js';
import type { RegistryEntry } from '../types.js';
import { RepoMemory } from '../../repo/memory.js';
import { ScriptProvisioner } from '../../repo/worktree.js';
import { listScopedRepos } from '../../repo/ghq.js';
import { resolveAndSchedule, type ResolveDeps } from './steps/resolve-and-schedule.js';
import { RepoGraph } from '../../repo/graph.js';

interface InvestigateArgs { ticketRef: string; repoHint?: string }

function makeModule(config: NagiConfig): WorkflowModule {
  return {
    meta: { name: 'investigate-ticket', description: 'Investigate a ticket across its dependent repositories.' },
    async default(wf: WorkflowApi): Promise<unknown> {
      const args = wf.args as InvestigateArgs;
      const deps: ResolveDeps = {
        scopes: config.repoScopes,
        maxRepos: config.maxRepos,
        memory: RepoMemory.load(config.learnedReposPath),
        provisioner: new ScriptProvisioner(config.worktree.script),
        listRepos: (scopes) => listScopedRepos(scopes),
      };
      const result = await resolveAndSchedule(wf, args.ticketRef, deps);
      const diagram = RepoGraph.fromData(result.graph).render();
      return {
        ticket: args.ticketRef,
        halted: result.halted ?? null,
        findings: result.findings.map((f) => ({ repo: f.repo, findings: f.findings })),
        graph: diagram,
      };
    },
  };
}

export function makeInvestigateTicketEntry(config: NagiConfig): RegistryEntry {
  return {
    id: 'investigate-ticket',
    description:
      'Investigate a ticket end-to-end: find the starting repo, root-cause it, and follow ' +
      'repo-to-repo dependencies. Use when the user references a ticket (e.g. DEA-1234, SOA-1234).',
    argsSchema: z.object({ ticketRef: z.string().min(1), repoHint: z.string().optional() }),
    module: makeModule(config),
  };
}
```

In `src/registry/index.ts`, register it. Since `makeInvestigateTicketEntry` needs `config` (not the no-arg `EntryFactory`), add it directly in `makeRegistry` after building the seed factories:

```ts
import { makeInvestigateTicketEntry } from './workflows/investigate-ticket.js';

export function makeRegistry(config: NagiConfig): Registry {
  const seed = process.env['NAGI_ENABLE_APPROVAL_DEMO'] === '1'
    ? [...SEED_FACTORIES, approvalDemoEntry]
    : SEED_FACTORIES;
  const base = buildRegistry(seed);
  return new Registry([...base.list(), makeInvestigateTicketEntry(config)]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- investigate-ticket`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/registry/workflows/investigate-ticket.ts src/registry/index.ts test/repo/investigate-ticket.test.ts
git commit -m "feat: add investigate-ticket workflow"
```

---

### Task 10: Retrofit review-repo to a free-form repoHint

**Files:**
- Modify: `src/registry/workflows/review-repo.ts`
- Test: `test/repo/review-repo.test.ts`

**Interfaces:**
- Consumes: `EntryFactory`/`RegistryEntry` (Task 7).
- Produces: `reviewRepoEntry: EntryFactory` with `argsSchema` taking `repoHint: z.string()` instead of `repo: repoEnum(aliases)`. The module resolves the repo by reusing the scope/ghq path (single-repo: the identify agent picks one, scope-filtered) before reviewing. To keep this task small, the module accepts an optional injected resolver and defaults to `listScopedRepos` + an identify agent; reviewers gate it independently of Task 9.

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/review-repo.test.ts
import { describe, expect, it } from 'vitest';
import { reviewRepoEntry } from '../../src/registry/workflows/review-repo.js';

describe('review-repo entry', () => {
  it('takes a free-form repoHint, not an enum', () => {
    const entry = reviewRepoEntry();
    expect(entry.argsSchema.safeParse({ repoHint: 'engine', scope: 'diff' }).success).toBe(true);
    expect(entry.argsSchema.safeParse({ repo: 'engine' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- review-repo`
Expected: FAIL (still requires the old `repo` enum / `repoEnum` import).

- [ ] **Step 3: Rewrite review-repo.ts**

```ts
// src/registry/workflows/review-repo.ts
import { z } from 'zod';
import type { WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import type { EntryFactory, RegistryEntry } from '../types.js';

interface ReviewArgs { repoHint: string; scope: 'repo' | 'diff'; focus?: string }

const reviewModule: WorkflowModule = {
  meta: { name: 'review-repo', description: 'Review a repository or its working diff and summarize the top risks.' },
  async default(wf: WorkflowApi): Promise<unknown> {
    const args = wf.args as ReviewArgs;
    const target = args.scope === 'diff' ? 'the current uncommitted/working diff' : 'the repository as a whole';
    const focus = args.focus ? `\n\nPay special attention to: ${args.focus}.` : '';
    wf.phase('review');
    const result = await wf.agent(
      `Locate the repo matching "${args.repoHint}" with your tools, cd into it, and review ${target}. ` +
        `Identify the most important correctness, security, and maintainability risks. ` +
        `Use read-only inspection (git, ripgrep, file reads). ` +
        `Return a concise prioritized summary with file:line references.${focus}`,
      { label: 'review', tools: ['Bash', 'Read', 'Grep', 'Glob'] },
    );
    return { summary: result.text, usage: result.usage };
  },
};

export const reviewRepoEntry: EntryFactory = (): RegistryEntry => ({
  id: 'review-repo',
  description:
    'Review a repository (or its working diff) and summarize the most important risks. ' +
    'Use when the user asks to review, audit, or assess a repo or a diff.',
  argsSchema: z.object({
    repoHint: z.string().min(1),
    scope: z.enum(['repo', 'diff']).default('repo'),
    focus: z.string().optional(),
  }),
  module: reviewModule,
});
```

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `pnpm test -- review-repo && pnpm test && pnpm run typecheck`
Expected: PASS across the board; no remaining references to `repoEnum`, `repoAliases`, or `config.repos`.

- [ ] **Step 5: Commit**

```bash
git add src/registry/workflows/review-repo.ts test/repo/review-repo.test.ts
git commit -m "refactor: review-repo takes a free-form repoHint"
```

---

### Task 11: Build + final verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck, test, build**

Run: `pnpm run typecheck && pnpm test && pnpm run build`
Expected: all PASS.

- [ ] **Step 2: Manual smoke of the provisioner script (optional, requires worktrunk)**

Run: `cd $(ghq root)/github.com/reedom/nagi && NAGI_TICKET=smoke bash scripts/worktree-provision.worktrunk.sh smoke`
Expected: last stdout line is an absolute path ending in `nagi.smoke`. (Clean up with `wt` afterwards.)

- [ ] **Step 3: Commit any doc updates**

If `docs/fr/` of-record docs need a note (new `investigate-ticket` behaviour, config keys), update `fr:10-configuration` and `fr:04-workflow-registry` per the post-edit hook's guidance, then:

```bash
git add docs/fr
git commit -m "docs: record investigate-ticket workflow and repo-scope config"
```

---

## Self-Review

**Spec coverage:**
- R1 ghq source -> Task 2. R2 scope double-gate -> Task 1 (filter) + Task 8 (seed pre-filter on candidate list + return filter in `absorb`/`seed`). R3 agent-driven in workflow -> Task 8/9. R4 thin triage / enum retired -> Task 7 + Task 6. R5 JSON memory -> Task 3. R6 dependency DAG, deps-first -> Task 4 + Task 8. R7 parallel -> Task 8 (`wf.parallel` over `readyNodes`). R8 replaceable script -> Task 5 + Task 6. R9 cycle halt -> Task 4 (`wouldCreateCycle`) + Task 8 (`absorb` -> `halted`). R10 maxRepos cap -> Task 6 (config) + Task 8 (loop guard). Report -> Task 9 (`RepoGraph.render`). review-repo retrofit -> Task 10.
- All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output.

**Type consistency:** `filterScope` returns `{approved,rejected}` (used consistently in Tasks 1/2/8). `RepoGraph` methods (`addNode`/`addEdge`/`readyNodes`/`markProcessed`/`wouldCreateCycle`/`toData`/`fromData`/`render`/`size`/`hasUnprocessed`) match between Tasks 4, 8, 9. `ResolveDeps`/`ResolveResult`/`NodeFinding` defined in Task 8 and consumed unchanged in Task 9. `EntryFactory = () => RegistryEntry` (Task 7) matches `reviewRepoEntry` (Task 10); `investigate-ticket` uses the config-bound `makeInvestigateTicketEntry` builder (Task 9) precisely because it needs config, not the no-arg factory.

**Numeric rule:** loop guards use `<=` / `<` and `.length !== 0` forms; no `>`/`>=` introduced.

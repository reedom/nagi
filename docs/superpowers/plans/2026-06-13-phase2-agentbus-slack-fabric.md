# Phase 2 — agentbus↔Slack fabric + surfaced worker leaf — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase 1 `agent-surface-adapters` cmux adapter into nagi end-to-end — a concurrent surfaced lane where a Slack request opens an interactive `claude` on a cmux surface, and its progress / tool-approvals / result flow back to the originating Slack thread over agentbus.

**Architecture:** nagi becomes the substrate. A single `agentbus watch nagi` consumer feeds a multi-run bridge that maps each `runId` to its Slack thread and routes `progress`→thread post, `approval`(ask)→the existing Slack approval UI→`agentbus reply`, `result`→resolve. Surfaced runs are dispatched **concurrently** (they bypass the single-flight `WorkQueue`); each builds a per-run cmux adapter bound to a nagi-chosen `runId`. Two small upstream changes land first in `agent-surface-adapters`: the approval hook auto-allows the agent's own agentbus reporting, and the cmux host gains socket/window options so a launchd daemon (not inside cmux) can open surfaces.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm, vitest, Node 22. `ai-workflow-engine`, `agent-surface-adapters`, `agentbus`/`cmux`/`claude` CLIs, `@slack/bolt`, `zod`.

---

## Execution prerequisites

- **Two repos, two branches.** Part A is in `/Users/tohru/Documents/src/ghq/github.com/reedom/agent-surface-adapters` (currently on `main`). Part B is in `/Users/tohru/Documents/src/ghq/github.com/reedom/nagi` (already on branch `phase2-agentbus-slack-fabric`).
- **protect-main hook:** it evaluates the *current* branch *before* a command runs, so a combined `git checkout -b … && git commit …` is still blocked. **Create the branch in its own command first**, then add/commit in a later command. For Part A: `cd <agent-surface-adapters> && git checkout -b phase2-agentbus-pre-auth` as a standalone step before any commit there.
- Run every command with the cwd set to the repo you're editing (`cd <repo> && …`).
- Project style rule (both repos): **never use `>` or `>=` operators** — use `<`/`<=`.
- ESM: intra-package imports use `.js` extensions; engine type-only imports use `import type`.
- Part A must be done and (for local use) `pnpm build` run in `agent-surface-adapters` before Part B's manual smoke, since nagi consumes it via `file:../agent-surface-adapters` — **first add that dependency** (Task B0).

---

# Part A — `agent-surface-adapters` changes

Branch (standalone step first): `cd /Users/tohru/Documents/src/ghq/github.com/reedom/agent-surface-adapters && git checkout -b phase2-agentbus-pre-auth`

## Task A1: Hook auto-allows the agent's own agentbus reporting

**Why:** The agent reports by running `agentbus send`/`reply` as Bash; today every such call hits the approval hook and would escalate to the human. The hook must auto-allow the agent's own agentbus reporting (to its `nagiInstance`) and only escalate genuine tools.

**Files:**
- Modify: `src/agents/claude/hook/approve-via-agentbus.ts`
- Test: `test/hook.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `test/hook.test.ts`)

```ts
import { isSelfReport } from '../src/agents/claude/hook/approve-via-agentbus.js';

describe('isSelfReport', () => {
  it('matches the agent reporting to its own nagi instance', () => {
    expect(isSelfReport('Bash', { command: `printf '%s' '{"type":"result"}' | agentbus send nagi --from ext:awe-1` }, 'nagi')).toBe(true);
    expect(isSelfReport('Bash', { command: `agentbus reply msg_1 nagi` }, 'nagi')).toBe(true);
    expect(isSelfReport('Bash', { command: `agentbus publish --from ext:awe-1` }, 'nagi')).toBe(true);
  });
  it('does NOT match genuine tools or other recipients', () => {
    expect(isSelfReport('Bash', { command: 'rm -rf /tmp/x' }, 'nagi')).toBe(false);
    expect(isSelfReport('Bash', { command: 'agentbus send someone-else --from ext:awe-1' }, 'nagi')).toBe(false);
    expect(isSelfReport('Edit', { file_path: '/x' }, 'nagi')).toBe(false);
    expect(isSelfReport('Bash', { command: 'echo agentbus send nagi' }, 'nagi')).toBe(false); // not actually invoking agentbus
  });
});

describe('runApprovalHook self-report', () => {
  it('auto-allows the agent reporting to nagi without calling ask', async () => {
    const ask = vi.fn();
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `agentbus send nagi --from ext:awe-run-3` }, cwd: '/repo' });
    const out = JSON.parse(await runApprovalHook(['--meta', metaPath], stdin, { ask }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(ask).not.toHaveBeenCalled();
  });
  it('still asks for a genuine tool', async () => {
    const ask = vi.fn().mockResolvedValue({ behavior: 'allow' });
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/repo' });
    await runApprovalHook(['--meta', metaPath], stdin, { ask });
    expect(ask).toHaveBeenCalledOnce();
  });
});
```
(The existing `beforeEach` writes `metaPath` with `{ runId:'run-3', nagiInstance:'nagi', timeoutMs:86400000 }` — reuse it.)

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/tohru/Documents/src/ghq/github.com/reedom/agent-surface-adapters && pnpm vitest run test/hook.test.ts`
Expected: FAIL — `isSelfReport` is not exported.

- [ ] **Step 3: Implement `isSelfReport` and short-circuit in `runApprovalHook`**

Add to `src/agents/claude/hook/approve-via-agentbus.ts` (before `runApprovalHook`):

```ts
/**
 * True when the Bash command is the agent's own agentbus reporting to nagiInstance.
 * Matched tightly (the agentbus binary as a command word, a reporting verb, the
 * recipient) so the approval gate is not widened to arbitrary commands.
 */
export function isSelfReport(toolName: string, toolInput: unknown, nagiInstance: string): boolean {
  if (toolName !== 'Bash') return false;
  const command = (toolInput as { command?: unknown })?.command;
  if (typeof command !== 'string') return false;
  // `agentbus <verb> ...` where agentbus starts a command segment (start, or after | ; && ).
  const re = new RegExp(
    String.raw`(^|[|;&]\s*)agentbus\s+(send|reply|publish)\b([^|;&]*)`,
  );
  const m = command.match(re);
  if (!m) return false;
  if (m[2] === 'publish') return true; // broadcast: no recipient arg
  if (m[2] === 'reply') return new RegExp(String.raw`\b${nagiInstance}\b`).test(m[3] ?? '');
  // send <to>: the recipient is the first non-flag token after `send`
  const rest = (m[3] ?? '').trim().split(/\s+/);
  return rest[0] === nagiInstance;
}
```

Then in `runApprovalHook`, after reading `meta` and `hook`, before calling `ask`:

```ts
  if (isSelfReport(hook.tool_name ?? '', hook.tool_input, meta.nagiInstance)) {
    return decisionJson('allow', 'agentbus self-report');
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /Users/tohru/Documents/src/ghq/github.com/reedom/agent-surface-adapters && pnpm vitest run test/hook.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

```bash
cd /Users/tohru/Documents/src/ghq/github.com/reedom/agent-surface-adapters
pnpm test && pnpm typecheck
git add src/agents/claude/hook/approve-via-agentbus.ts test/hook.test.ts
git commit -m "feat: auto-allow the agent's own agentbus reporting in the approval hook"
```

## Task A2: cmux host gains socket/password/window options (daemon launch)

**Why:** nagi runs under launchd, not inside cmux, so it must address the cmux socket explicitly and target a window.

**Files:**
- Modify: `src/hosts/cmux.ts`, `src/presets.ts`
- Test: `test/cmux-host.test.ts`

- [ ] **Step 1: Write the failing test** (append to `test/cmux-host.test.ts`)

```ts
it('prepends global --socket/--password and adds --window to new-workspace', async () => {
  const runner = vi.fn() as unknown as RunFn;
  vi.mocked(runner).mockResolvedValue({ stdout: 'OK workspace:2', stderr: '', code: 0 });
  const host = makeCmuxHost({ runner, socketPath: '/tmp/cmux.sock', password: 'pw', window: 'window:1' });
  await host.launch({ cwd: '/repo', command: 'bash /run/launch.sh' });
  const args = vi.mocked(runner).mock.calls[0][1];
  // global options precede the subcommand
  expect(args.slice(0, 4)).toEqual(['--socket', '/tmp/cmux.sock', '--password', 'pw']);
  expect(args).toContain('new-workspace');
  expect(args).toContain('--window');
  expect(args).toContain('window:1');
});
```

- [ ] **Step 2: Verify failure**

Run: `cd /Users/tohru/Documents/src/ghq/github.com/reedom/agent-surface-adapters && pnpm vitest run test/cmux-host.test.ts`
Expected: FAIL — `makeCmuxHost` does not accept those options.

- [ ] **Step 3: Implement** — replace `src/hosts/cmux.ts` body:

```ts
import { runProcess, type RunFn } from '../core/run.js';
import type { SurfaceHost, SurfaceRef } from '../core/types.js';

export interface CmuxHostOptions {
  bin?: string;
  runner?: RunFn;
  socketPath?: string;
  password?: string;
  window?: string;
}

export function makeCmuxHost(opts: CmuxHostOptions = {}): SurfaceHost {
  const bin = opts.bin ?? 'cmux';
  const run = opts.runner ?? runProcess;
  return {
    id: 'cmux',
    async launch(input): Promise<SurfaceRef> {
      const args: string[] = [];
      if (opts.socketPath) args.push('--socket', opts.socketPath);
      if (opts.password) args.push('--password', opts.password);
      args.push('new-workspace');
      if (input.cwd) args.push('--cwd', input.cwd);
      args.push('--command', input.command, '--json');
      if (opts.window) args.push('--window', opts.window);
      const r = await run(bin, args);
      if (r.code !== 0) throw new Error(`cmux new-workspace failed: ${r.stderr.trim().slice(0, 300)}`);
      let ref: string | undefined;
      try {
        const j = JSON.parse(r.stdout) as Record<string, unknown>;
        const found = j.surface ?? j.workspace ?? j.id;
        ref = typeof found === 'string' ? found : undefined;
      } catch {
        // ref-text output is fine; keep raw only
      }
      return { raw: r.stdout.trim(), ref };
    },
  };
}
```

- [ ] **Step 4: Thread options through `makeCmuxClaudeAdapter`** — in `src/presets.ts`, extend `CmuxClaudeOptions` and pass through:

```ts
export interface CmuxClaudeOptions {
  awaitResult: (runId: string) => Promise<{ text: string }>;
  nagiInstance?: string;
  runsDir?: string;
  claudeBin?: string;
  hookHelperPath?: string;
  cmuxBin?: string;
  cmuxSocketPath?: string;
  cmuxPassword?: string;
  cmuxWindow?: string;
  newRunId?: () => string;
  newSessionId?: () => string;
}
```
and in `makeCmuxClaudeAdapter`, build the host with them:
```ts
    host: makeCmuxHost({
      bin: opts.cmuxBin,
      socketPath: opts.cmuxSocketPath,
      password: opts.cmuxPassword,
      window: opts.cmuxWindow,
    }),
```

- [ ] **Step 5: Verify + commit**

```bash
cd /Users/tohru/Documents/src/ghq/github.com/reedom/agent-surface-adapters
pnpm vitest run test/cmux-host.test.ts && pnpm test && pnpm typecheck
git add src/hosts/cmux.ts src/presets.ts test/cmux-host.test.ts
git commit -m "feat: cmux host socket/password/window options for daemon launch"
```

- [ ] **Step 6: Build so nagi can consume it**

Run: `cd /Users/tohru/Documents/src/ghq/github.com/reedom/agent-surface-adapters && pnpm build`
Expected: clean (`dist/` regenerated).

---

# Part B — nagi fabric (branch `phase2-agentbus-slack-fabric`)

All Part B commands: `cd /Users/tohru/Documents/src/ghq/github.com/reedom/nagi && …` (already on the branch).

## Task B0: Depend on `agent-surface-adapters`

**Files:** Modify: `package.json`

- [ ] **Step 1: Add the dependency** — in `package.json` `dependencies`, add:

```json
    "agent-surface-adapters": "file:../agent-surface-adapters",
```

- [ ] **Step 2: Install + sanity build**

Run: `cd /Users/tohru/Documents/src/ghq/github.com/reedom/nagi && pnpm install && pnpm build`
Expected: installs the linked package; build clean.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: depend on agent-surface-adapters"
```

## Task B1: cmux config block

**Files:** Modify: `src/config.ts`; Test: `test/config.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test** (`test/config.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const base = { slack: { allowedTeamId: 'T', allowedUserIds: ['U'] }, repos: { engine: '/abs/engine' } };

describe('cmux config', () => {
  it('defaults cmux to undefined', () => {
    expect(parseConfig(base).cmux).toBeUndefined();
  });
  it('accepts a cmux block', () => {
    const c = parseConfig({ ...base, cmux: { socketPath: '/tmp/c.sock', password: 'pw', window: 'window:1' } });
    expect(c.cmux).toEqual({ socketPath: '/tmp/c.sock', password: 'pw', window: 'window:1' });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL — `cmux` not on the schema.

- [ ] **Step 3: Implement** — in `src/config.ts`, add to `configSchema` (after `repos`):

```ts
  // Optional cmux access for the surfaced lane; absent → surfaced runs are disabled.
  cmux: z
    .object({
      socketPath: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
      window: z.string().min(1).optional(),
    })
    .optional(),
```

- [ ] **Step 4: Verify + commit**

```bash
pnpm vitest run test/config.test.ts && pnpm typecheck
git add src/config.ts test/config.test.ts
git commit -m "feat: add optional cmux config block"
```

## Task B2: Pending-runs correlation registry

**Files:** Create: `src/agentbus-bridge/pending-runs.ts`; Test: `test/pending-runs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { PendingRuns } from '../src/agentbus-bridge/pending-runs.js';

describe('PendingRuns', () => {
  it('resolves the awaited result for a run', async () => {
    const p = new PendingRuns();
    const fns = { schedule: (fn: () => void, _ms: number) => { void fn; return () => {}; } };
    const awaited = p.await('r1', { channel: 'C', threadTs: '1', ceilingMs: 1000 }, fns);
    expect(p.get('r1')?.threadTs).toBe('1');
    p.resolveResult('r1', 'the answer');
    await expect(awaited).resolves.toEqual({ text: 'the answer' });
    expect(p.get('r1')).toBeUndefined();
  });
  it('rejects on cancel and on ceiling', async () => {
    const p = new PendingRuns();
    const immediate = { schedule: (fn: () => void, _ms: number) => { fn(); return () => {}; } };
    await expect(p.await('r2', { channel: 'C', threadTs: '2', ceilingMs: 1 }, immediate)).rejects.toThrow(/ceiling/);
    const never = { schedule: (_fn: () => void, _ms: number) => () => {} };
    const a = p.await('r3', { channel: 'C', threadTs: '3', ceilingMs: 1000 }, never);
    p.cancel('r3');
    await expect(a).rejects.toThrow(/cancelled/);
  });
  it('lists active runs and cancels all', () => {
    const p = new PendingRuns();
    const never = { schedule: (_fn: () => void, _ms: number) => () => {} };
    void p.await('a', { channel: 'C', threadTs: '1', ceilingMs: 1000 }, never).catch(() => {});
    void p.await('b', { channel: 'C', threadTs: '2', ceilingMs: 1000 }, never).catch(() => {});
    expect(p.active().sort()).toEqual(['a', 'b']);
    expect(p.cancelAll()).toBe(2);
    expect(p.active()).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run test/pending-runs.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `src/agentbus-bridge/pending-runs.ts`

```ts
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
    return e ? { channel: e.channel, threadTs: e.threadTs, ceilingMs: e.ceilingMs, surfaceRef: e.surfaceRef } : undefined;
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
    return { channel: e.channel, threadTs: e.threadTs, ceilingMs: e.ceilingMs, surfaceRef: e.surfaceRef };
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
```

- [ ] **Step 4: Verify + commit**

```bash
pnpm vitest run test/pending-runs.test.ts && pnpm typecheck
git add src/agentbus-bridge/pending-runs.ts test/pending-runs.test.ts
git commit -m "feat: add pending-runs correlation registry for surfaced runs"
```

## Task B3: The agentbus→Slack bridge

**Files:** Create: `src/agentbus-bridge/bridge.ts`; Test: `test/bridge.test.ts`

Routes one envelope. Approval reuse: build a `PermissionRequest` from the payload and run it through `makeSlackApprovalChannel` bound to the run's thread (reusing `blocks.ts`/`ApprovalRegistry`/the Bolt handler), then reply over agentbus.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleEnvelope } from '../src/agentbus-bridge/bridge.js';
import { PendingRuns } from '../src/agentbus-bridge/pending-runs.js';
import { ApprovalRegistry } from '../src/escalation/approval-registry.js';

function deps(over: Partial<Parameters<typeof handleEnvelope>[1]> = {}) {
  const posts: any[] = [];
  const poster = {
    postMessage: vi.fn(async (a: any) => { posts.push(a); return { ts: 'ts1' }; }),
    update: vi.fn(async () => {}),
    uploadSnippet: vi.fn(async () => {}),
  };
  const pending = new PendingRuns();
  const approvals = new ApprovalRegistry();
  return { poster, pending, approvals, posts, base: { poster, pending, approvals, registry: approvals, newId: () => 'appr1', agentbusReply: vi.fn(async () => {}), log: { info(){}, warn(){}, error(){} } as any, ...over } };
}

const never = { schedule: (_f: () => void, _m: number) => () => {} };

describe('handleEnvelope', () => {
  it('posts progress to the run thread', async () => {
    const d = deps();
    void d.pending.await('r1', { channel: 'C', threadTs: 'T1', ceilingMs: 1000 }, never).catch(() => {});
    await handleEnvelope({ id: 'm', kind: 'message', from: 'ext:awe-r1', payload: { type: 'progress', runId: 'r1', text: 'step 1' } }, d.base);
    expect(d.poster.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C', thread_ts: 'T1', text: expect.stringContaining('step 1') }));
  });

  it('resolves a result for the run', async () => {
    const d = deps();
    const awaited = d.pending.await('r2', { channel: 'C', threadTs: 'T2', ceilingMs: 1000 }, never);
    await handleEnvelope({ id: 'm', kind: 'message', from: 'ext:awe-r2', payload: { type: 'result', runId: 'r2', text: 'done' } }, d.base);
    await expect(awaited).resolves.toEqual({ text: 'done' });
  });

  it('posts an approval and replies after a button resolves it', async () => {
    const d = deps();
    void d.pending.await('r3', { channel: 'C', threadTs: 'T3', ceilingMs: 1000 }, never).catch(() => {});
    const p = handleEnvelope(
      { id: 'ask9', kind: 'ask', from: 'ext:awe-r3', payload: { type: 'approval', runId: 'r3', tool: 'Bash', input: { command: 'ls' } } },
      d.base,
    );
    // simulate the Bolt button handler resolving the approval
    await new Promise((r) => setTimeout(r, 0));
    d.base.approvals.resolve('appr1', { behavior: 'allow', reason: 'ok' });
    await p;
    expect(d.base.agentbusReply).toHaveBeenCalledWith('ask9', expect.objectContaining({ behavior: 'allow' }));
  });

  it('ignores envelopes for unknown runs', async () => {
    const d = deps();
    await handleEnvelope({ id: 'm', kind: 'message', from: 'x', payload: { type: 'progress', runId: 'ghost', text: 'x' } }, d.base);
    expect(d.poster.postMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run test/bridge.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `src/agentbus-bridge/bridge.ts`

```ts
import type { PermissionDecision, PermissionRequest } from 'ai-workflow-engine';
import { DEFAULT_POLICY } from 'ai-workflow-engine';
import type { Logger } from '../logger.js';
import type { SlackPoster } from '../slack/ports.js';
import { makeGate, makeReplier } from '../slack/ports.js';
import { makeSlackApprovalChannel } from '../escalation/slack-channel.js';
import type { ApprovalRegistry } from '../escalation/approval-registry.js';
import type { PendingRuns } from './pending-runs.js';

export interface Envelope {
  id: string;
  kind: string;
  from: string;
  to?: string;
  payload: { type?: string; runId?: string; [k: string]: unknown };
}

export interface BridgeDeps {
  poster: SlackPoster;
  pending: PendingRuns;
  registry: ApprovalRegistry;
  newId: () => string;
  /** Sends a reply back over agentbus for an approval ask. */
  agentbusReply: (askId: string, payload: PermissionDecision) => Promise<void>;
  log: Logger;
}

export async function handleEnvelope(env: Envelope, deps: BridgeDeps): Promise<void> {
  const runId = typeof env.payload.runId === 'string' ? env.payload.runId : undefined;
  const type = env.payload.type;
  if (!runId) {
    deps.log.warn('agentbus envelope without runId', { id: env.id });
    return;
  }
  const binding = deps.pending.get(runId);
  if (!binding) {
    deps.log.warn('agentbus envelope for unknown/expired run', { runId, type });
    return;
  }

  if (env.kind === 'ask' && type === 'approval') {
    const req: PermissionRequest = {
      runId,
      agentLabel: 'surface',
      cli: 'cmux',
      toolName: String(env.payload['tool'] ?? ''),
      toolInput: env.payload['input'],
      cwd: typeof env.payload['cwd'] === 'string' ? env.payload['cwd'] : undefined,
      policy: DEFAULT_POLICY,
    };
    const channel = makeSlackApprovalChannel({
      gate: makeGate(deps.poster, binding.channel, binding.threadTs),
      registry: deps.registry,
      newId: deps.newId,
    });
    const decision = await channel.request(req);
    await deps.agentbusReply(env.id, decision);
    return;
  }

  if (type === 'progress') {
    const text = typeof env.payload['text'] === 'string' ? env.payload['text'] : '';
    await makeReplier(deps.poster, binding.channel, binding.threadTs).say(`:hourglass_flowing_sand: ${text}`);
    return;
  }

  if (type === 'result') {
    const text = typeof env.payload['text'] === 'string' ? env.payload['text'] : '';
    deps.pending.resolveResult(runId, text);
    return;
  }

  deps.log.warn('agentbus envelope of unknown type', { runId, type });
}
```

- [ ] **Step 4: Verify + commit**

```bash
pnpm vitest run test/bridge.test.ts && pnpm typecheck
git add src/agentbus-bridge/bridge.ts test/bridge.test.ts
git commit -m "feat: add agentbus->slack bridge (progress/approval/result)"
```

## Task B4: The `surface` workflow + a `surfaced` registry flag

**Files:** Create: `src/registry/workflows/surface.ts`; Modify: `src/registry/types.ts`, `src/registry/index.ts`; Test: `test/surface-workflow.test.ts`

- [ ] **Step 1: Add `surfaced?` to `RegistryEntry`** — in `src/registry/types.ts`, add to the interface:

```ts
  /** Dispatched on the concurrent surfaced lane (bypasses the single-flight queue). */
  surfaced?: boolean;
```

- [ ] **Step 2: Write the failing test** (`test/surface-workflow.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { surfaceEntry } from '../src/registry/workflows/surface.js';

describe('surface workflow entry', () => {
  it('is marked surfaced and validates {repo, task}', () => {
    const e = surfaceEntry(['engine', 'web']);
    expect(e.id).toBe('surface');
    expect(e.surfaced).toBe(true);
    expect(e.argsSchema.safeParse({ repo: 'engine', task: 'do it' }).success).toBe(true);
    expect(e.argsSchema.safeParse({ repo: 'nope', task: 'x' }).success).toBe(false);
    expect(e.argsSchema.safeParse({ repo: 'engine' }).success).toBe(false);
  });
  it('runs a single cmux agent with the task', async () => {
    const e = surfaceEntry(['engine']);
    const calls: any[] = [];
    const wf: any = { args: { repo: 'engine', task: 'review auth' }, agent: async (p: string, o: any) => { calls.push({ p, o }); return { text: 'ok', usage: { inputTokens: 0, outputTokens: 0 } }; } };
    const out = await e.module.default(wf);
    expect(calls[0].o).toEqual({ cli: 'cmux' });
    expect(calls[0].p).toBe('review auth');
    expect(out).toEqual({ text: 'ok' });
  });
});
```

- [ ] **Step 3: Verify failure**

Run: `pnpm vitest run test/surface-workflow.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement** `src/registry/workflows/surface.ts`

```ts
import { z } from 'zod';
import type { WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import { repoEnum, type EntryFactory, type RegistryEntry } from '../types.js';

interface SurfaceArgs {
  repo: string;
  task: string;
}

const surfaceModule: WorkflowModule = {
  meta: {
    name: 'surface',
    description: 'Run one interactive agent on a cmux surface and report its result.',
  },
  async default(wf: WorkflowApi): Promise<unknown> {
    const args = wf.args as SurfaceArgs;
    const result = await wf.agent(args.task, { cli: 'cmux' });
    return { text: result.text };
  },
};

export const surfaceEntry: EntryFactory = (aliases: string[]): RegistryEntry => ({
  id: 'surface',
  description:
    'Run a task as an interactive agent on a visible cmux surface (you can watch and intervene). ' +
    'Use when the user asks to open/run something on a surface, or wants a watchable interactive run.',
  argsSchema: z.object({ repo: repoEnum(aliases), task: z.string().min(1) }),
  module: surfaceModule,
  surfaced: true,
});
```

- [ ] **Step 5: Register it** — in `src/registry/index.ts`, import and add to `SEED_FACTORIES`:

```ts
import { surfaceEntry } from './workflows/surface.js';
export const SEED_FACTORIES: EntryFactory[] = [reviewRepoEntry, researchEntry, surfaceEntry];
```

- [ ] **Step 6: Verify + commit**

```bash
pnpm vitest run test/surface-workflow.test.ts && pnpm typecheck
git add src/registry/types.ts src/registry/workflows/surface.ts src/registry/index.ts test/surface-workflow.test.ts
git commit -m "feat: add surface workflow (surfaced worker leaf)"
```

## Task B5: Concurrent surfaced dispatch in the Dispatcher

**Files:** Modify: `src/dispatcher/dispatcher.ts`; Test: `test/dispatcher-surfaced.test.ts`

**Design:** In `process()`, after `decide()` returns a dispatch decision, branch on `decision.entry.surfaced`. Surfaced runs are **fired concurrently** (the queue job returns once the surface is launched, freeing the slot); the run's result/error is posted to the thread when the bridge resolves `awaitResult`.

- [ ] **Step 1: Extend `DispatcherDeps`** — add (in `src/dispatcher/dispatcher.ts`):

```ts
  pending: PendingRuns;
  /** Builds a per-run cmux adapter bound to runId + the pending registry. */
  makeSurfaceAdapter: (runId: string) => CliAdapter;
  /** Wall-clock ceiling for a surfaced run (ms). */
  surfaceCeilingMs: number;
  /** Closes a surface by ref (cmux close-surface); best-effort. */
  closeSurface: (surfaceRef: string) => Promise<void>;
```
(Import `PendingRuns` from `../agentbus-bridge/pending-runs.js`; `CliAdapter` is already importable from `ai-workflow-engine`.)

- [ ] **Step 2: Write the failing test** (`test/dispatcher-surfaced.test.ts`)

Construct a `Dispatcher` with fakes: a registry whose triage maps to a `surfaced` entry, a `runWorkflowFn` that awaits the injected adapter's behavior, and assert that (a) `handle()` returns without the workflow having finished (slot freed: the queue's `enqueue` job resolves before the run completes), (b) the run is registered in `pending`, and (c) when `pending.resolveResult(runId, 'done')` is called, the thread gets the formatted result.

```ts
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../src/dispatcher/dispatcher.js';
import { PendingRuns } from '../src/agentbus-bridge/pending-runs.js';
// ... build minimal fakes for config/registry/triage/audit/queue/threadStore/approvals/log/makeReplier/makeGate
// triage resolves to { workflowId: 'surface', args: { repo:'engine', task:'t' }, confidence: 1 }
// registry.get('surface') returns a surfaced entry whose module.default awaits wf.agent({cli:'cmux'})
// makeSurfaceAdapter(runId) returns an adapter whose run() calls deps.pending.await(runId, ...) (via the closure) -- i.e. blocks until resolveResult
// runWorkflowFn = real runWorkflow OR a fake that calls adapter.run(spec)

it('frees the queue while a surfaced run is in flight, then posts the result', async () => {
  const pending = new PendingRuns();
  // ... wire dispatcher with pending + makeSurfaceAdapter that uses pending.await
  // call dispatcher.handle(req); await a tick
  // assert the run is active and no result posted yet
  expect(pending.active()).toHaveLength(1);
  const runId = pending.active()[0];
  pending.resolveResult(runId, 'the answer');
  await new Promise((r) => setTimeout(r, 0));
  // assert replier.say called with formatted result containing 'the answer'
});
```
(Flesh out the fakes following the existing `Dispatcher` constructor shape from `src/dispatcher/dispatcher.ts`; reuse `formatResult` expectations.)

- [ ] **Step 3: Verify failure**

Run: `pnpm vitest run test/dispatcher-surfaced.test.ts`
Expected: FAIL — surfaced branch not implemented.

- [ ] **Step 4: Implement the surfaced branch** — in `process()`, replace the tail (`await this.runDispatched(...)`) with:

```ts
    if (decision.entry.surfaced) {
      this.launchSurfaced(req, replier, decision);
      return; // queue slot frees immediately; the bridge drives completion
    }
    await this.runDispatched(req, replier, decision);
```

Add the method:

```ts
  private launchSurfaced(
    req: RequestContext,
    replier: ThreadReplier,
    decision: Extract<ReturnType<typeof decide>, { kind: 'dispatch' }>,
  ): void {
    const runId = this.deps.newRunId();
    const adapter = this.deps.makeSurfaceAdapter(runId);
    const awaited = this.deps.pending.await(runId, {
      channel: req.channel,
      threadTs: req.threadTs,
      ceilingMs: this.deps.surfaceCeilingMs,
    });
    const options: RunOptions = {
      adapters: { cmux: adapter },
      args: decision.args,
      budget: decision.budget,
      ...(decision.cwd ? { cwd: decision.cwd } : {}),
      onLog: (m) => this.deps.log.info(`[surface:${runId}] ${m}`),
    };
    // Fire concurrently; do NOT await (the queue job returns now).
    void this.runWorkflowFn(decision.entry.module, options)
      .then(async (result) => {
        await this.safeSay(replier, formatResult(result));
        this.record(req, 'completed', { workflowId: decision.entry.id, args: decision.args });
      })
      .catch(async (err) => {
        const cancelled = /cancelled/.test(errorMessage(err));
        const prefix = cancelled ? ':octagonal_sign: Surface run cancelled' : ':warning: Surface run failed';
        await this.safeSay(replier, `${prefix}: ${errorMessage(err)}`);
        this.record(req, cancelled ? 'cancelled' : 'failed', {
          workflowId: decision.entry.id,
          args: decision.args,
          detail: errorMessage(err),
        });
      });
    // Keep `awaited` referenced so the adapter's awaitResult resolves via the same registry entry.
    void awaited.catch(() => {});
  }
```

> Note: the per-run adapter (built by `makeSurfaceAdapter(runId)` in Task B7) has its `awaitResult` bound to `pending.await(runId, …)` for the SAME runId, so the engine's `adapter.run()` blocks on the same promise the bridge resolves. `launchSurfaced` creates the pending entry first; `makeSurfaceAdapter` must reuse it (see B7 — the adapter's `awaitResult` calls `pending.awaitExisting(runId)` rather than creating a second entry). Adjust `PendingRuns` to expose `awaitExisting(runId)` returning the same promise: store the promise on the entry.

- [ ] **Step 4b: Add `awaitExisting` to `PendingRuns`** (Task B2 file) — store the created promise on the entry and return it:

In `await(...)`, after constructing the Promise, keep a reference: change the method to save `entry.promise = promise` and add:
```ts
  awaitExisting(runId: string): Promise<{ text: string }> {
    const e = this.map.get(runId);
    if (!e) return Promise.reject(new Error(`no pending run ${runId}`));
    return e.promise;
  }
```
(Extend `Entry` with `promise: Promise<{ text: string }>`; set it inside `await`.) Add a unit test asserting `awaitExisting` returns the same promise that `resolveResult` settles.

- [ ] **Step 5: Verify + commit**

```bash
pnpm vitest run test/dispatcher-surfaced.test.ts test/pending-runs.test.ts && pnpm typecheck
git add src/dispatcher/dispatcher.ts src/agentbus-bridge/pending-runs.ts test/dispatcher-surfaced.test.ts test/pending-runs.test.ts
git commit -m "feat: dispatch surfaced runs concurrently off the single-flight queue"
```

## Task B6: Surface-aware `stop`

**Files:** Modify: `src/dispatcher/dispatcher.ts`; Test: `test/dispatcher-surfaced.test.ts` (extend)

`handleControl` for `cancel` currently kills the headless active run and clears the queue. Extend it to also cancel all active surfaced runs: close each surface (if a ref is known) and reject its `awaitResult`.

- [ ] **Step 1: Write the failing test** (extend `test/dispatcher-surfaced.test.ts`)

```ts
it('stop cancels active surfaced runs and closes their surfaces', async () => {
  // launch a surfaced run (as above); set its surfaceRef via pending.setSurfaceRef(runId, 'workspace:2')
  // send a `stop` control request
  // assert: closeSurface called with 'workspace:2'; pending.active() is empty; thread got a cancellation notice
});
```

- [ ] **Step 2: Verify failure / Step 3: Implement** — in `handleControl`, in the cancel branch, before/after the existing kill:

```ts
    const surfaced = this.deps.pending.active();
    for (const runId of surfaced) {
      const binding = this.deps.pending.cancel(runId); // rejects awaitResult -> run reports cancelled in its thread
      if (binding?.surfaceRef) {
        void this.deps.closeSurface(binding.surfaceRef).catch((e) =>
          this.deps.log.warn('close-surface failed', { runId, error: errorMessage(e) }),
        );
      }
    }
```
Include the surfaced count in the cancellation reply (e.g. `…and cancelled ${surfaced.length} surface run(s).`).

- [ ] **Step 4: Verify + commit**

```bash
pnpm vitest run test/dispatcher-surfaced.test.ts && pnpm typecheck
git add src/dispatcher/dispatcher.ts test/dispatcher-surfaced.test.ts
git commit -m "feat: stop cancels and closes active surfaced runs"
```

## Task B7: Wire it together in `index.ts` (consumer + adapter + close-surface)

**Files:** Modify: `src/index.ts`; (manual verification — this is integration glue)

- [ ] **Step 1: Build the pieces in `main()`** — add after `approvals` is created:

```ts
import { register, startConsumer, reply as agentbusReply, runProcess } from 'agent-surface-adapters';
import { makeCmuxClaudeAdapter } from 'agent-surface-adapters';
import { PendingRuns } from './agentbus-bridge/pending-runs.js';
import { handleEnvelope } from './agentbus-bridge/bridge.js';

const NAGI_INSTANCE = 'nagi';
const SURFACE_CEILING_MS = 24 * 60 * 60 * 1000; // 24h, matches the adapter's wait ceiling

const pending = new PendingRuns();
```

- [ ] **Step 2: The per-run adapter factory** (bound to the pending registry + cmux config):

```ts
const makeSurfaceAdapter = (runId: string) =>
  makeCmuxClaudeAdapter({
    nagiInstance: NAGI_INSTANCE,
    newRunId: () => runId,
    awaitResult: () => pending.awaitExisting(runId),
    ...(config.cmux?.socketPath ? { cmuxSocketPath: config.cmux.socketPath } : {}),
    ...(config.cmux?.password ? { cmuxPassword: config.cmux.password } : {}),
    ...(config.cmux?.window ? { cmuxWindow: config.cmux.window } : {}),
  });
```
> `awaitResult: () => pending.awaitExisting(runId)` reuses the entry `launchSurfaced` already created. Order: `launchSurfaced` calls `pending.await(runId, …)` first, then `runWorkflow` → `adapter.run()` → `awaitResult()` → `awaitExisting(runId)` returns that same promise.

- [ ] **Step 3: close-surface helper** (uses the cmux CLI with the configured socket):

```ts
const closeSurface = async (surfaceRef: string): Promise<void> => {
  const args: string[] = [];
  if (config.cmux?.socketPath) args.push('--socket', config.cmux.socketPath);
  if (config.cmux?.password) args.push('--password', config.cmux.password);
  args.push('close-surface', surfaceRef);
  await runProcess('cmux', args);
};
```

- [ ] **Step 4: Pass the new deps to the `Dispatcher`** — add `pending`, `makeSurfaceAdapter`, `surfaceCeilingMs: SURFACE_CEILING_MS`, `closeSurface` to the `new Dispatcher({ … })` call.

- [ ] **Step 5: Register nagi + start the consumer** — after `poster = bot.poster;`:

```ts
await register(NAGI_INSTANCE, { persistent: true });
const consumer = startConsumer(
  NAGI_INSTANCE,
  {
    onApproval: async () => ({ behavior: 'deny' }), // approvals are handled by handleEnvelope below, not here
    onProgress: () => {},
    onResult: () => {},
  },
  { intervalMs: 1000 },
);
```
> NOTE: `startConsumer`'s handler shape dispatches by kind. For Phase 2 we want a SINGLE place (`handleEnvelope`) to own routing. Replace the above with a thin loop that calls `handleEnvelope` for every envelope instead of the kind-split handlers. If `agent-surface-adapters` `startConsumer` does not expose a raw per-envelope callback, add one (`onEnvelope`) in a tiny follow-up to that package, OR use `consumeOnce`/`awaitInbox` directly here:

```ts
import { awaitInbox } from 'agent-surface-adapters';
let running = true;
const bridgeDeps = {
  poster, pending, registry: approvals, newId: () => newId('appr'),
  agentbusReply: (askId: string, payload: unknown) => agentbusReply(askId, NAGI_INSTANCE, payload),
  log: logger,
};
const pump = async () => {
  while (running) {
    const envs = await awaitInbox(NAGI_INSTANCE, 1000);
    for (const env of envs) {
      void handleEnvelope(env as never, bridgeDeps).catch((e) =>
        logger.error('bridge handleEnvelope threw', { error: String(e) }),
      );
    }
  }
};
void pump();
```
(Use this `awaitInbox` loop; it owns one consumer of the `nagi` inbox.)

- [ ] **Step 6: Build + manual verification**

```bash
cd /Users/tohru/Documents/src/ghq/github.com/reedom/nagi && pnpm build && pnpm test
```
Then a real run (requires the cmux app + `agentbus` + `claude`, a configured `cmux` block in `nagi.config.json`, and Slack tokens): start nagi, DM it a request that triages to `surface` (e.g. "open a surface and run pwd in <repo>"), and confirm in the thread: an ack, then progress, an approval round-trip (Approve button), and the result; the cmux surface opens and stays open; the agent's own `agentbus send` does NOT prompt for approval; a second surfaced request runs in parallel without crossing threads; `stop` cancels active surfaces.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: register nagi, run agentbus consumer+bridge, inject surfaced adapter"
```

---

## Self-review notes (spec coverage)

- agentbus bridge (multi-run, watch consumer, correlation) → B2, B3, B7.
- Approval reuse via `makeSlackApprovalChannel`/`blocks.ts`/`ApprovalRegistry`/Bolt handler → B3 (handleEnvelope builds a PermissionRequest, runs the existing channel, replies over agentbus).
- Concurrent surfaced dispatch off the single-flight queue → B5 (`launchSurfaced` fires-and-returns).
- cmux adapter injection with nagi-chosen runId (no engine escalation) → B7 (`makeSurfaceAdapter`, `newRunId`, `awaitExisting`).
- `surface` workflow + surfaced flag → B4.
- Surface-aware `stop` (close surface + reject) → B6.
- Pre-authorize the agent's own agentbus calls → A1 (`isSelfReport`).
- cmux-from-daemon (socket/window) → A2 + config B1 + B7 wiring.
- Error handling: launch failure / never-result (ceiling) / cancel → B5 `.catch`, B2 ceiling, B6.
- Deferred (per spec): persistent managers, routing, hierarchy, concierge-as-agent, per-run stop targeting, in-workflow swarm correlation — NOT in this plan.

## Known follow-ups (flagged, not silently dropped)

- `agent-surface-adapters` `startConsumer` is kind-split; Phase 2 routes via a single `handleEnvelope`, so B7 uses an `awaitInbox` loop instead. If a raw `onEnvelope` consumer is later added to the package, B7 can switch to it.
- Per-run `stop <id>` targeting and in-workflow multi-agent (`escalation.runId` shared across agents) correlation are deferred; the current `surface` workflow runs exactly one cmux agent, so one runId per run holds.
- Risk #3 (cmux's own Claude wrapper double-intercepting `PermissionRequest`) is validated in B7 Step 6; if it reproduces, disable cmux's Claude integration for these surfaces.

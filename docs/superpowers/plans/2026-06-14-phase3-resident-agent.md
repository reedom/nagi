# Phase 3 — Persistent Resident Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a surfaced agent stay alive on its cmux surface, bound to its originating Slack thread, handling many turns until explicitly retired with `done`.

**Architecture:** Approach A ("detach after launch"). Turn 1 reuses the Phase 2 launch path (`runWorkflow` → `adapter.run()` → `host.launch` → `onSurface`) unchanged. At launch the run is promoted into a nagi-side `ResidentSessions` registry keyed by `threadTs`. Later in-thread messages bypass triage and pipe straight into the live REPL via `host.send` + `host.sendKey('Return')`. The agentbus bridge routes turn-2+ output/approvals by resolving the thread from `PendingRuns` *or* `ResidentSessions`. The engine boundary stays one-shot; no `agent-surface-adapters` changes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, vitest, pnpm. Engine: `ai-workflow-engine`. Surface adapters: `agent-surface-adapters` (`makeCmuxHost`, `makeCmuxClaudeAdapter`).

**Ownership split (read once before starting):**
- `PendingRuns` — UNCHANGED responsibility: the turn-1 `run()` await + its wait-ceiling. The **dispatcher** posts the turn-1 result (Phase 2 behaviour, kept).
- `ResidentSessions` — NEW: the long-lived, thread-addressed surface. The **bridge** posts turn-2+ results (no pending entry exists for them).

This refines the spec's "single posting path" wording: turn 1 stays dispatcher-posted; turn 2+ is bridge-posted. Each registry owns its own turns — lower churn, equally clean.

---

## File Structure

**Create:**
- `src/residents/resident-sessions.ts` — the `ResidentSessions` registry (one responsibility: track live residents; `threadTs` and `runId` indexes).
- `test/resident-sessions.test.ts` — registry unit tests.
- `test/control.test.ts` — `parseControl` unit tests (none exist today).

**Modify:**
- `src/types.ts` — add two `Outcome` variants.
- `src/dispatcher/control.ts` — add the `done` control verb.
- `src/agentbus-bridge/bridge.ts` — route via `PendingRuns ?? ResidentSessions`; post turn-2+ results.
- `src/dispatcher/dispatcher.ts` — `residents` + `host` deps; `makeSurfaceAdapter` gains an `onSurfaceRef` arg; ingress short-circuit; promotion + `resident-ready` + hint; `done` retirement; `stop` closes residents.
- `src/index.ts` — construct `ResidentSessions` + a cmux host driver; wire both into the dispatcher and the bridge; thread `onSurfaceRef` through `makeSurfaceAdapter`.
- `test/bridge.test.ts` — add `residents` to the deps helper; add turn-2 result + progress tests.
- `test/dispatcher.test.ts` — add `residents` + `host` stubs to the headless harness.
- `test/dispatcher-surfaced.test.ts` — add `residents` + recording `host`; thread `onSurfaceRef`; adjust the turn-1 outcome assertion; add resident tests.

---

## Task 1: `ResidentSessions` registry + Outcome types

**Files:**
- Modify: `src/types.ts` (the `Outcome` union)
- Create: `src/residents/resident-sessions.ts`
- Test: `test/resident-sessions.test.ts`

- [ ] **Step 1: Add the new audit outcomes**

In `src/types.ts`, extend the `Outcome` union (currently ends `| 'control'`):

```ts
export type Outcome =
  | 'refused'
  | 'clarification'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'control'
  | 'resident-input'
  | 'resident-ready';
```

- [ ] **Step 2: Write the failing registry test**

Create `test/resident-sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ResidentSessions } from '../src/residents/resident-sessions.js';

const session = (over: Partial<{ runId: string; surfaceRef: string; channel: string; threadTs: string }> = {}) => ({
  runId: 'run-1',
  surfaceRef: 'workspace:run-1',
  channel: 'C1',
  threadTs: 't1',
  ...over,
});

describe('ResidentSessions', () => {
  it('looks a session up by thread and by run', () => {
    const r = new ResidentSessions();
    r.add(session());
    expect(r.getByThread('t1')).toMatchObject({ runId: 'run-1', surfaceRef: 'workspace:run-1' });
    expect(r.getByRun('run-1')).toMatchObject({ threadTs: 't1' });
  });

  it('remove clears both the thread and the run index', () => {
    const r = new ResidentSessions();
    r.add(session());
    expect(r.remove('t1')).toMatchObject({ runId: 'run-1' });
    expect(r.getByThread('t1')).toBeUndefined();
    expect(r.getByRun('run-1')).toBeUndefined();
    expect(r.remove('t1')).toBeUndefined();
  });

  it('lists every live session', () => {
    const r = new ResidentSessions();
    r.add(session());
    r.add(session({ runId: 'run-2', surfaceRef: 'workspace:run-2', threadTs: 't2' }));
    expect(r.list().map((s) => s.threadTs).sort()).toEqual(['t1', 't2']);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run test/resident-sessions.test.ts`
Expected: FAIL — cannot resolve `../src/residents/resident-sessions.js`.

- [ ] **Step 4: Implement the registry**

Create `src/residents/resident-sessions.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run test/resident-sessions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/residents/resident-sessions.ts test/resident-sessions.test.ts
git commit -m "feat: resident sessions registry + outcomes" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Bridge routes via residents; posts turn-2+ results

**Files:**
- Modify: `src/agentbus-bridge/bridge.ts`
- Modify: `src/index.ts` (construct `ResidentSessions`, pass it into `BridgeDeps`)
- Test: `test/bridge.test.ts`

- [ ] **Step 1: Write the failing bridge tests**

In `test/bridge.test.ts`, add the import at the top (after the existing imports):

```ts
import { ResidentSessions } from '../src/residents/resident-sessions.js';
```

Change the `deps()` helper to build and expose a `ResidentSessions` and include it in `base`. Replace the `const pending = new PendingRuns();` line and the `return { ... }` line with:

```ts
  const pending = new PendingRuns();
  const residents = new ResidentSessions();
  const approvals = new ApprovalRegistry();
  return { poster, pending, residents, approvals, posts, base: { poster, pending, residents, approvals, registry: approvals, newId: () => 'appr1', agentbusReply: vi.fn(async () => {}), log: { info(){}, warn(){}, error(){} } as any, ...over } };
```

Then add these two tests inside the `describe('handleEnvelope', ...)` block:

```ts
  it('posts a turn-2 result via the resident when no pending entry exists', async () => {
    const d = deps();
    d.residents.add({ runId: 'rR', surfaceRef: 'workspace:rR', channel: 'CR', threadTs: 'TR' });
    await handleEnvelope({ id: 'm', kind: 'message', from: 'ext:awe-rR', payload: { type: 'result', runId: 'rR', text: 'turn-2 answer' } }, d.base);
    expect(d.poster.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'CR', thread_ts: 'TR', text: expect.stringContaining('turn-2 answer') }),
    );
  });

  it('routes a turn-2 progress envelope through the resident binding', async () => {
    const d = deps();
    d.residents.add({ runId: 'rP', surfaceRef: 'workspace:rP', channel: 'CP', threadTs: 'TP' });
    await handleEnvelope({ id: 'm', kind: 'message', from: 'ext:awe-rP', payload: { type: 'progress', runId: 'rP', text: 'still going' } }, d.base);
    expect(d.poster.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'CP', thread_ts: 'TP', text: expect.stringContaining('still going') }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/bridge.test.ts`
Expected: FAIL — `residents` is not a property of `BridgeDeps` (type error), and/or the turn-2 result/progress envelopes are treated as "unknown run" so nothing is posted.

- [ ] **Step 3: Implement bridge routing via either registry**

In `src/agentbus-bridge/bridge.ts`:

Add the import after the `PendingRuns` import:

```ts
import type { ResidentSessions } from '../residents/resident-sessions.js';
```

Add `residents` to `BridgeDeps` (after the `pending` field):

```ts
  pending: PendingRuns;
  residents: ResidentSessions;
```

Replace the binding-resolution block at the top of `handleEnvelope` (the lines from `const binding = deps.pending.get(runId);` through its `return;`) with:

```ts
  const pendingBinding = deps.pending.get(runId);
  const resident = deps.residents.getByRun(runId);
  const binding = pendingBinding ?? resident;
  if (!binding) {
    deps.log.warn('agentbus envelope for unknown/expired run', { runId, type });
    return;
  }
```

The approval and progress handlers already use `binding.channel` / `binding.threadTs`; both `RunBinding` and `ResidentSession` carry those fields, so they need no change.

Replace the `result` handler with the turn-aware version:

```ts
  if (type === 'result') {
    const text = typeof env.payload['text'] === 'string' ? env.payload['text'] : '';
    if (pendingBinding) {
      // Turn 1: unblock the engine's run(); the dispatcher posts this result.
      deps.pending.resolveResult(runId, text);
    } else {
      // Turn 2+: no pending await — post the resident's output to its thread.
      await makeReplier(deps.poster, binding.channel, binding.threadTs).say(text);
    }
    return;
  }
```

- [ ] **Step 4: Wire `ResidentSessions` into `index.ts` so `BridgeDeps` type-checks**

In `src/index.ts`, add the import:

```ts
import { ResidentSessions } from './residents/resident-sessions.js';
```

Construct the registry next to the other registries (after `const pending = new PendingRuns();`):

```ts
  const residents = new ResidentSessions();
```

Add `residents` to `bridgeDeps` (after the `pending,` line):

```ts
    pending,
    residents,
```

- [ ] **Step 5: Run the bridge tests + a typecheck**

Run: `pnpm exec vitest run test/bridge.test.ts`
Expected: PASS (7 tests — 5 existing + 2 new).

Run: `pnpm build`
Expected: builds clean (`index.ts` now supplies `residents`).

- [ ] **Step 6: Commit**

```bash
git add src/agentbus-bridge/bridge.ts src/index.ts test/bridge.test.ts
git commit -m "feat: bridge routes turn-2 output via residents" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Dispatcher plumbing — `residents`, `host`, `onSurfaceRef` (no behaviour yet)

This task only adds the new dependencies and threads `onSurfaceRef` through `makeSurfaceAdapter`, so existing behaviour and tests are unchanged. It establishes a green checkpoint before resident behaviour lands.

**Files:**
- Modify: `src/dispatcher/dispatcher.ts`
- Modify: `src/index.ts`
- Modify: `test/dispatcher.test.ts`
- Modify: `test/dispatcher-surfaced.test.ts`

- [ ] **Step 1: Add the `SurfaceDriver` interface + new deps to the dispatcher**

In `src/dispatcher/dispatcher.ts`, add the import after the `PendingRuns` import:

```ts
import type { ResidentSessions } from '../residents/resident-sessions.js';
```

Add this interface just above `export interface DispatcherDeps {`:

```ts
/** The minimal cmux capability the dispatcher needs to drive a live REPL. */
export interface SurfaceDriver {
  send(surfaceRef: string, text: string): Promise<void>;
  sendKey(surfaceRef: string, key: string): Promise<void>;
}
```

In `DispatcherDeps`, change the `makeSurfaceAdapter` field and add the two new deps. Replace:

```ts
  /** Builds a per-run cmux adapter bound to runId + the pending registry. */
  makeSurfaceAdapter: (runId: string) => CliAdapter;
```

with:

```ts
  /** Builds a per-run cmux adapter; onSurfaceRef fires with the surface ref once launched. */
  makeSurfaceAdapter: (runId: string, onSurfaceRef?: (surfaceRef: string) => void) => CliAdapter;
  /** Live registry of resident agents (thread-addressed). */
  residents: ResidentSessions;
  /** Drives a live surface's REPL (send text / submit). */
  host: SurfaceDriver;
```

- [ ] **Step 2: Supply the new deps in `index.ts`**

In `src/index.ts`, add `makeCmuxHost` to the `agent-surface-adapters` import:

```ts
import { makeCmuxClaudeAdapter, makeCmuxHost, register, awaitInbox, reply, runProcess } from 'agent-surface-adapters';
```

Change the `makeSurfaceAdapter` factory to accept and fire `onSurfaceRef`. Replace its `onSurface` option:

```ts
      onSurface: (surface) => {
        if (surface.ref) pending.setSurfaceRef(runId, surface.ref);
      },
```

with the new signature + body (note the changed arrow-function parameter list):

```ts
  const makeSurfaceAdapter = (runId: string, onSurfaceRef?: (surfaceRef: string) => void) =>
    makeCmuxClaudeAdapter({
      nagiInstance: NAGI_INSTANCE,
      newRunId: () => runId,
      awaitResult: () => pending.awaitExisting(runId),
      onSurface: (surface) => {
        if (surface.ref) {
          pending.setSurfaceRef(runId, surface.ref);
          onSurfaceRef?.(surface.ref);
        }
      },
      ...(config.cmux?.socketPath ? { cmuxSocketPath: config.cmux.socketPath } : {}),
      ...(config.cmux?.password ? { cmuxPassword: config.cmux.password } : {}),
      ...(config.cmux?.window ? { cmuxWindow: config.cmux.window } : {}),
    });
```

Construct a cmux host driver after `closeSurface` is defined:

```ts
  // A standalone cmux host used to drive resident REPLs (send + Return). Shares
  // the same socket/window config as the surface adapter.
  const cmuxHost = makeCmuxHost({
    ...(config.cmux?.socketPath ? { socketPath: config.cmux.socketPath } : {}),
    ...(config.cmux?.password ? { password: config.cmux.password } : {}),
    ...(config.cmux?.window ? { window: config.cmux.window } : {}),
  });
  const host = {
    send: (surfaceRef: string, text: string) => cmuxHost.send!(surfaceRef, text),
    sendKey: (surfaceRef: string, key: string) => cmuxHost.sendKey!(surfaceRef, key),
  };
```

Add `residents` and `host` to the `new Dispatcher({ ... })` options (after `closeSurface,`):

```ts
    closeSurface,
    residents,
    host,
```

- [ ] **Step 3: Add stubs to the headless dispatcher harness**

In `test/dispatcher.test.ts`, add the import:

```ts
import { ResidentSessions } from '../src/residents/resident-sessions.js';
```

In `harness(...)`, add to the `new Dispatcher({ ... })` options (after `closeSurface: async () => {},`):

```ts
    closeSurface: async () => {},
    residents: new ResidentSessions(),
    host: { send: async () => {}, sendKey: async () => {} },
```

- [ ] **Step 4: Add a recording host + residents to the surfaced harness**

In `test/dispatcher-surfaced.test.ts`, add the import:

```ts
import { ResidentSessions } from '../src/residents/resident-sessions.js';
```

In `surfaceHarness()`, change the surface adapter to accept + fire `onSurfaceRef`, and add a recording host + residents. Replace the `makeSurfaceAdapter` const with:

```ts
  const makeSurfaceAdapter = (runId: string, onSurfaceRef?: (surfaceRef: string) => void): CliAdapter => ({
    id: 'cmux',
    caps: { schema: false, resume: false, tools: true },
    async run(): Promise<AgentResult> {
      const surfaceRef = `workspace:${runId}`;
      pending.setSurfaceRef(runId, surfaceRef); // mimic the real onSurface -> setSurfaceRef wiring
      onSurfaceRef?.(surfaceRef);               // mimic the real onSurface -> resident promotion
      const r = await pending.awaitExisting(runId);
      return { text: r.text, raw: {}, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  });
  const residents = new ResidentSessions();
  const host = { send: vi.fn(async () => {}), sendKey: vi.fn(async () => {}) };
```

Add `residents` and `host` to the `new Dispatcher({ ... })` options (after `closeSurface,`):

```ts
    closeSurface,
    residents,
    host,
```

And expose them on the returned object — replace the `return { dispatcher, replier, audit, queue, pending, closeSurface };` line with:

```ts
  return { dispatcher, replier, audit, queue, pending, closeSurface, residents, host };
```

- [ ] **Step 5: Run the affected suites — behaviour unchanged**

Run: `pnpm exec vitest run test/dispatcher.test.ts test/dispatcher-surfaced.test.ts`
Expected: PASS — all existing tests still green (no behaviour added yet; the surfaced harness now also registers a resident, which nothing reads yet).

Run: `pnpm build`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatcher/dispatcher.ts src/index.ts test/dispatcher.test.ts test/dispatcher-surfaced.test.ts
git commit -m "feat: thread resident deps into dispatcher" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Promotion at launch + `resident-ready` + hint

**Files:**
- Modify: `src/dispatcher/dispatcher.ts` (`launchSurfaced`)
- Test: `test/dispatcher-surfaced.test.ts`

- [ ] **Step 1: Update the existing surfaced test + add a promotion test**

In `test/dispatcher-surfaced.test.ts`, the first test (`'frees the queue while a surfaced run is in flight, then posts the result'`) currently asserts the final outcome is `'completed'`. A launched surface is now a live resident, so the launch turn records `'resident-ready'`. Change its last assertion:

```ts
    expect(h.audit.entries.at(-1)?.outcome).toBe('resident-ready');
```

Add a new test to the `describe('surfaced dispatch', ...)` block:

```ts
  it('promotes a launched surface into the resident registry for its thread', async () => {
    const h = surfaceHarness();
    await h.dispatcher.handle(req({ threadTs: 't-res' }));
    for (let i = 0; i < 10; i += 1) await tick();
    const resident = h.residents.getByThread('t-res');
    expect(resident).toMatchObject({ runId: 'run-surf', surfaceRef: 'workspace:run-surf' });
    // The launch result is still posted to the thread, plus the interactive hint.
    h.pending.resolveResult('run-surf', 'the answer');
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.replier.said.some((s) => /reply here to keep talking/i.test(s))).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run test/dispatcher-surfaced.test.ts`
Expected: FAIL — outcome is still `'completed'` (not `'resident-ready'`), no resident registered for `t-res`, hint not posted.

- [ ] **Step 3: Implement promotion + hint in `launchSurfaced`**

In `src/dispatcher/dispatcher.ts`, add a module-level constant above the `Dispatcher` class (after the imports):

```ts
const RESIDENT_HINT =
  ':speech_balloon: Surface is live — reply here to keep talking; say `done` to close it.';
```

In `launchSurfaced`, replace the run-id + adapter + await setup:

```ts
    const runId = this.deps.newRunId();
    const adapter = this.deps.makeSurfaceAdapter(runId);
```

with:

```ts
    const runId = this.deps.newRunId();
    const adapter = this.deps.makeSurfaceAdapter(runId, (surfaceRef) =>
      this.deps.residents.add({ runId, surfaceRef, channel: req.channel, threadTs: req.threadTs }),
    );
```

Replace the `.then(...)` success handler:

```ts
      .then(async (result) => {
        await this.safeSay(replier, formatResult(result));
        this.record(req, 'completed', { workflowId: decision.entry.id, args: decision.args });
      })
```

with (still posts the turn-1 result, then the hint, and records the resident as live):

```ts
      .then(async (result) => {
        await this.safeSay(replier, formatResult(result));
        await this.safeSay(replier, RESIDENT_HINT);
        this.record(req, 'resident-ready', { workflowId: decision.entry.id, args: decision.args });
      })
```

Replace the `.catch(...)` handler so a failed launch cleans up any resident the `onSurfaceRef` callback registered:

```ts
      .catch(async (err) => {
        const stale = this.deps.residents.remove(req.threadTs);
        if (stale) {
          void this.deps.closeSurface(stale.surfaceRef).catch((e) =>
            this.deps.log.warn('close-surface failed', { runId, error: errorMessage(e) }),
          );
        }
        const cancelled = /cancelled/.test(errorMessage(err));
        const prefix = cancelled ? ':octagonal_sign: Surface run cancelled' : ':warning: Surface run failed';
        await this.safeSay(replier, `${prefix}: ${errorMessage(err)}`);
        this.record(req, cancelled ? 'cancelled' : 'failed', {
          workflowId: decision.entry.id,
          args: decision.args,
          detail: errorMessage(err),
        });
      });
```

- [ ] **Step 4: Run to verify the suite passes**

Run: `pnpm exec vitest run test/dispatcher-surfaced.test.ts`
Expected: PASS (3 tests). The `'stop'` test still passes — at cancel time both the pending entry and the resident reference `workspace:run-surf`; closing it is best-effort/idempotent.

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/dispatcher.ts test/dispatcher-surfaced.test.ts
git commit -m "feat: promote launched surface to resident" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Ingress short-circuit — pipe in-thread messages to the REPL

**Files:**
- Modify: `src/dispatcher/dispatcher.ts` (`handle`)
- Test: `test/dispatcher-surfaced.test.ts`

- [ ] **Step 1: Write the failing ingress tests**

Add to `test/dispatcher-surfaced.test.ts` (new `describe` block at the end of the file):

```ts
describe('resident ingress', () => {
  it('pipes a follow-up in a resident thread straight to the REPL, skipping triage', async () => {
    const h = surfaceHarness();
    h.residents.add({ runId: 'run-surf', surfaceRef: 'workspace:run-surf', channel: 'C1', threadTs: 't1' });
    await h.dispatcher.handle(req({ text: 'follow-up question' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.host.send).toHaveBeenCalledWith('workspace:run-surf', 'follow-up question');
    expect(h.host.sendKey).toHaveBeenCalledWith('workspace:run-surf', 'Return');
    expect(h.queue.status().active).toBeFalsy(); // never entered the queue / triage
    expect(h.audit.entries.at(-1)?.outcome).toBe('resident-input');
  });

  it('closes the resident and notifies when the surface is gone', async () => {
    const h = surfaceHarness();
    h.host.send.mockRejectedValueOnce(new Error('no such surface'));
    h.residents.add({ runId: 'run-surf', surfaceRef: 'workspace:run-surf', channel: 'C1', threadTs: 't1' });
    await h.dispatcher.handle(req({ text: 'hello?' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.residents.getByThread('t1')).toBeUndefined();
    expect(h.replier.said.some((s) => /resident seems gone/i.test(s))).toBe(true);
  });

  it('triages normally in a thread with no resident', async () => {
    const h = surfaceHarness();
    await h.dispatcher.handle(req());
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.host.send).not.toHaveBeenCalled();
    expect(h.pending.active()).toHaveLength(1); // the surface workflow launched
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run test/dispatcher-surfaced.test.ts`
Expected: FAIL — follow-up messages still go through triage; `host.send` is never called.

- [ ] **Step 3: Implement the ingress short-circuit**

In `src/dispatcher/dispatcher.ts`, in `handle(...)`, insert the resident check immediately after the `handleControl` block returns and **before** the `threadStore` follow-up logic. Locate:

```ts
    const control = parseControl(req.text);
    if (control) {
      await this.handleControl(control, req, replier);
      return;
    }

    const pending = this.deps.threadStore.get(req.threadTs);
```

and insert between them:

```ts
    const control = parseControl(req.text);
    if (control) {
      await this.handleControl(control, req, replier);
      return;
    }

    const resident = this.deps.residents.getByThread(req.threadTs);
    if (resident) {
      await this.feedResident(resident, req, replier);
      return;
    }

    const pending = this.deps.threadStore.get(req.threadTs);
```

Add the `feedResident` method to the `Dispatcher` class (place it just after `handle`):

```ts
  /** Pipe an in-thread message straight into a resident's live REPL (send-immediately). */
  private async feedResident(
    resident: { surfaceRef: string },
    req: RequestContext,
    replier: ThreadReplier,
  ): Promise<void> {
    try {
      await this.deps.host.send(resident.surfaceRef, req.text);
      await this.deps.host.sendKey(resident.surfaceRef, 'Return');
      this.record(req, 'resident-input');
    } catch (err) {
      this.deps.residents.remove(req.threadTs);
      await this.safeSay(replier, ':ghost: Resident seems gone; closing. Send your message again to start fresh.');
      this.record(req, 'failed', { detail: `resident send: ${errorMessage(err)}` });
    }
  }
```

- [ ] **Step 4: Run to verify the suite passes**

Run: `pnpm exec vitest run test/dispatcher-surfaced.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/dispatcher.ts test/dispatcher-surfaced.test.ts
git commit -m "feat: route in-thread messages to resident repl" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `done` retirement verb

**Files:**
- Modify: `src/dispatcher/control.ts`
- Modify: `src/dispatcher/dispatcher.ts` (`handleControl`)
- Create: `test/control.test.ts`
- Test: `test/dispatcher-surfaced.test.ts`

- [ ] **Step 1: Write the failing control parser test**

Create `test/control.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseControl } from '../src/dispatcher/control.js';

describe('parseControl', () => {
  it('recognizes status and cancel synonyms', () => {
    expect(parseControl('status')).toBe('status');
    expect(parseControl('STOP')).toBe('cancel');
    expect(parseControl(' abort ')).toBe('cancel');
  });

  it('recognizes done/close as the retirement verb', () => {
    expect(parseControl('done')).toBe('done');
    expect(parseControl('Close')).toBe('done');
  });

  it('returns undefined for ordinary messages', () => {
    expect(parseControl('open a surface')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run test/control.test.ts`
Expected: FAIL — `parseControl('done')` returns `undefined` (and the type does not include `'done'`).

- [ ] **Step 3: Add the `done` verb to the parser**

Replace the body of `src/dispatcher/control.ts` with:

```ts
// Control commands bypass the workflow queue and are handled immediately (D12).

export type ControlCommand = 'status' | 'cancel' | 'done';

export function parseControl(text: string): ControlCommand | undefined {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'status') return 'status';
  if (normalized === 'cancel' || normalized === 'stop' || normalized === 'abort') return 'cancel';
  if (normalized === 'done' || normalized === 'close') return 'done';
  return undefined;
}
```

- [ ] **Step 4: Run the parser test**

Run: `pnpm exec vitest run test/control.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing `done`-handling test**

Add to `test/dispatcher-surfaced.test.ts` (inside the `describe('resident ingress', ...)` block):

```ts
  it('done retires the thread resident and closes its surface', async () => {
    const h = surfaceHarness();
    h.residents.add({ runId: 'run-surf', surfaceRef: 'workspace:run-surf', channel: 'C1', threadTs: 't1' });
    await h.dispatcher.handle(req({ text: 'done' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.closeSurface).toHaveBeenCalledWith('workspace:run-surf');
    expect(h.residents.getByThread('t1')).toBeUndefined();
    expect(h.replier.said.some((s) => /closed/i.test(s))).toBe(true);
  });

  it('done in a thread with no resident posts a friendly notice', async () => {
    const h = surfaceHarness();
    await h.dispatcher.handle(req({ text: 'done', threadTs: 't-empty' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.closeSurface).not.toHaveBeenCalled();
    expect(h.replier.said.some((s) => /no .*resident/i.test(s))).toBe(true);
  });
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm exec vitest run test/dispatcher-surfaced.test.ts`
Expected: FAIL — `done` currently falls through to the cancel branch (no per-thread retirement); `closeSurface` is not called with the resident's ref / the notice is not posted.

- [ ] **Step 7: Handle `done` in `handleControl`**

In `src/dispatcher/dispatcher.ts`, in `handleControl(...)`, add a `done` branch immediately after the `status` branch and before the cancel logic (`this.cancelling = true;`). Locate:

```ts
    if (command === 'status') {
      await this.safeSay(replier, formatStatus(this.deps.queue.status()));
      this.record(req, 'control', { detail: 'status' });
      return;
    }
    this.cancelling = true;
```

and insert between them:

```ts
    if (command === 'done') {
      const resident = this.deps.residents.remove(req.threadTs);
      if (!resident) {
        await this.safeSay(replier, 'No resident agent in this thread.');
        this.record(req, 'control', { detail: 'done: none' });
        return;
      }
      void this.deps.closeSurface(resident.surfaceRef).catch((e) =>
        this.deps.log.warn('close-surface failed', { runId: resident.runId, error: errorMessage(e) }),
      );
      await this.safeSay(replier, ':octagonal_sign: Resident closed.');
      this.record(req, 'control', { detail: 'done' });
      return;
    }
    this.cancelling = true;
```

- [ ] **Step 8: Run to verify the suite passes**

Run: `pnpm exec vitest run test/dispatcher-surfaced.test.ts test/control.test.ts`
Expected: PASS (8 surfaced + 3 control).

- [ ] **Step 9: Commit**

```bash
git add src/dispatcher/control.ts src/dispatcher/dispatcher.ts test/control.test.ts test/dispatcher-surfaced.test.ts
git commit -m "feat: done verb retires thread resident" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `stop` closes all residents

**Files:**
- Modify: `src/dispatcher/dispatcher.ts` (`handleControl` cancel branch)
- Test: `test/dispatcher-surfaced.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/dispatcher-surfaced.test.ts` (inside `describe('resident ingress', ...)`):

```ts
  it('stop closes every resident surface and clears the registry', async () => {
    const h = surfaceHarness();
    h.residents.add({ runId: 'r-a', surfaceRef: 'workspace:r-a', channel: 'C1', threadTs: 't-a' });
    h.residents.add({ runId: 'r-b', surfaceRef: 'workspace:r-b', channel: 'C1', threadTs: 't-b' });
    await h.dispatcher.handle(req({ text: 'stop', threadTs: 't-ctl' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.closeSurface).toHaveBeenCalledWith('workspace:r-a');
    expect(h.closeSurface).toHaveBeenCalledWith('workspace:r-b');
    expect(h.residents.list()).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run test/dispatcher-surfaced.test.ts`
Expected: FAIL — `stop` cancels pending/headless runs but leaves the resident registry populated; the two resident surfaces are never closed.

- [ ] **Step 3: Close residents in the cancel branch**

In `src/dispatcher/dispatcher.ts`, in `handleControl(...)`, the cancel logic currently reads:

```ts
    this.cancelling = true;
    const killed = this.deps.cancelActiveRun();
    const dropped = this.deps.queue.clearPending();
    const surfaced = this.deps.pending.active();
    for (const runId of surfaced) {
      const binding = this.deps.pending.cancel(runId); // rejects awaitResult -> the run reports cancelled in its thread
      if (binding?.surfaceRef) {
        void this.deps.closeSurface(binding.surfaceRef).catch((e) =>
          this.deps.log.warn('close-surface failed', { runId, error: errorMessage(e) }),
        );
      }
    }
    await this.safeSay(
      replier,
      `Cancelling: signalled ${killed} process(es), dropped ${dropped} queued request(s), ` +
        `and cancelled ${surfaced.length} surface run(s).`,
    );
    this.record(req, 'cancelled', { detail: `killed=${killed} dropped=${dropped} surfaced=${surfaced.length}` });
```

Insert a resident-closing loop after the `surfaced` loop and before the `safeSay`, and extend the message + audit detail with the resident count:

```ts
    this.cancelling = true;
    const killed = this.deps.cancelActiveRun();
    const dropped = this.deps.queue.clearPending();
    const surfaced = this.deps.pending.active();
    for (const runId of surfaced) {
      const binding = this.deps.pending.cancel(runId); // rejects awaitResult -> the run reports cancelled in its thread
      if (binding?.surfaceRef) {
        void this.deps.closeSurface(binding.surfaceRef).catch((e) =>
          this.deps.log.warn('close-surface failed', { runId, error: errorMessage(e) }),
        );
      }
    }
    const residents = this.deps.residents.list();
    for (const resident of residents) {
      this.deps.residents.remove(resident.threadTs);
      void this.deps.closeSurface(resident.surfaceRef).catch((e) =>
        this.deps.log.warn('close-surface failed', { runId: resident.runId, error: errorMessage(e) }),
      );
    }
    await this.safeSay(
      replier,
      `Cancelling: signalled ${killed} process(es), dropped ${dropped} queued request(s), ` +
        `cancelled ${surfaced.length} surface run(s), and closed ${residents.length} resident(s).`,
    );
    this.record(req, 'cancelled', {
      detail: `killed=${killed} dropped=${dropped} surfaced=${surfaced.length} residents=${residents.length}`,
    });
```

- [ ] **Step 4: Run to verify the suite passes**

Run: `pnpm exec vitest run test/dispatcher-surfaced.test.ts`
Expected: PASS (9 tests). The earlier `'stop cancels active surfaced runs and closes their surfaces'` test still passes: the in-flight run is closed via the pending loop, and the resident (same ref) is closed again harmlessly.

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/dispatcher.ts test/dispatcher-surfaced.test.ts
git commit -m "feat: stop closes all resident surfaces" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Full verification + docs

**Files:**
- Modify: `src/registry/workflows/surface.ts` (description copy)
- Modify: `docs/smoke-phase2-surfaced.md` or new `docs/smoke-phase3-resident.md`

- [ ] **Step 1: Clarify the `surface` entry description**

In `src/registry/workflows/surface.ts`, update the `description` so triage/UX reflect residency. Replace the `description:` string in `surfaceEntry` with:

```ts
  description:
    'Run a task as an interactive agent on a visible cmux surface (you can watch and intervene). ' +
    'The surface stays resident: reply in the same thread to keep talking to it, and say `done` to close it. ' +
    'Use when the user asks to open/run something on a surface, or wants a watchable interactive run.',
```

This is copy-only; `test/surface-workflow.test.ts` asserts behaviour, not this string. If that test does assert the description, update the expected text to match.

- [ ] **Step 2: Run the full suite + build**

Run: `pnpm build && pnpm test`
Expected: build clean; all suites green (existing + new: `resident-sessions`, `control`, expanded `bridge` and `dispatcher-surfaced`).

- [ ] **Step 3: Write the Phase 3 smoke runbook**

Create `docs/smoke-phase3-resident.md` capturing the manual end-to-end steps from the design spec (§ Manual end-to-end smoke): launch a surface; reply in-thread and confirm the turn-2 result returns (validating the once-per-turn Stop-hook + stable runId assumption); drive a turn-2 approval; run a second resident concurrently; `done` to close; global `stop` closes a live resident. Note explicitly that mid-turn input is sent immediately and must be observed for garbling.

- [ ] **Step 4: Commit**

```bash
git add src/registry/workflows/surface.ts docs/smoke-phase3-resident.md
git commit -m "docs: phase 3 surface copy + smoke runbook" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Merge to main (user wants merge commits; protect-main blocks add/commit on main but allows --no-ff merge)**

```bash
git checkout main
git merge --no-ff phase3-resident-agent -m "merge: phase 3 persistent resident agent"
```

Then re-run `pnpm test` on `main` to confirm the merge is green before pushing.

---

## Self-Review (completed during planning)

**Spec coverage:** ResidentSessions (Task 1) ✓; promotion at launch (Task 4) ✓; ingress short-circuit (Task 5) ✓; bridge routes via either registry + posts turn-2 (Task 2) ✓; cmux host handle (Task 3) ✓; `done` retirement (Task 6) ✓; `stop` closes residents (Task 7) ✓; no wall-clock reaping — kept only on the turn-1 `PendingRuns` await, untouched ✓; launch-failure cleanup (Task 4 `.catch`) ✓; dead-surface handling (Task 5 `feedResident` catch) ✓; tests for every component (Tasks 1-7) ✓; smoke runbook (Task 8) ✓. The design's "single posting path" is implemented as the documented turn-1-dispatcher / turn-2-bridge split (see Ownership split header) — equivalent coverage, less churn.

**Type consistency:** `ResidentSession { runId, surfaceRef, channel, threadTs }` used identically in Tasks 1, 2, 4, 5, 6, 7. `makeSurfaceAdapter(runId, onSurfaceRef?)` signature defined in Task 3 and called in Task 4. `SurfaceDriver { send, sendKey }` defined in Task 3, used in Task 5. `ControlCommand` gains `'done'` in Task 6 and is handled the same task. `Outcome` gains `'resident-input' | 'resident-ready'`, both used by dispatcher records.

**Placeholders:** none — every code step shows complete content.
</content>

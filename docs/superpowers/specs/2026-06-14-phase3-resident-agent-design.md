# Design: Phase 3 — Persistent resident agent (thread-bound) (nagi)

Date: 2026-06-14
Status: DRAFT (awaiting user review)
Repos: `reedom/nagi` (primary). No `agent-surface-adapters` changes expected.
Depends on: Phase 2 — agentbus↔Slack fabric + surfaced worker leaf, merged and smoke-verified.
Roadmap: decomposition #2 of `2026-06-13-phase2-agentbus-slack-fabric-design.md`
("persistent resident agent"). Routing/addressing (concierge → manager-by-topic) stays
deferred to the next phase.

## North star recap

A persistent, hierarchical agent organization on cmux surfaces, message-routed over
agentbus, with Slack as the human channel: a Concierge routing to per-topic Managers,
each commanding subagents. nagi is the substrate; intelligence moves progressively into
agents. Phase 2 delivered the fabric + a one-shot surfaced worker leaf. This phase
delivers the **keystone**: an agent that stays alive on a surface and handles many
messages over time. It does **not** add routing, addressing, concierge, hierarchy, or
manager-by-topic — those are later phases.

## Problem / scope

Today a surfaced run is one-shot: the `surface` workflow runs `runWorkflow` →
`adapter.run()`, which launches interactive `claude` on a cmux surface, blocks on
`awaitResult(runId)`, and returns when the Stop hook emits `{type:result, runId}`. The
bridge resolves that one promise and **drops** the `PendingRuns` binding. The REPL is
still technically alive afterward, but nagi treats the result as terminal and stops
tracking it. The cmux host already exposes `send`/`sendKey`, but nagi never calls them.

Phase 3 makes a surfaced agent **resident**: bound to its originating Slack thread and
able to handle many turns until explicitly retired. Input is driven by `host.send` +
`host.sendKey('Return')`; output stays on the per-turn Stop hook.

- **In scope:** a nagi-side resident registry, an ingress short-circuit that pipes
  in-thread messages to the live REPL, bridge changes so turn-2+ output/approvals route
  to the right thread, an explicit `done` retirement verb, `stop` extended to close
  residents, and the wiring to give nagi a cmux host handle.
- **Unchanged:** human Slack ingress (Bolt); the headless single-flight lane and its
  workflows; the Phase 2 surface **launch** path (`runWorkflow` → `adapter.run()` →
  `host.launch` → `onSurface`); the approval UI; progress posting.
- **Deferred:** concierge/topic routing, manager-by-topic, subagent hierarchy,
  concierge-as-agent; idle-timeout reaping; per-thread busy-queueing of mid-turn input;
  per-run `stop` targeting.

## Decisions (resolved during brainstorming, 2026-06-14)

1. **Scope** = resident lifecycle only (decomposition #2). No routing this phase.
2. **Residency model** = thread-bound, surface-triggered. A `surface` dispatch spawns a
   resident bound to that Slack thread; one resident per thread; the thread IS the
   address. Later non-control messages in the same thread pipe straight into the REPL,
   bypassing triage.
3. **Retirement** = explicit `done` only. No idle-timeout reaping (the abandoned-surface
   leak is accepted; global `stop` is the backstop). The Phase 2 wall-clock ceiling is
   removed for the resident itself and survives only on the turn-1 launch await.
4. **Mid-turn input** = send immediately. No busy-gating and no per-thread queue: every
   in-thread message becomes `host.send` + `sendKey('Return')`, and claude's own REPL
   absorbs input arriving mid-turn.
5. **Engine integration** = Approach A, "detach after launch". Turn 1 reuses the Phase 2
   launch path verbatim; the run is then promoted into a nagi-side resident registry that
   outlives the one-shot `run()`. No engine/adapter contract changes.

## Architecture

```
Slack ⇄ nagi (substrate; Bolt unchanged)
          ├── headless lane: WorkQueue (single-flight) → runWorkflow            [unchanged]
          └── surfaced lane:
                first in-thread msg → triage → surface workflow → runWorkflow → adapter.run()
                                                        │ host.launch → onSurface
                                                        ▼
                                          ResidentSessions[threadTs] = { runId, surfaceRef, channel }
                later in-thread msg → ingress short-circuit → host.send + sendKey('Return')

   agentbus watch nagi (single consumer) ⇄ surfaced agent(s)
       progress / approval(ask) / result(runId) — every turn, same runId
       bridge resolves thread via PendingRuns ?? ResidentSessions
```

A resident session is identified by a stable `runId` (baked into the agent's Stop-hook /
agentbus config at launch) and addressed by `threadTs`. Because the `runId` is stable for
the surface's life, **every turn's Stop hook emits `{type:result, runId}` with the same
id** — that is the correlation key the bridge routes on.

## Components

### 1. `ResidentSessions` registry (new — `src/residents/resident-sessions.ts`)
Single responsibility: track live residents. Holds `Map<threadTs, ResidentSession>` with
a `runId → threadTs` reverse index kept in sync.

```ts
interface ResidentSession { runId: string; surfaceRef: string; channel: string; threadTs: string }

class ResidentSessions {
  add(session: ResidentSession): void;          // also records reverse index
  getByThread(threadTs: string): ResidentSession | undefined;
  getByRun(runId: string): ResidentSession | undefined;
  remove(threadTs: string): ResidentSession | undefined;  // clears both indexes
  list(): ResidentSession[];
}
```

This is deliberately separate from `PendingRuns`. `PendingRuns` keeps its existing
job unchanged — modelling the turn-1 `run()` await promise and its wait-ceiling.
`ResidentSessions` models the long-lived, thread-addressed surface. Different lifecycles,
different keys.

### 2. Promotion at launch (dispatcher `launchSurfaced`)
The surface adapter's `onSurface` callback fires the moment `host.launch` returns the
surface ref, before the agent produces any output. The dispatcher uses it to register the
resident with the request's `threadTs`, `channel`, `runId`, and the launched
`surfaceRef`. By the time any progress / approval / result envelope arrives, the thread
binding already exists.

To carry `threadTs` into the callback, the `makeSurfaceAdapter` dependency gains an
optional second argument:

```ts
makeSurfaceAdapter(runId: string, onSurfaceRef?: (surfaceRef: string) => void): CliAdapter
```

`index.ts` keeps its internal `onSurface` (which calls `pending.setSurfaceRef`) and
additionally invokes the supplied `onSurfaceRef` when `surface.ref` is present. The
dispatcher passes `(surfaceRef) => residents.add({ runId, surfaceRef, channel, threadTs })`.
(If a surface launches without a resolvable `ref`, no resident is registered and the run
stays one-shot — degrades to Phase 2 behaviour rather than binding an unaddressable
surface.)

### 3. Ingress short-circuit (dispatcher `handle`)
After auth and control parsing, **before** triage / queue admission:

```
const resident = residents.getByThread(req.threadTs)
if (resident) {
  await host.send(resident.surfaceRef, req.text)
  await host.sendKey(resident.surfaceRef, 'Return')
  record(req, 'resident-input')
  return            // no triage, no queue slot; the result returns via the bridge
}
```

The first message in a thread is not yet resident, so it triages normally. If it routes to
`surface`, a resident is created (§2); every later message in that thread pipes straight
into the REPL. Control verbs are parsed first, so `done`/`stop`/`status` are never piped
to the agent.

### 4. Bridge: route by either registry; never drop a resident
A helper resolves a thread binding from either registry:

```ts
function bindingFor(runId): { channel, threadTs } | undefined {
  return pending.get(runId) ?? residents.getByRun(runId)
}
```

`bindingFor` backs the **progress**, **approval**, and **result** handlers, so turn-2+
output and approvals find their thread even though `PendingRuns` no longer has an entry.

The **result** handler changes to:

```
const binding = bindingFor(runId)
if (!binding) { log unknown; return }
post the result text to binding's thread        // always — every turn posts here
pending.resolveResult(runId, text)              // only if a pending entry exists (unblocks turn-1 run())
```

This moves turn-1 result posting out of `launchSurfaced.then` and into the bridge, so all
turns (1 and N) post through one path. `launchSurfaced.then` no longer posts the result;
it records `resident-ready` (launch succeeded, resident now live) and posts the one-time
in-thread hint (§ Lifecycle). `launchSurfaced.catch` handles launch failure (§ Error
handling). The bridge gains a `residents` dependency.

### 5. cmux host handle in nagi (`index.ts`)
nagi constructs one `makeCmuxHost({ socketPath, password, window })` from the same
`config.cmux` block used for the adapter and passes its `send`/`sendKey` into the
Dispatcher. `closeSurface` (the existing `runProcess('cmux', ['close-surface', ref])`
helper) is reused for retirement. `ResidentSessions` is constructed here and injected into
both the Dispatcher and the bridge.

## Lifecycle & control

- **Spawn** — transparent: any `surface` dispatch. After a successful launch nagi posts a
  one-time hint in the thread: *"Surface is live — reply here to keep talking; say `done`
  to close it."*
- **Retire (`done` / `close`)** — a new per-thread control verb (added to
  `parseControl`). The dispatcher retires that thread's resident:
  `closeSurface(surfaceRef)` then `residents.remove(threadTs)`, and confirms in-thread. If
  the thread has no resident, it posts a friendly notice.
- **Global `stop`** — extended: in addition to today's cancellation of headless + pending
  runs, it closes every resident (`closeSurface` each, then clears the registry) and
  reports the count.
- **No wall-clock reaping** — the 30-min `SURFACE_CEILING_MS` stays only on the turn-1
  `PendingRuns` await, so a launch that never produces a first result cannot hang forever.
  Once the resident is live it has no timer and lives until `done`/`stop`.

## Error handling

- **Turn-1 reject / ceiling** — `launchSurfaced.catch` cleans up any resident the
  `onSurface` callback registered (`closeSurface` + `residents.remove`), so a failed launch
  leaves nothing bound. Posts the failure in-thread.
- **Send to a dead surface** — `host.send`/`sendKey` to a surface whose claude crashed or
  was closed externally returns non-zero and throws. The dispatcher catches it, posts
  *"Resident seems gone; closing."*, and `residents.remove(threadTs)` so the next message
  triages fresh.
- **Launch CLI failure** — posts the error in-thread; no resident is registered (consistent
  with Phase 2).
- **Bridge `result` for an unknown runId** — logged and ignored (late/stale envelope after
  retirement).
- **Audit** — resident input, `resident-ready`, retirement, and failures append to the
  existing JSONL audit log.

## Concurrency & isolation

Multiple residents may be live at once, each bound to its own thread. Input routing keys on
`threadTs`; output routing keys on `runId`; neither shares state across residents. The
headless single-flight lane is unaffected (residents bypass the `WorkQueue`, exactly as
Phase 2 surfaced runs do). A two-resident test proves input and output for two threads do
not cross wires.

## Testing

- **`ResidentSessions`** unit: `add` / `getByThread` / `getByRun` / `remove` keep both
  indexes consistent; `remove` clears the reverse index; `list`.
- **Ingress short-circuit**: a message in a resident thread calls `host.send` then
  `host.sendKey('Return')` and does **not** triage or take a queue slot; a message in a
  non-resident thread triages normally.
- **Promotion**: a surfaced dispatch whose surface yields a `ref` registers a resident for
  the request's thread; a surface with no `ref` registers none.
- **`done` control**: retires the thread's resident (`closeSurface` called, registry
  cleared); `done` in a thread with no resident posts the notice and closes nothing.
- **`stop`**: closes every resident surface and clears the registry, on top of the existing
  headless/pending cancellation.
- **Bridge result routing**: a turn-1 result (pending entry present) resolves the pending
  promise and posts to the thread; a turn-2 result (no pending entry, resident present)
  posts to the thread and resolves nothing; an unknown runId is ignored.
- **Bridge progress/approval routing**: a progress/approval envelope for a resident runId
  with no pending entry still resolves its thread via `residents.getByRun`.
- **Launch-failure cleanup**: a rejected turn-1 await removes the resident the `onSurface`
  callback registered and closes its surface.
- **Two concurrent residents**: input for thread A and output for thread B do not cross.

## Manual end-to-end smoke (extends `docs/smoke-phase2-surfaced.md`)

1. From Slack, trigger `surface`; confirm the surface launches, turn-1 result returns
   in-thread, and the "Surface is live" hint appears.
2. Reply in the same thread (no new trigger); confirm the text reaches the REPL and the
   next turn's result returns in-thread — **validating the key assumption that the Stop
   hook fires once per turn with the stable `runId`**.
3. Drive an approval round-trip on a turn-2 message; confirm it routes to the correct
   thread.
4. Run a second resident in a different thread concurrently; confirm no crossed
   input/output.
5. Say `done`; confirm the surface closes and a further message in the thread triages
   fresh (no longer resident).
6. With a resident live, issue a global `stop`; confirm the surface closes.

## Success criteria

- A `surface` dispatch yields a thread-bound resident; replies in that thread reach the
  live REPL and their results return in-thread, across many turns, without re-triaging.
- Turn-2+ progress, approvals, and results route to the correct thread via the resident
  registry (no `PendingRuns` entry required).
- `done` retires exactly that thread's resident; `stop` closes all residents; a failed
  launch leaves nothing bound.
- Two residents run concurrently without crossing threads, while the headless lane keeps
  working single-flight.
- `pnpm test` green; human Slack ingress, headless workflows, and the Phase 2 surface
  launch path are unchanged. No `agent-surface-adapters` changes required.
</content>
</invoke>

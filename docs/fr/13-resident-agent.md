---
refs:
  id: fr:13-resident-agent
  kind: fr
  title: "Resident Agent"
  spec: nagi-phase3
  depends_on:
    - fr:12-agentbus-surfaced-lane
  related:
    - fr:05-request-dispatch
    - fr:07-control-commands
  modules:
    - src/residents/resident-sessions.ts
---

# FR 13: Resident Agent

> A surfaced agent ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)) does not die after its first result — it stays alive on its cmux surface, bound to its originating Slack thread, and handles many turns until explicitly retired. `ResidentSessions` tracks the live set with two indexes: `byThread` for input routing and `byRun` for output routing, kept distinct from `PendingRuns` (which only models the turn-1 `run()` await). A later in-thread message bypasses triage and pipes straight into the live REPL via `host.send` + `host.sendKey('Return')`; its result returns over the bridge to the same thread. `done` retires one thread's resident; `stop` closes them all.

## Purpose

Phase 2 left a surfaced run one-shot: the bridge resolved the turn-1 `PendingRuns` promise and dropped the binding, even though the cmux REPL was still alive. This feature is the Phase 3 keystone — it makes a surfaced agent **resident**: thread-bound and able to handle many turns. It owns the resident registry (`src/residents/resident-sessions.ts`), the ingress short-circuit that pipes in-thread messages into the live REPL, the turn-2+ output post, and the retirement verbs. It deliberately adds no routing, addressing, concierge, hierarchy, or idle-timeout reaping — those stay deferred to later phases.

## User-visible Behavior

### A surface becomes a resident at launch

When the dispatcher takes the surfaced lane, `launchSurfaced` (`src/dispatcher/dispatcher.ts`) builds the per-run cmux adapter with an `onSurfaceRef` callback. The moment cmux returns the surface ref — before the agent produces any output — that callback fires `residents.add({ runId, surfaceRef, channel: req.channel, threadTs: req.threadTs })`. By the time any envelope arrives, the thread binding already exists. If a surface launches without a resolvable ref, no resident is registered and the run degrades to one-shot Phase 2 behaviour ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)).

### The one-time resident hint

After turn 1 resolves and the dispatcher posts the formatted result, it posts `RESIDENT_HINT` and records outcome `resident-ready`:

```
:speech_balloon: Surface is live — reply here to keep talking; say `done` to close it.
```

### ResidentSessions: two indexes, distinct from PendingRuns

`ResidentSessions` (`src/residents/resident-sessions.ts`) holds a `byThread` map (`Map<threadTs, ResidentSession>`) and a `threadByRun` reverse index (`Map<runId, threadTs>`) kept in sync. A `ResidentSession` is `{ runId; surfaceRef; channel; threadTs }`.

| Method | Behavior |
| --- | --- |
| `add(session)` | Sets `byThread[threadTs]` and `threadByRun[runId]`. |
| `getByThread(threadTs)` | Input routing — resolves the resident for an inbound message's thread. |
| `getByRun(runId)` | Output routing — hops `threadByRun` then `byThread` to resolve the binding for an envelope's `runId`. |
| `remove(threadTs)` | Drops both indexes; returns the removed session (for surface cleanup). |
| `list()` | Every live resident (used by `stop`). |

This is kept distinct from `PendingRuns`, which keeps its unchanged job of modelling the turn-1 `run()` await and its wait-ceiling ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)). Different lifecycles, different keys: input keys on `threadTs`, output keys on `runId`.

### Turn-2+ input: in-thread message pipes into the live REPL

In `Dispatcher.handle`, after auth and control parsing but **before** triage / queue admission, a lookup `residents.getByThread(req.threadTs)` decides routing ([05-request-dispatch](05-request-dispatch.md)). A hit calls `feedResident`, which sends the raw text straight into the REPL and submits it:

```ts
await this.deps.host.send(resident.surfaceRef, req.text);
await this.deps.host.sendKey(resident.surfaceRef, 'Return');
this.record(req, 'resident-input');
```

No triage, no queue slot, no `On it — running …` ack — the result returns later via the bridge. Mid-turn input is sent immediately (no busy-gating); claude's own REPL absorbs input arriving while a turn is still running. The first message in a thread is not yet resident, so it triages normally; control verbs are parsed first, so `done` / `stop` / `status` are never piped to the agent.

### Turn-2+ output: the bridge posts to the thread

Every turn's Stop hook emits `{ type: 'result', runId }` with the same stable `runId`. In `handleEnvelope` (`src/agentbus-bridge/bridge.ts`) the binding is resolved as `pending.get(runId) ?? residents.getByRun(runId)`, so `progress`, `approval`, and `result` all find the thread even with no `PendingRuns` entry. The `result` handler splits by turn:

- **Turn 1** (a `PendingRuns` entry exists): `pending.resolveResult(runId, text)` unblocks the engine's `run()`; the dispatcher posts that result.
- **Turn 2+** (no pending await, resident only): the bridge posts the resident's output straight to its thread via `makeReplier(...).say(text)`.

Each registry owns its own turns; this keeps the turn-1 path and its tests untouched ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)).

### Retirement: `done` retires one, `stop` closes all

Both verbs are parsed by `parseControl` and handled in `handleControl` ([07-control-commands](07-control-commands.md)):

- **`done`** — `residents.remove(req.threadTs)`. On a hit it best-effort `closeSurface(surfaceRef)` (a warn on failure) and replies `:octagonal_sign: Resident closed.`, recording `control`. With no resident in the thread it replies `No resident agent in this thread.` and closes nothing (logging the lookup vs. live keys).
- **`stop`** — on top of cancelling the headless run, dropping the queue, and cancelling pending surfaced runs, it iterates `residents.list()`, removing each and best-effort closing its surface. The reply reports the count: `… and closed N resident(s).`, recorded as `cancelled`.

### Resilience: a dead surface drops the binding

If `host.send` / `host.sendKey` throws — the REPL crashed or the surface was closed externally — `feedResident` calls `residents.remove(req.threadTs)`, replies `:ghost: Resident seems gone; closing. Send your message again to start fresh.`, and records `failed`. The next message in that thread triages fresh. A launch failure is cleaned up symmetrically in `launchSurfaced.catch` (remove the stale resident, close its surface).

## Capabilities

- Keep a surfaced agent alive past its first result, bound to its Slack thread, across many turns until explicitly retired.
- Track the live set in `ResidentSessions` with a `byThread` input index and a `threadByRun` output index, kept distinct from `PendingRuns`.
- Promote a surface to a resident at launch via `launchSurfaced`'s `onSurfaceRef` → `residents.add`.
- Short-circuit in-thread ingress to the live REPL (`host.send` + `host.sendKey('Return')`), bypassing triage and the single-flight queue ([05-request-dispatch](05-request-dispatch.md)).
- Post turn-2+ output to the originating thread from the bridge's `result` branch when no pending await exists.
- Retire one resident with `done` and close every resident with `stop` ([07-control-commands](07-control-commands.md)).
- Recover from a dead surface by dropping the binding and prompting the user to start fresh.

## Boundaries

- Adds no routing, addressing, concierge, hierarchy, or manager-by-topic — Phase 3 is resident lifecycle only (design-only, deferred).
- No idle-timeout reaping: the abandoned-surface leak is accepted, with `stop` and a daemon restart as the backstop. The 30-min `SURFACE_CEILING_MS` survives only on the turn-1 `PendingRuns` await ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)).
- No mid-turn busy-gating or per-thread input queue — every in-thread message is sent immediately.
- `ResidentSessions` is in-memory only; live residents are lost on a daemon crash (the surfaces themselves outlive nagi until `stop` or restart reclaims them).
- One resident per thread; the thread is the address. Per-run `stop` targeting is deferred ([07-control-commands](07-control-commands.md)).
- Does not own the surfaced launch handshake, the cmux adapter, or the approval UI — those belong to [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md); this feature takes over once the first result hands off the live surface.

## Traceability

- **Design decisions**: Phase 3 components — §1 (`ResidentSessions` registry), §2 (promotion at launch), §3 (ingress short-circuit), §4 (bridge routes by either registry, splits the `result` handler by turn), §5 (cmux host handle in `index.ts`), plus Lifecycle & control (`done` / `stop`, no wall-clock reaping) and Error handling (dead-surface recovery, launch-failure cleanup). Routing, addressing, hierarchy, idle reaping, and per-run `stop` are marked deferred. The live behaviour is exercised in `docs/smoke-phase3-resident.md`.
- **Modules**: `src/residents/resident-sessions.ts` (the registry). Wired together in `src/dispatcher/dispatcher.ts` (`launchSurfaced` promotion, `RESIDENT_HINT`, `feedResident`, `handleControl` `done` / `stop`), `src/agentbus-bridge/bridge.ts` (turn-2+ result routing via `getByRun`), and `src/index.ts` (the cmux `host` send/sendKey, `closeSurface`, and `ResidentSessions` construction injected into both dispatcher and bridge).
- **Related FR**: [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md) is the hard dependency that launches the surface and hands it off after the first result; [05-request-dispatch](05-request-dispatch.md) routes in-thread messages to `feedResident` ahead of the normal triage path; [07-control-commands](07-control-commands.md) defines the `done` and `stop` verbs that retire residents.

---
refs:
  id: fr:12-agentbus-surfaced-lane
  kind: fr
  title: "Agentbus Surfaced Lane"
  spec: nagi-phase2
  depends_on:
    - fr:08-escalation-approvals
  related:
    - fr:04-workflow-registry
    - fr:05-request-dispatch
    - fr:11-daemon-lifecycle
    - fr:13-resident-agent
  modules:
    - src/agentbus-bridge/
    - src/registry/workflows/surface.ts
---

# FR 12: Agentbus Surfaced Lane

> nagi has a second execution lane next to the headless one. A request routed to a workflow flagged `surfaced` opens an interactive `claude` on a cmux surface and lets the human watch it run. The engine's `run()` blocks on a `PendingRuns` promise keyed by `runId` — re-armed per surfaced agent, so one run can drive a whole multi-step workflow — while the surfaced agent reports back over agentbus: an inbox pump feeds each envelope to `handleEnvelope`, which routes by `payload.type` to its bound Slack thread — `ask`+`approval` reuses the Block Kit approval UI ([08-escalation-approvals](08-escalation-approvals.md)), `progress` posts an hourglass update, and `result` unblocks the run. The surfaced lane never takes the single-flight queue slot ([06-single-flight-queue](06-single-flight-queue.md)), so many surfaced runs are concurrent from the start.

## Purpose

Phase 2 makes nagi the *substrate* for an agent organization living on cmux surfaces and message-routed over agentbus, with Slack as the human channel. This feature is the worker-leaf slice of that fabric: the path from a Slack request, to an interactive agent on a visible surface, to its progress / tool-approvals / result flowing back to the originating thread. It owns two boundaries — the **bridge** (`src/agentbus-bridge/`) which owns agentbus I/O and run↔thread correlation and knows nothing of workflow internals, and the concurrent **surfaced dispatch** (`launchSurfaced` in [05-request-dispatch](05-request-dispatch.md)) which owns the `runWorkflow` lifecycle without holding the queue. The Slack approval UI is reused verbatim.

## User-visible Behavior

### Surfaced workflows take the surfaced lane

A registry entry can carry `surfaced: true`. The seed `surface` workflow (`src/registry/workflows/surface.ts`) does — it runs one interactive agent via `wf.agent(args.task, { cli: 'cmux' })` and returns its text. After triage and `decide()`, the dispatcher checks `decision.entry.surfaced`: if set, it calls `launchSurfaced` and returns immediately instead of the in-thread `runDispatched` path ([05-request-dispatch](05-request-dispatch.md)). Its description tells the user the surface stays resident — reply in the same thread to keep talking, say `done` to close it ([13-resident-agent](13-resident-agent.md)).

### Launch: bind the run, free the queue slot

`launchSurfaced` (`src/dispatcher/dispatcher.ts`) mints a `runId`, then:

1. Builds a per-run cmux adapter via `makeSurfaceAdapter(runId, onSurfaceRef)`. The `onSurfaceRef` callback registers the run as a resident (`residents.add`) once the surface exists ([13-resident-agent](13-resident-agent.md)).
2. Registers the run in `PendingRuns.await(runId, binding)` with `{ channel, threadTs, ceilingMs }` (`surfaceRef` is filled in later via `setSurfaceRef`).
3. Fires `runWorkflow` concurrently with `void` (no `await`) — the queue job returns now, so the slot frees immediately ([06-single-flight-queue](06-single-flight-queue.md)) and other requests proceed.

When `runWorkflow` resolves, the dispatcher posts the formatted result and the resident hint, recording outcome `resident-ready`. On rejection it removes any stale resident, best-effort closes the surface, and posts `:octagonal_sign: Surface run cancelled` or `:warning: Surface run failed`.

### The per-run cmux adapter blocks on PendingRuns

`makeSurfaceAdapter` is built in `src/create-nagi.ts` from `makeCmuxClaudeAdapter`, bound to nagi's chosen `runId` and the run's thread binding. Its `newRunId` hook runs once per surfaced agent — *before* the surface launches — and re-arms the wait with `PendingRuns.await(runId, binding)`; `awaitResult: () => pending.awaitExisting(runId)` then returns that wait's promise, so the engine's `adapter.run()` blocks until the bridge resolves it. Because `await()` is idempotent while a wait is live and `resolveResult` clears it, a workflow that calls `wf.agent({ cli: 'cmux' })` N times in sequence drives N agents on this one run — each on its own surface, all reusing the same `runId` and thread binding (so progress / approvals / results still route to the originating thread). Its `onSurface` hook calls `pending.setSurfaceRef(runId, surface.ref)` and the launch-time `onSurfaceRef` callback when the surface ref arrives.

### PendingRuns: the run↔thread correlation registry

`PendingRuns` (`src/agentbus-bridge/pending-runs.ts`) is a `Map<runId, Entry>` that is multi-run from the start — never a single "active run". The binding shape is `RunBinding { channel; threadTs; ceilingMs; surfaceRef? }`.

| Method | Behavior |
| --- | --- |
| `await(runId, binding)` | Registers the entry, arms a wait-ceiling timer, returns the result promise. Idempotent while a wait is live (returns the existing promise), so a per-step re-arm is a no-op until `resolveResult`/`cancel` clears the entry — this is what lets one run drive multiple sequential surfaced agents. |
| `awaitExisting(runId)` | Returns the already-registered promise (used by the adapter). |
| `get(runId)` | Returns the `RunBinding` if tracked. |
| `setSurfaceRef(runId, ref)` | Records the surface ref once cmux opens it. |
| `resolveResult(runId, text)` | Cancels the timer, drops the entry, resolves the promise with the text. |
| `cancel(runId)` | Cancels the timer, drops the entry, rejects with `surfaced run cancelled`; returns the binding (for surface cleanup). |
| `active()` / `cancelAll()` | Lists / cancels every tracked run. |

### The wait-ceiling (SURFACE_CEILING_MS, 30 min)

Each run carries `ceilingMs`, set from `SURFACE_CEILING_MS` (`30 * 60 * 1000`, 30 minutes) in `src/index.ts`. On expiry the timer drops the entry and rejects the promise with `surfaced run exceeded its wait ceiling`, so an abandoned surface or an agent that never sends `result` cannot leak a tracked run forever. The rejection surfaces as a failed run in the thread.

### The inbox pump dispatches envelopes to the bridge

At startup `src/index.ts` does `register(NAGI_INSTANCE, { persistent: true })` and runs a pump loop that polls `awaitInbox(NAGI_INSTANCE, 1000)` and passes each envelope to `handleEnvelope` ([11-daemon-lifecycle](11-daemon-lifecycle.md) owns this lifecycle). agentbus is a hard dependency: a missing binary fails startup (fail-fast); a transient mid-run poll error is logged and retried so it never crashloops the daemon. An `Envelope` is `{ id; kind; from; to?; payload: { type?; runId?; ... } }`.

### handleEnvelope routes by payload.type

`handleEnvelope` (`src/agentbus-bridge/bridge.ts`) first resolves the run's thread binding, preferring `PendingRuns.get(runId)` and falling back to `ResidentSessions.getByRun(runId)` ([13-resident-agent](13-resident-agent.md)). An envelope with no `runId`, or for an unknown/expired run, is warn-logged and dropped.

- **`ask` + `approval`** — builds a `PermissionRequest` (`agentLabel: 'surface'`, `cli: 'cmux'`, `toolName`/`toolInput`/optional `cwd` from the payload, `DEFAULT_POLICY`), posts it via a *reused* `makeSlackApprovalChannel` bound to the run's thread, awaits the decision, and sends it back with `agentbusReply(env.id, decision)`. Every approval guarantee — request-id button binding, snippet handling, the shared registry — applies identically ([08-escalation-approvals](08-escalation-approvals.md)).
- **`progress`** — posts `:hourglass_flowing_sand: <text>` to the bound thread.
- **`result`** — if a `PendingRuns` binding exists (turn 1) it calls `resolveResult(runId, text, data)` to unblock the engine's `run()`; the dispatcher then posts the result. The optional `data` field carries the **schema-validated structured output** (see below) so `result.data` reaches the workflow, the same contract as the headless lane. If only a resident binding exists (turn 2+), there is no pending await, so the resident's output is posted straight to its thread ([13-resident-agent](13-resident-agent.md)).
- **unknown type** — warn-logged.

### Structured output on the surfaced lane

The surfaced lane has no native structured-output flag (that is a headless `claude -p --json-schema` feature). When a workflow declares a `schema` on a surfaced `wf.agent(...)` call, the per-run adapter writes the JSON Schema to the run dir, records its path in the agent's `meta.json`, and injects the schema into the agent's system prompt. The agent's **Stop hook** (`report-result-via-agentbus.ts`) then reads the final message, validates the extracted JSON against that schema, and:

- **valid** → sends `{ type: 'result', runId, text, data }` and allows the stop;
- **invalid, under the cap** → returns `{ decision: 'block', ..., hookSpecificOutput.additionalContext }` so the agent stays on the surface and repairs, bounded by a per-run repair-attempt counter (`maxRepairs`, default 3);
- **invalid, cap reached** → sends a result with an `error` (no `data`) so the run still unblocks. The bridge carries `error` through `resolveResult` into `RunResult` (and warn-logs it), and the surface adapter throws it, so the workflow step fails with the real cause rather than a downstream undefined-`data` artifact.

So validation and the repair loop live in the harness (the hook), not the model. The per-step repair counter is keyed by `sessionId` (fresh per step) so each step of a multi-step run gets its own repair budget. Steps without a schema (the seed `surface`, free-text steps) keep the plain text-reporting path.

### Post-result resident handoff

After turn 1 resolves and the dispatcher posts the result, it posts the resident hint and the surface stays live as a resident agent. Subsequent in-thread messages and the `done` verb are owned by [13-resident-agent](13-resident-agent.md); this lane's job ends once the first result unblocks the run.

## Capabilities

- Route `surfaced`-flagged registry entries through `launchSurfaced` instead of the in-thread run ([05-request-dispatch](05-request-dispatch.md)).
- Run interactive `claude` on a cmux surface via a per-run `makeCmuxClaudeAdapter`, whose `run()` blocks on `PendingRuns.awaitExisting(runId)`.
- Drive **multiple sequential agents** on one surfaced run: each `wf.agent({ cli: 'cmux' })` re-arms the run's wait and opens its own surface, so a multi-step workflow (not just a single-agent task) runs surfaced, with deterministic orchestration code between the steps.
- Return **schema-validated structured output** (`result.data`) from a surfaced agent: the declared schema is delivered to the agent and enforced by the Stop hook (validate + bounded repair) — structured output without the headless `--json-schema` flag.
- Track concurrent surfaced runs by `runId ↔ {channel, threadTs, surfaceRef?, ceilingMs}`, freeing the single-flight slot at launch ([06-single-flight-queue](06-single-flight-queue.md)).
- Pump the agentbus inbox into `handleEnvelope`, routing `ask`/`approval`, `progress`, and `result` to the originating Slack thread.
- Reuse the Slack approval channel verbatim for surfaced tool-approvals ([08-escalation-approvals](08-escalation-approvals.md)).
- Bound every run by a 30-minute wait-ceiling so an abandoned surface cannot leak a tracked run.
- Fall back from `PendingRuns` to `ResidentSessions.getByRun` so post-result turns still reach the thread ([13-resident-agent](13-resident-agent.md)).

## Boundaries

- The bridge knows nothing of workflow internals — it owns agentbus I/O and run↔thread correlation only; the surfaced dispatch owns the `runWorkflow` lifecycle.
- Does not implement the approval UI, button binding, or serialization — it borrows `makeSlackApprovalChannel` from [08-escalation-approvals](08-escalation-approvals.md).
- Does not own resident lifecycle, in-thread routing, or the `done` verb — those are [13-resident-agent](13-resident-agent.md); this lane only hands off after the first result.
- `PendingRuns` is in-memory only; in-flight surfaced runs are lost on a daemon crash (accepted for v1, consistent with the headless lane).
- `stop` cancels **all** active surfaced runs (closing each surface and rejecting its await); per-run targeting is deferred (design-only) ([07-control-commands](07-control-commands.md)).
- Cmux socket/window/password options and `SURFACE_CEILING_MS` are wired in `src/index.ts`; the surface-from-daemon launch context belongs to [11-daemon-lifecycle](11-daemon-lifecycle.md).
- The surfaced agent's hook helpers (approval + result/validation) are spawned by Claude Code as `node <path>` commands resolved relative to the bundle, so the build must emit them as real files at `dist/hook/*.js` (`tsup.config.ts` entries). A bundled install missing those files would leave the surfaced agent unable to report results.

## Traceability

- **Design decisions**: Phase 2 components — §1 (agentbus bridge), §3 (concurrent surfaced dispatch bypassing the queue), §4 (cmux adapter injection), §5 (the `surface` worker leaf), plus the Concurrency & cancellation section (multi-run `PendingRuns`, surface-aware `stop`, the wait-ceiling). Persistent resident agents and per-run `stop` targeting are marked deferred. Sequential multi-agent surfaced runs are supported by re-arming the shared `runId` wait per step (idempotent `await` + `resolveResult`); *concurrent* per-agent correlation (distinct ids per in-flight agent) remains deferred — agents within one run reuse the run's `runId`, so they must run one at a time.
- **Modules**: `src/agentbus-bridge/` (`bridge.ts`, `pending-runs.ts`); `src/registry/workflows/surface.ts` (the surfaced workflow entry). Wired together in `src/dispatcher/dispatcher.ts` (`launchSurfaced`) and `src/index.ts` (`makeSurfaceAdapter`, the register + `awaitInbox` pump, `bridgeDeps`, `SURFACE_CEILING_MS`).
- **Related FR**: [08-escalation-approvals](08-escalation-approvals.md) supplies the approval channel the bridge reuses for surfaced asks (hard dependency); [04-workflow-registry](04-workflow-registry.md) defines the `surfaced` flag and the `surface` entry; [05-request-dispatch](05-request-dispatch.md) decides and launches the surfaced lane; [06-single-flight-queue](06-single-flight-queue.md) is the slot the surfaced lane frees at launch; [11-daemon-lifecycle](11-daemon-lifecycle.md) registers nagi on agentbus and runs the inbox pump; [13-resident-agent](13-resident-agent.md) takes over once the first result hands the live surface off as a resident.

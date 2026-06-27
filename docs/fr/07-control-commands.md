---
refs:
  id: fr:07-control-commands
  kind: fr
  title: "Control Commands"
  spec: nagi-v1
  related:
    - fr:05-request-dispatch
    - fr:06-single-flight-queue
    - fr:08-escalation-approvals
    - fr:12-agentbus-surfaced-lane
    - fr:13-resident-agent
  modules:
    - src/dispatcher/control.ts
    - src/dispatcher/kill-tree.ts
---

# FR 07: Control Commands

> A small set of text control words (`status`, `done`, `cancel`/`stop`) that bypass the single-flight workflow queue and are handled immediately, letting an operator read the queue, retire one thread's resident, or tear everything down without waiting behind a running workflow.

## Purpose

Most inbound messages are admitted to the work queue and run one at a time ([06-single-flight-queue](06-single-flight-queue.md)). Operational control must not wait in that line: you cannot ask "what's running?" or "stop now" if the answer is queued behind the very run you want to inspect or kill. D12 makes the control words bypass the queue and execute synchronously in the dispatcher. `parseControl` (`src/dispatcher/control.ts`) classifies the message; `handleControl` (`src/dispatcher/dispatcher.ts`) runs the matching branch before the queue, resident routing, or triage are ever consulted.

## User-visible Behavior

### Recognized words

`parseControl` lowercases and trims the message, then maps exact matches to a `ControlCommand` union of three values:

| Typed word(s) | `ControlCommand` | Branch |
| --- | --- | --- |
| `status` | `status` | read the queue |
| `cancel`, `stop`, `abort` | `cancel` | tear everything down |
| `done`, `close` | `done` | retire this thread's resident |

Anything else returns `undefined`, and the message falls through to resident routing / queue admission. Matching is exact: only a message whose entire trimmed text is one of these words is treated as a control command. In `handle`, the control check runs first — before the resident lookup and before queue admission — so these words are honored even while a workflow is busy.

### `status` — read the queue

Renders `formatStatus(queue.status())` (`src/dispatcher/format.ts`) in-thread: `Running: *<label>*` (or `Idle — nothing running.`) followed by a numbered `Queued (<n>)` list when any jobs are pending. It only reads the queue ([06-single-flight-queue](06-single-flight-queue.md)); nothing is mutated. Audited as outcome `control` with `detail: 'status'`.

### `done` — retire this thread's resident

Scoped to the **current thread only**. It calls `residents.remove(req.threadTs)`:

- No resident bound to this thread → replies `No resident agent in this thread.` and audits `control` with a `done: none` detail recording the looked-up thread and the live resident keys (a diagnostic for mis-addressed `done`s).
- A resident is present → best-effort `closeSurface(resident.surfaceRef)` (failures only log), replies `:octagonal_sign: Resident closed.`, and audits `control` with `detail: 'done'`.

This closes one live surface and stops in-thread routing to it; other threads' residents are untouched. See [13-resident-agent](13-resident-agent.md).

### `cancel` / `stop` — tear everything down

The broad kill switch. It sets the dispatcher's `cancelling` flag (so the active run reports its rejection as cancelled rather than failed) and performs four actions, then posts one summary:

1. **Kill the active run's process tree** — `cancelActiveRun()` delegates to `killActiveRunDescendants` (`src/dispatcher/kill-tree.ts`). The engine spawns the agent CLIs (claude/codex) as descendants of the daemon but exposes **no `AbortSignal`**, so v1 cancellation is a best-effort process-tree kill: `readProcessTable` runs `ps -A -o pid=,ppid=`, `descendantPids` walks the daemon's descendants, and each is sent `SIGTERM` (leaves first, via `reverse()`, to reduce reparenting races). The killed CLI exits non-zero, the engine's run rejects, and the dispatcher reports the cancellation in the run's own thread. The call returns the number of processes signalled.
2. **Drop the pending queue** — `queue.clearPending()` empties the FIFO and returns the dropped count ([06-single-flight-queue](06-single-flight-queue.md)).
3. **Cancel in-flight surfaced runs** — for each `pending.active()` runId, `pending.cancel(runId)` rejects its awaited result (the run then reports cancelled in its thread) and the bound `surfaceRef` is closed best-effort. See [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md).
4. **Close all residents** — every entry in `residents.list()` is removed and its surface closed best-effort. See [13-resident-agent](13-resident-agent.md).

It then posts one summary, e.g. `Cancelling: signalled <k> process(es), dropped <d> queued request(s), cancelled <s> surface run(s), and closed <r> resident(s).`, and audits outcome `cancelled` with those counts in `detail`.

### `done` vs `stop` scope

`done` is surgical — it retires exactly one thread's resident and closes that one surface. `cancel`/`stop` is global — it kills the active process tree, empties the queue, and cancels/closes **every** surfaced run and resident across all threads.

## Capabilities

- Classify a message into the `status` / `cancel` / `done` control union, ahead of resident routing and queue admission.
- Read queue state (`status`) without mutating it.
- Retire a single thread's resident and close its surface (`done`).
- Kill the active run's descendant process tree, drain the queue, cancel surfaced runs, and close all residents in one command (`cancel`/`stop`).
- Report a per-branch in-thread summary and audit each control action.

## Boundaries

- **Cancellation is best-effort process-tree signalling, not a clean engine cancellation token.** With no `AbortSignal` from the engine, `cancel` sends `SIGTERM` to enumerated descendants and infers cancellation from the resulting non-zero exit; a clean engine-level cancellation token is the documented v1 follow-up.
- **Exact-match only**: a control word mixed into a longer sentence is not treated as a control command — it falls through to normal handling.
- **Surface closes are best-effort**: `closeSurface` failures are logged, not surfaced or retried.
- **No persistence**: the queue, pending-run, and resident registries are in-memory, so `cancel` only affects the live process state ([06-single-flight-queue](06-single-flight-queue.md)).

## Traceability

- **Design**: see `docs/tohru.hanai-main-design-20260611-235421.md` — decision D12 (control commands `status` and `cancel` bypass the workflow queue and are handled immediately; `cancel` kills the active run's child process tree and posts cancellation in-thread). The best-effort process-tree kill and its clean-cancellation follow-up are documented in `README.md` (Known v1 limitations). The `done`/`close` and `stop`/`abort` aliases extend D12's command set for the resident lifecycle.
- **Modules**: `src/dispatcher/control.ts` (`parseControl`, `ControlCommand`), `src/dispatcher/kill-tree.ts` (`killActiveRunDescendants`); the branching lives in `handleControl` in `src/dispatcher/dispatcher.ts`.
- **Related FR**: [05-request-dispatch](05-request-dispatch.md) routes inbound messages through `parseControl` before queueing; [06-single-flight-queue](06-single-flight-queue.md) backs `status` (read) and the `cancel` queue drop (`clearPending`); [08-escalation-approvals](08-escalation-approvals.md) — a cancelled run abandons any pending approval; [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md) explains the surfaced runs `cancel` rejects and closes; [13-resident-agent](13-resident-agent.md) defines the residents `done` and `stop` retire.

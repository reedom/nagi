---
refs:
  id: fr:06-single-flight-queue
  kind: fr
  title: "Single-Flight Queue"
  spec: nagi-v1
  related:
    - fr:05-request-dispatch
    - fr:07-control-commands
  modules:
    - src/dispatcher/queue.ts
---

# FR 06: Single-Flight Queue

> The in-memory work queue that enforces nagi's v1 single-flight policy: at most one workflow runs at a time, a second request is parked in a FIFO and acknowledged with a "busy, queued" reply, and queued jobs run in order as the active one finishes.

## Purpose

v1 deliberately runs one workflow at a time rather than building persistence and concurrency before the loop earns its keep. `WorkQueue` (`src/dispatcher/queue.ts`) is the whole of that policy: a single in-memory FIFO with one active slot. It gives the dispatcher ([05-request-dispatch](05-request-dispatch.md)) a synchronous admission decision (run now vs. queued behind what), and gives the control commands ([07-control-commands](07-control-commands.md)) a read (`status`) and a bulk drop (`clearPending`). Concurrency, persistence, and crash recovery are explicitly v1.5 hardening and out of scope here.

## User-visible Behavior

### Job shape

A `QueueJob` is the unit of work the queue serializes:

| Field | Type | Role |
| --- | --- | --- |
| `label` | `string` | Short human label for "busy with …" replies and `status` output. |
| `run` | `() => Promise<void>` | The actual work; owns its own error reporting (the pump only last-resort logs). |

The dispatcher builds each job with `label: shortLabel(req.text)` (a one-line, ≤48-char rendering) and `run` bound to its `process(...)` pipeline.

### Admission result (`enqueue`)

`enqueue(job)` appends the job and returns an `Admission` discriminated union:

| Shape | When | Meaning |
| --- | --- | --- |
| `{ accepted: true }` | nothing active and nothing pending | the job starts immediately |
| `{ accepted: false; busyWith: string; position: number }` | something is already active/queued | parked in FIFO; `busyWith` is the active label (or `'a queued task'`), `position` is its 1-based slot |

The pump is kicked (`void this.pump()`) only when no job is currently active, so a fresh admission starts work without the caller awaiting it. On a rejected admission the dispatcher posts an in-thread acknowledgement, e.g. `I'm busy with "<busyWith>". Queued your request (position <N>); I'll run it when the current one finishes.` Accepted admissions get no queue reply — dispatch proceeds straight to its "On it" message.

### Reading the queue (`status`)

`status()` returns a `QueueStatus` of `{ active?: string; queued: string[] }` — the active job's label (omitted when idle) and the pending labels in FIFO order. This backs the `status` control command, which renders it via `formatStatus` (`src/dispatcher/format.ts`): `Running: *<label>*` or `Idle — nothing running.`, followed by a numbered `Queued (<n>)` list when any are pending. See [07-control-commands](07-control-commands.md).

### Draining and clearing (`pump`, `clearPending`)

`pump()` is a single serial loop: it shifts the next pending job, sets it active, awaits `run()`, and clears the active slot in a `finally` so one failing job never strands the queue. A throw that escapes `run()`'s own handler is caught and logged (`queue job threw past its handler`) as a last-resort guard; the loop continues. `clearPending()` empties the pending array and returns how many jobs were dropped — it does **not** touch the active run (that process tree is killed elsewhere by the dispatcher). It backs `cancel`/`stop`, which combine the drop count with the kill count in their reply. See [07-control-commands](07-control-commands.md).

### Surfaced runs free the slot early

For a `surfaced` workflow the dispatcher's queue job returns as soon as the run is launched, rather than awaiting completion — the surfaced lane drives the run to completion concurrently off the queue. The single active slot is therefore freed immediately on launch, letting the next queued request proceed. The surfaced lifecycle itself is documented in [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md).

## Capabilities

- Enforce single-flight: at most one `run()` executes at a time, the rest FIFO.
- Return a synchronous admission (`run now` vs. `busyWith` + 1-based `position`) for the dispatcher's reply.
- Expose the live active label and pending labels for the `status` command.
- Drop all not-yet-started jobs in one call and report the count (for `cancel`/`stop`).
- Survive a job that throws past its own handler without stranding the queue.

## Boundaries

- **In-memory only**: the active job and the pending FIFO live in process memory. In-flight and queued work is lost on restart; the documented v1.5 path is audit-log replay of un-terminated entries (with idempotency care). See [09-audit-log](09-audit-log.md).
- **No concurrency**: exactly one active slot. N-concurrent runs are v1.5, not here.
- **No persistence / no journal**: the queue writes nothing to disk.
- **No cancellation of the active run**: `clearPending` only drops pending jobs; killing the running process tree is the dispatcher's responsibility ([07-control-commands](07-control-commands.md)).
- **No per-job error reporting**: `run()` owns user-facing failure replies; the queue only last-resort logs an escaped throw.

## Traceability

- **Design decisions**: 6A (crash recovery is fail-fast + launchd `KeepAlive`; in-memory queue loss on restart is accepted, audit-log replay deferred to v1.5) and D12 (the `status`/`cancel` control commands bypass the workflow queue). Approach A documents single-flight as the chosen v1 policy, with the persistent queue and N-concurrency belonging to Approach B (v1.5).
- **Modules**: `src/dispatcher/queue.ts`.
- **Related FR**: [05-request-dispatch](05-request-dispatch.md) builds queue jobs and turns the admission result into the in-thread reply; [07-control-commands](07-control-commands.md) reads the queue via `status()` and drains it via `clearPending()`; [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md) explains why surfaced runs free the active slot on launch.

# Design: Phase 2 — agentbus↔Slack fabric + surfaced worker leaf (nagi)

Date: 2026-06-13
Status: DRAFT (awaiting user review)
Repos: `reedom/nagi` (primary), small changes in `reedom/agent-surface-adapters`
Depends on: Phase 1 — `agent-surface-adapters` (`makeCmuxClaudeAdapter`), merged; `agentbus` CLI; `cmux`; `ai-workflow-engine`.

## North star (the end state we build toward, incrementally)

A persistent, hierarchical agent organization on cmux surfaces, message-routed over
agentbus, with Slack as the human channel:

- **Concierge** — a persistent agent at the front, living on a surface. Routes each
  incoming human message to the right manager (it infers the target, or the message
  names its manager).
- **Managers** — one per topic/ticket, each on its own surface, **resident until the
  topic is done**, each commanding multiple subagents (possibly multi-level).
- **Subagents** — the workers under a manager.

This is the shogun / cmux-team shape (persistent inbox-driven agents in panes,
hierarchical), validated as prior art. The architectural thesis: **nagi becomes the
substrate** (Slack ingress/egress, the agentbus message fabric, surface + process
lifecycle, the auth gate), and the *intelligence* — routing, management — moves
progressively **into agents**. Today's nagi triage/queue is a degenerate concierge
(code-brain, single-flight); the roadmap grows it into the real one.

### Decomposition (each builds on the last)

1. **Fabric + worker leaf** — *this spec (Phase 2)*. The agentbus↔Slack bridge
   (multi-agent, thread-addressed) + one surfaced worker (one-shot) + pre-authorize the
   agent's own agentbus calls + launch cmux from the launchd daemon.
2. **Persistent resident agent** — the keystone: an agent that stays alive on a surface
   and handles many messages over time (the manager/concierge lifecycle).
3. **Routing / addressing** — concierge → manager-by-topic; Slack thread ↔ manager
   instance; spawn-per-topic, retire-on-done.
4. **Hierarchy** — managers commanding subagents (reusing the worker leaf), multi-level.
5. **Concierge-as-agent** — promote routing out of nagi code into the front agent.

Phase 2 is deliberately built **multi-agent/concurrent** (not single-flight) so layers
2–5 stack on without rework.

## Problem / scope (Phase 2)

Phase 1 produced a standalone `CliAdapter` that runs interactive `claude` on a cmux
surface and talks to agentbus; its smoke passed. nagi cannot yet use it: there is no
agentbus consumer in nagi, no agentbus→Slack bridge, no surfaced trigger, and nagi is
single-flight. Phase 2 wires the surfaced lane into nagi end to end and lays the
concurrent, thread-addressed fabric the persistent layers need.

- **In scope:** the agentbus↔Slack bridge (multi-run), a concurrent surfaced dispatch
  lane, injecting the cmux adapter, the `surface` worker workflow, surface-aware `stop`,
  plus two small `agent-surface-adapters` changes (pre-auth of agent agentbus calls;
  cmux-from-daemon options).
- **Unchanged:** human Slack ingress (Bolt); the headless single-flight lane and its
  workflows (`review-repo`, `research`); the engine's in-process broker (surfaced
  approvals go over agentbus instead).
- **Deferred:** persistent resident agents, topic↔manager routing, manager lifecycle,
  subagent hierarchies, concierge-as-agent; per-run `stop` targeting; per-agent
  correlation ids for in-workflow swarms.

## Architecture

nagi gains a second execution lane next to the existing headless one:

```
Slack ⇄ nagi (substrate; Bolt unchanged)
          ├── headless lane: WorkQueue (single-flight) → runWorkflow → claude/codex   [unchanged]
          └── surfaced lane (NEW, concurrent): runWorkflow({cli:'cmux'}) per run, tracked by runId
                    │ launch via agent-surface-adapters (cmux)
   thread ⇄ agentbus watch nagi (single consumer) ⇄ surfaced agent(s)
                    progress(message) / approval(ask) / result(message)
```

Boundaries: the **bridge** owns agentbus I/O + run↔thread correlation and knows nothing
about workflow internals; the **surfaced dispatch** owns concurrent `runWorkflow`
lifecycle; the existing **Slack approval UI** is reused verbatim; the **adapter** stays
in `agent-surface-adapters`.

## Components

### 1. agentbus bridge (`src/agentbus-bridge/`)
- **Startup:** `agentbus register nagi --persistent`; spawn one `agentbus watch nagi`
  under nagi's supervision (dedup: one watcher per process; reap on shutdown). Uses the
  `agent-surface-adapters` exports (`register`, `startConsumer`/`consumeOnce`,
  `reply`) so the agentbus wire details live in one place.
- **Correlation registry** (`PendingRuns`): `Map<runId, { channel; threadTs; resolveResult: (text) => void; rejectResult: (reason) => void; surfaceRef?: string }>`.
  Multi-run from the start — never a single "active run".
- **Dispatch** by `payload.type`:
  - `progress` → `makeReplier(poster, channel, threadTs).say(text)` for that run's thread.
  - `approval` (`kind === 'ask'`) → see §2; reply via `agentbus reply <ask-id> nagi {behavior}`.
  - `result` → `pending.get(runId)?.resolveResult(text)` then drop the entry.
  - unknown runId → log and ignore (late/stale envelope).

### 2. Approval reuse (no new UI)
An approval `ask` payload `{type:'approval', runId, tool, input, cwd}` becomes a
`PermissionRequest`, run through `makeSlackApprovalChannel({ gate, registry, newId })`
bound to that run's thread (`makeGate(poster, channel, threadTs)`). This reuses
`blocks.ts`, `ApprovalRegistry`, and the existing Bolt button handler unchanged. The
returned `PermissionDecision` is sent back with `agentbus reply`. Concurrent approvals
across runs are independent (each its own requestId); the existing channel already
serializes within a thread.

### 3. Concurrent surfaced dispatch
Surfaced runs **bypass the single-flight `WorkQueue`**. A surfaced request creates a
`runId`, registers it in `PendingRuns` with its `{channel, threadTs}`, then calls
`runWorkflow(surfaceModule, { adapters, args, cwd, ... })` **without** taking the queue
slot. Multiple surfaced `runWorkflow` calls run concurrently (each blocks on the
adapter's `awaitResult`, resolved by the bridge). Headless workflows keep the queue.

### 4. cmux adapter injection
`import { makeCmuxClaudeAdapter } from 'agent-surface-adapters'`; build it with
`awaitResult: (runId) => new Promise((res, rej) => pending.set(runId, {...}))` wired to
`PendingRuns`, plus cmux socket/window options (see §7). Add to the surfaced lane's
`adapters` as `cmux`.

### 5. `surface` workflow (worker leaf)
`src/registry/workflows/surface.ts`:
```
meta:       { name: 'surface', description: 'Run one interactive agent on a cmux surface' }
argsSchema: z.object({ repo: repoEnum(aliases), task: z.string().min(1) })
default:    async (wf) => wf.agent(wf.args.task, { cli: 'cmux' })
```
cwd from the repo alias via the existing dispatcher `decide()` run-level cwd, like other
workflows. Triageable. (Trigger stays workflow-based for now; addressing/routing is a
later phase.)

## Concurrency & cancellation
- Many surfaced runs may be active; each tracked by `runId ↔ thread` in `PendingRuns`.
- **`stop`** must reach cmux-spawned agents (NOT in nagi's process tree, so
  `killActiveRunDescendants` misses them). It `cmux close-surface`s each active surfaced
  run's surface and `rejectResult`s its `awaitResult` (cancelled), dropping the entry;
  it also cancels the headless active run as today. MVP cancels **all** active surfaced
  runs; per-run targeting is deferred.
- **Wait-ceiling:** each surfaced run carries a max wall-clock; on expiry the bridge
  `rejectResult`s (failed) and closes/leaves the surface per config, so an unanswered
  24h approval or an abandoned surface cannot leak a tracked run forever.

## Cross-repo changes (small, in `agent-surface-adapters`)

### 6. Pre-authorize the agent's own agentbus calls (keystone smoke finding)
The agent reports by running `agentbus send`/`reply` as Bash, which currently trips the
approval hook — so reporting would escalate to the human on every message. The claude
profile's approval hook (`agents/claude/hook/approve-via-agentbus.ts`) must **auto-allow
the agent's own agentbus reporting commands** (recognize a Bash command invoking the
`agentbus` CLI addressed to the run's `nagiInstance`) and return `allow` without asking
nagi. Only genuine task tools reach the human approval path. Scope the match tightly
(the `agentbus` binary; `send`/`reply`/`publish` to `nagi`) to avoid widening the gate.

### 7. cmux-from-daemon options (risk #1)
nagi runs under launchd, **not** inside cmux, so there is no caller-window context. The
cmux host (`hosts/cmux.ts`) gains options threaded through `makeCmuxClaudeAdapter`:
`CMUX_SOCKET_PATH` (+ password) and a target window/workspace (e.g. `--window`), so the
daemon can open surfaces. nagi config gains a `cmux` block (socket path, password,
optional window). Validate empirically.

## Error handling
- Launch failure (`cmux`/`agentbus` CLI error) → post the error in the run's thread; do
  not register the run (or drop it). Never silent.
- Agent never sends `result` → the wait-ceiling rejects the run as failed and posts the
  error in-thread.
- Approval reply send failure → logged; the agent's `agentbus ask` will time out per its
  policy (deny), so it fails closed.
- Bridge watcher death → inbox is durable (`agentbus watch` never consumes); on restart
  `check-inbox` recovers; in-flight `PendingRuns` are lost on a nagi crash (accepted for
  v1, consistent with the headless lane; documented).
- Audit: surfaced dispatch/approval/outcome append to the existing JSONL audit log.

## Testing
- **Bridge** unit tests with synthetic envelopes: `progress`→thread post; `approval`→
  approval-UI wiring + `agentbus reply`; `result`→correlation resolve. Include a
  **two-concurrent-runs** test proving envelopes for different runIds don't cross wires.
- **Surfaced dispatch** test: two surfaced runs tracked independently, neither taking the
  headless queue slot.
- **`stop`** test: closes the surface(s) (fake cmux) and rejects `awaitResult`.
- **agent-surface-adapters**: a hook test that the agent's own `agentbus send nagi …`
  Bash command is auto-allowed without calling `ask`, while a genuine tool still asks.
- **Manual end-to-end smoke:** Slack message → `surface` worker → progress + one
  approval + result in-thread, with a second surfaced run in parallel, under the launchd
  daemon (validating risk #1 and risk #3 — confirm cmux's own Claude wrapper does not
  double-intercept; if it does, disable cmux's Claude integration for these surfaces).

## Success criteria
- From Slack, a request routed to `surface` opens a cmux surface running interactive
  `claude`, and its progress, one tool-approval round-trip, and final result all arrive
  in the originating thread over agentbus.
- Two surfaced runs can be active at once without crossing threads/approvals, while the
  headless lane keeps working single-flight.
- The agent's own progress/result reporting does **not** prompt the human for approval.
- `stop` ends active surfaced runs (surface closed, run unblocked) — not just headless.
- nagi launches surfaces while running under launchd (not inside cmux).
- `pnpm test` green in both repos; human Slack ingress and headless workflows unchanged.

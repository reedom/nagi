---
refs:
  id: fr:05-request-dispatch
  kind: fr
  title: "Request Dispatch & Clarification"
  spec: nagi-v1
  depends_on:
    - fr:03-triage
    - fr:04-workflow-registry
  related:
    - fr:02-authorization
    - fr:06-single-flight-queue
    - fr:08-escalation-approvals
    - fr:12-agentbus-surfaced-lane
    - fr:13-resident-agent
  modules:
    - src/dispatcher/dispatcher.ts
    - src/dispatcher/decide.ts
    - src/dispatcher/format.ts
    - src/thread-state.ts
---

# FR 05: Request Dispatch & Clarification

> The `Dispatcher` is nagi's orchestration hub: every inbound Slack message flows through one `handle()` pipeline that authorizes, intercepts control words, routes to a live resident, merges any pending clarification, and queues the work — then `process()` triages, decides, acks, and runs the chosen workflow. Every reason it cannot run yet collapses into a single clarification reply (4A), and every failure posts an error in-thread (never silence).

## Purpose

Dispatch is the seam between "a message arrived" and "a workflow ran". It composes the surrounding features — authorization ([02-authorization](02-authorization.md)), triage ([03-triage](03-triage.md)), the registry ([04-workflow-registry](04-workflow-registry.md)), the single-flight queue ([06-single-flight-queue](06-single-flight-queue.md)), escalation ([08-escalation-approvals](08-escalation-approvals.md)), and the surfaced/resident lanes ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md), [13-resident-agent](13-resident-agent.md)) — into one ordered pipeline. The `Dispatcher` itself owns three responsibilities: deciding *whether* to dispatch or clarify, *acking* the choice, and guaranteeing the user always hears back.

## User-visible Behavior

### The `handle()` pipeline (order matters)

`Dispatcher.handle(req)` is the entry point for every inbound message and **never throws** (`src/dispatcher/dispatcher.ts`). It runs these stages in order; the first that applies returns:

1. **`makeReplier`** — build a thread-scoped replier for `req` so every reply lands in the originating thread.
2. **`checkAuth`** ([02-authorization](02-authorization.md)) — if not allowed, post `REFUSAL_MESSAGE`, record `refused` (with the reason as `detail` when present), and stop before any triage or engine call.
3. **`parseControl`** ([07-control-commands](07-control-commands.md)) — if the text is a control word (`status` / `done` / `cancel`/`stop`), handle it and return; control words never reach triage.
4. **Resident routing** ([13-resident-agent](13-resident-agent.md)) — if a resident agent owns `req.threadTs`, pipe the raw text straight into its live REPL (`host.send` + `sendKey('Return')`, recorded `resident-input`) and return; an apparently-dead surface is removed with a `:ghost:` notice.
5. **Pending-clarification merge** — read `threadStore.get(req.threadTs)`. If a clarification is parked there, the effective text becomes `` `${pending.originalText}\n\n[follow-up] ${req.text}` `` and the entry is deleted; otherwise the text is `req.text` unchanged.
6. **`queue.enqueue`** ([06-single-flight-queue](06-single-flight-queue.md)) — submit the work labelled by `shortLabel(req.text)`. If not admitted immediately, tell the user what nagi is busy with and the queue position.
7. **`process()`** — runs (now or when the slot frees) to triage, decide, ack, and execute.

### Pending-clarification merge (8A)

A thread reply is consumed by its pending clarification if one is still live; otherwise it is a fresh request. The store (`src/thread-state.ts`) is an in-memory `threadTs -> PendingClarification` map keyed by thread, where each entry holds `originalText`, the `question` asked (for the audit trail), and an `expiresAt`. It enforces a TTL (default 15 minutes) with **check-on-access eviction** (`get` deletes an expired entry and returns nothing) **plus a periodic `sweep()`** (8A/D9). An expired clarification therefore means a late reply is treated as a fresh request. Escalation approvals use Block Kit buttons and never park here (D11), so the only thing stored is an unanswered triage clarification.

### `process()`: triage then decide

`process()` runs the heart of dispatch:

- **`runTriage`** ([03-triage](03-triage.md)) on the (possibly merged) text. A triage throw is caught, posted as `:warning: I couldn't triage that: …`, recorded `failed`, and stops.
- **`decide()`** (`src/dispatcher/decide.ts`) turns the `TriageResult` into either a `clarify` or a `dispatch` decision.

### Unified clarify-vs-dispatch (4A)

`decide(config, registry, triage)` collapses *every* reason nagi cannot run yet into one clarification path, in this order:

| Condition (checked in order) | Result |
| --- | --- |
| `triage.clarificationQuestion` is non-empty | `clarify` with triage's own question |
| `triage.confidence < config.triage.confidenceThreshold` | `clarify` listing the workflow menu |
| `registry.get(triage.workflowId)` is missing (unknown id) | `clarify` listing the workflow menu |
| `entry.argsSchema.safeParse(triage.args)` fails | `clarify` naming the bad field |
| all pass | `dispatch` with `entry`, parsed `args`, and `budget` |

The clarification wording is grounded in source: the menu question (`chooseWorkflowQuestion`) lists each `id` + `description`; the schema question (`schemaQuestion`) reports the first failing field. On a `dispatch`, `budget = entry.budgetOverride ?? config.defaultBudget`; cwd is not resolved at this stage — repo-aware workflows set cwd per-agent after resolving the target repo.

When `process()` gets a `clarify`, it stores `{ originalText: text, question }` in the thread store, posts the question, and records `clarification` (carrying `triage.workflowId` and `triage.args`). The next in-thread reply re-runs triage with the original text plus the `[follow-up]` line appended (the merge step above).

### Dispatch ack echoes workflow + args (5A)

Before running, `process()` posts a single acknowledgment that echoes the chosen workflow and the extracted args:

```
On it — running *<entry.id>* with `<JSON.stringify(args)>`.
```

It records `dispatched` (with `workflowId` and `args`), then branches on the entry's lane.

### Two lanes: in-thread run vs surfaced launch

- **`runDispatched`** (normal entries) builds a Slack `ApprovalChannel` via `makeSlackApprovalChannel` (gate, approval registry, id minter) so tool escalations round-trip in-thread ([08-escalation-approvals](08-escalation-approvals.md)). It runs `runWorkflowFn(entry.module, options)` with `args`, `budget`, optional `cwd`, the escalation channel (`defaultPolicy: { onTimeout: 'wait' }`), and a per-run `onLog`. On success it posts `formatResult(result)` and records `completed` (with the resolved `approvals` count). On throw it distinguishes a cancellation (`this.cancelling`) from a failure, posts `:octagonal_sign: Run cancelled` or `:warning: Run failed`, and records `cancelled` or `failed` accordingly.
- **`launchSurfaced`** (`entry.surfaced === true`) starts the run on the concurrent surfaced lane ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)) using a per-run cmux adapter and a `pending.await` binding; it returns immediately so the queue slot frees while the AgentBus bridge drives completion. On completion it posts the result plus the resident hint and records `resident-ready`; on failure it cleans up any stale resident, posts a cancelled/failed notice, and records accordingly. Resident lifecycle and in-thread routing live in [13-resident-agent](13-resident-agent.md).

### Failures always surface (never silence)

Every failure mode posts in-thread: a triage throw, a workflow throw, and budget exhaustion (which the engine raises as a run error) all flow through the `catch` blocks above into a `:warning:`/`:octagonal_sign:` reply and an audit record. Slack posting itself is wrapped in `safeSay`, which logs (never throws) if Slack rejects the message, so a posting failure cannot crash `handle()`.

### Presentation helpers

`src/dispatcher/format.ts` keeps reply wording pure and testable:

- `shortLabel(text)` — one-line, whitespace-collapsed label (≤48 chars, ellipsised) used for queue entries.
- `formatResult(result)` — prefers a `summary` or `answer` string field; otherwise pretty-prints JSON in a code fence.
- `formatStatus(status)` — renders the queue's active + queued labels for the `status` control command.
- `errorMessage(err)` — `Error.message` or `String(err)`, used in every error reply and audit `detail`.

### Audit

Every terminal outcome calls `record()`, which stamps `teamId`, `userId`, `channel`, `threadTs`, and `text` onto an audit row with the outcome and extras — outcomes used here include `refused`, `clarification`, `dispatched`, `completed`, `failed`, `cancelled`, `resident-input`, and `resident-ready` ([09-audit-log](09-audit-log.md)).

## Capabilities

- Run one ordered, non-throwing pipeline per inbound message (auth → control → resident → clarify-merge → queue → process).
- Collapse low confidence, unknown workflow id, and arg-schema misses into a single clarification reply (4A).
- Park a clarification per thread with a TTL, check-on-access eviction, and periodic sweep (8A), re-running triage with `[follow-up]` context on the reply.
- Echo the chosen workflow and extracted args in the dispatch ack (5A).
- Route normal entries to an in-thread run with a Slack approval channel, and `surfaced` entries to the concurrent surfaced lane.
- Guarantee an in-thread error reply for every failure (triage, workflow, budget, cancellation) and an audit record for every outcome.

## Boundaries

- Does not classify intent or extract args (triage, [03-triage](03-triage.md)) and does not own the workflow menu or schemas (registry, [04-workflow-registry](04-workflow-registry.md)).
- Does not implement queue admission, FIFO, or single-flight policy — only calls `queue.enqueue` ([06-single-flight-queue](06-single-flight-queue.md)).
- Does not render approval prompts or serialize approvals — it wires an `ApprovalChannel` and delegates ([08-escalation-approvals](08-escalation-approvals.md)).
- Does not manage resident sessions or the AgentBus envelope — it launches and hands off ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md), [13-resident-agent](13-resident-agent.md)).
- The thread store is in-memory only; clarifications do not survive a restart.

## Traceability

- **Design**: see `docs/tohru.hanai-main-design-20260611-235421.md` — decision 4A (low confidence, unknown workflow id, or schema failure all collapse to one clarification path), 5A (the dispatch acknowledgment echoes the chosen workflow and extracted args), and 8A/D9 (thread-state entries carry a TTL with check-on-access plus periodic sweep; an expired clarification is treated as a fresh request); D11 (approvals use Block Kit buttons and never consume thread replies).
- **Modules**: `src/dispatcher/dispatcher.ts`, `src/dispatcher/decide.ts`, `src/dispatcher/format.ts`, `src/thread-state.ts`.
- **Related FR**: [03-triage](03-triage.md) produces the `TriageResult` `decide()` consumes; [04-workflow-registry](04-workflow-registry.md) supplies the entry, schema, and budget; [02-authorization](02-authorization.md) gates the pipeline first; [06-single-flight-queue](06-single-flight-queue.md) admits and serializes the work; [08-escalation-approvals](08-escalation-approvals.md) handles in-thread tool approvals during a run; [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md) and [13-resident-agent](13-resident-agent.md) own the surfaced launch and resident routing.

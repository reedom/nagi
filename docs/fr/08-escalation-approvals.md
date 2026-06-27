---
refs:
  id: fr:08-escalation-approvals
  kind: fr
  title: "Escalation & Approvals"
  spec: nagi-v1
  depends_on:
    - fr:01-slack-front-door
  related:
    - fr:05-request-dispatch
    - fr:12-agentbus-surfaced-lane
  modules:
    - src/escalation/
---

# FR 08: Escalation & Approvals

> When a running workflow needs a human's permission to use a tool, nagi turns the engine's `ApprovalChannel` into a Slack conversation: it posts a Block Kit message with **Approve** / **Deny** buttons in the same thread, blocks the run until the human clicks, then edits the message to record the verdict. The button carries the request id (D11), so a click resolves exactly one pending approval — misrouting is structurally impossible, and there is no text "approve/deny" parser to fool. Concurrent asks from a parallel swarm are serialized to one question at a time (1A).

## Purpose

This feature is nagi's Slack implementation of the engine's reverse-escalation broker. The workflow engine drives forward (Slack → workflow), but a workflow sometimes needs to drive *backward* — to ask the operator "may I run this tool?" mid-run. The engine expresses that need through an abstract `ApprovalChannel`; nagi supplies the Slack-native one (`makeSlackApprovalChannel`, `src/escalation/slack-channel.ts`). It owns three concerns: rendering the question safely, holding the run until a human decides, and guaranteeing the decision routes back to the exact `request()` call that asked.

## User-visible Behavior

### The approval round-trip

When a workflow calls `channel.request(req)` with a `PermissionRequest`, `makeSlackApprovalChannel` runs one `handle()` cycle (`src/escalation/slack-channel.ts`):

1. Mint a unique `requestId` via the injected `newId()`.
2. Format the tool input and build the Block Kit message (`buildApprovalBlocks`), then `gate.post(text, blocks)` it into the run's thread ([01-slack-front-door](01-slack-front-door.md) owns the post via the `ApprovalGate` adapter).
3. If the input is too large to inline, attach it as a snippet (`gate.uploadSnippet`).
4. Register the `requestId` with the `ApprovalRegistry` and **await** the human's click (or, under `onTimeout: 'deny'`, a timer).
5. Once resolved, edit the original message (`gate.update`) to the decision blocks, fire the optional `onResolved` callback, and return the `PermissionDecision` to the engine.

### Block Kit message, buttons bound to the request id (D11)

`buildApprovalBlocks(req, requestId)` (`src/escalation/blocks.ts`) renders a `section` header — `:lock: *Approval needed* — \`<agentLabel>\` (<cli>) wants to run *<toolName>*` — followed by an `actions` block with two buttons:

| Button | `action_id` | `value` | style |
| --- | --- | --- | --- |
| Approve | `nagi_approve` (`APPROVE_ACTION`) | `requestId` | `primary` |
| Deny | `nagi_deny` (`DENY_ACTION`) | `requestId` | `danger` |

The `requestId` rides on the button's `value`. When the click arrives, the front door's action handler reads `action.value` and calls `approvals.resolve(value, decision)` ([01-slack-front-door](01-slack-front-door.md)). Because the id is carried *by the button itself*, a click can only ever resolve the approval it was minted for — there is no free-text "approve"/"deny" command to parse, and a stray reply in the thread cannot be mistaken for a verdict (D11).

### Tool input is shown, never silently truncated

`formatToolInput(input)` renders a string input as-is, otherwise pretty-prints JSON (`JSON.stringify(input, null, 2)`), falling back to `String(input)` if that throws. `shouldInline(formatted)` returns true while the payload is `<= INLINE_LIMIT` (2500 chars):

- **Inline**: the input is shown in a fenced code block inside the message body.
- **Oversized**: the body reads *"Tool input is large; full payload attached as a snippet below."* and the full payload is uploaded as a `.txt` snippet to the thread.

Either way the human sees exactly what the agent will run — a large payload is moved, not cut.

### Decision is recorded on the original message

After resolution, `buildDecisionBlocks(req, decision)` replaces the buttons with a single section: `:white_check_mark: Approved` or `:no_entry: Denied`, naming the tool and `agentLabel`, with the decision's `reason` appended when present (the front door sets it to `approved`/`denied by <@user>`). The buttons disappear, so the same approval cannot be clicked twice.

### One question per thread at a time (1A)

`makeSlackApprovalChannel` serializes concurrent `request()` calls internally. It chains each call onto a `tail` promise, so a parallel swarm that fires several approval asks at once produces **one outstanding question at a time, in arrival order** — the next is posted only after the previous resolves. The chain advances regardless of whether the prior request was approved, denied, or rejected, so one stuck or failed ask never wedges the queue (1A).

### Resolution registry

`ApprovalRegistry` (`src/escalation/approval-registry.ts`) is the in-memory map from `requestId` to the pending resolver. `register(id, resolve)` stores it; `resolve(id, decision)` looks it up, deletes it, invokes it, and returns whether a match was found (the front door logs an "unknown/expired request" warning on a miss). A resolver fires exactly once — `resolve` removes the entry before calling it.

### Timeout policy: default `wait`, capped by the adapter

`waitForDecision` honors the request's `policy` (or the engine's `DEFAULT_POLICY`). The dispatcher's in-thread lane sets `defaultPolicy: { onTimeout: 'wait' }` ([05-request-dispatch](05-request-dispatch.md)):

- **`wait`** — nagi sets no concierge-side timer; the approval stays open until clicked. This is not literally indefinite: the claude adapter caps its permission hook at a 24h ceiling, so `wait` means "up to that ceiling," after which the adapter itself gives up (D11/onTimeout).
- **`deny`** — nagi arms a cancellable `schedule(...)` timer for `policy.timeoutMs`; on expiry it resolves the approval with `{ behavior: 'deny', reason: 'approval timed out' }`. The timer is cleared the moment a human clicks.

### Surfaced lane reuses the same channel

The AgentBus bridge ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)) constructs the *same* `makeSlackApprovalChannel` for surfaced runs (`src/agentbus-bridge/bridge.ts`): an `ask`/`approval` envelope is turned into a `PermissionRequest` (`agentLabel: 'surface'`, `cli: 'cmux'`), posted via `makeGate` to the run's bound thread, and the resulting `PermissionDecision` is sent back over agentbus. Every escalation guarantee here — D11 button binding, snippet handling, the shared registry — applies identically to surfaced runs.

## Capabilities

- Implement the engine's `ApprovalChannel` over a Slack thread: post a Block Kit question, block the run, resolve on a button click, and edit the message to the verdict.
- Bind Approve/Deny to the request id via `action_id` + `value` so a click resolves exactly one approval (D11); no text approve/deny parser exists.
- Show tool input inline in a code block, and attach oversized payloads as a snippet rather than truncating them.
- Serialize concurrent escalations from a parallel swarm to one outstanding question per thread, in arrival order (1A).
- Support `onTimeout: 'wait'` (default; bounded by the adapter's 24h ceiling) and `onTimeout: 'deny'` (concierge-side timer that auto-denies).
- Share the identical channel implementation with the surfaced lane via the AgentBus bridge.

## Boundaries

- Does not receive Slack events or button clicks — it depends on the front door to post messages and deliver action callbacks into the registry ([01-slack-front-door](01-slack-front-door.md)).
- Does not decide *whether* a tool needs approval or what the timeout values are — the engine and the calling workflow supply the `PermissionRequest` and `policy`; nagi only brokers them.
- Does not implement the 24h ceiling — that is the claude CLI adapter's own hook limit; nagi's `wait` simply declines to add a shorter one.
- The `ApprovalRegistry` is in-memory only; pending approvals do not survive a daemon restart.
- Does not own the surfaced run's lifecycle or envelope routing — it only lends its channel to the bridge ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)).

## Traceability

- **Design**: see `docs/tohru.hanai-main-design-20260611-235421.md` — decision 1A (serialization: one approval question outstanding per thread at a time, internal FIFO) and D11 (Block Kit Approve/Deny buttons bound to the request id, eliminating any text approve/deny parser and making misrouted approvals structurally impossible; `onTimeout: 'wait'` bounded by the claude adapter's 24h hook ceiling). The 24h ceiling itself is an adapter property surfaced as design-only context here.
- **Modules**: `src/escalation/` (`slack-channel.ts`, `blocks.ts`, `approval-registry.ts`).
- **Related FR**: [01-slack-front-door](01-slack-front-door.md) posts the message and delivers the button click that resolves the registry (hard dependency); [05-request-dispatch](05-request-dispatch.md) wires the channel into in-thread runs with `onTimeout: 'wait'`; [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md) reuses the same channel for surfaced runs via the AgentBus bridge.

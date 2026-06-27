---
refs:
  id: fr:01-slack-front-door
  kind: fr
  title: "Slack Front Door"
  spec: nagi-v1
  related:
    - fr:05-request-dispatch
    - fr:08-escalation-approvals
    - fr:11-daemon-lifecycle
  modules:
    - src/slack/
    - src/types.ts
---

# FR 01: Slack Front Door

> The Slack front door is nagi's only ingress. A `@slack/bolt` socket-mode app listens for bot mentions and DMs, normalizes each into a `RequestContext`, and hands it to the dispatcher. The same app routes Approve/Deny button clicks back into the approval machinery and exposes a thread-scoped poster used for every reply. All decision logic lives elsewhere; this layer only translates between Slack and nagi's domain.

## Purpose

nagi is a personal daemon driven entirely from Slack — "Slack becomes the
remote control". There is no HTTP server, CLI prompt, or other ingress. Because
the connection uses an app-level token in Socket Mode, nagi needs no public
inbound endpoint and can run on a laptop or behind NAT. This FR covers the thin
translation seam (`src/slack/`): turning Slack events into a normalized
`RequestContext`, posting threaded replies, and carrying approval button clicks
back to the registry. Keeping this layer thin and Slack-specific is what lets
triage, dispatch, queueing, and escalation stay decoupled from the chat
transport.

## User-visible Behavior

### Connecting (Socket Mode)

`createSlackBot` constructs a Bolt `App` with `socketMode: true`, the bot token
(`secrets.botToken`), and the app-level token (`secrets.appToken`). On
`start()` it calls `app.start()` and logs `nagi is listening (socket mode)`.
Per the README setup, the Slack app must have **Socket Mode** enabled, an
app-level token with `connections:write` (`SLACK_APP_TOKEN`, `xapp-…`), and
**Interactivity** enabled (required for the approval buttons). Daemon wiring and
process lifecycle are owned by [11-daemon-lifecycle](11-daemon-lifecycle.md).

### Events and scopes

Two bot event subscriptions are handled:

| Event | Source | Handler |
|---|---|---|
| `app_mention` | @-mention in a channel | `dispatch` |
| `message` (`channel_type === 'im'`) | direct message | `dispatch` |

DMs and channel mentions are handled separately so a channel mention that also
fires a generic `message` event is not processed twice. Required **Bot Token
Scopes** (README): `app_mentions:read`, `chat:write`, `im:history`, `im:read`,
`im:write`, `files:write`.

### Inbound normalization → RequestContext

`toRequestContext` maps a raw Slack event into the domain type defined in
`src/types.ts`:

```ts
interface RequestContext {
  teamId: string;
  channel: string;
  threadTs: string; // thread root ts; replies land here
  userId: string;
  text: string;
}
```

- `teamId` comes from Bolt's `context.teamId`; `userId`/`channel`/`ts` from the
  event. If any of `teamId`, `event.user`, `event.channel`, or `event.ts` is
  missing, the event is dropped (returns `undefined`).
- `threadTs` is `event.thread_ts ?? event.ts`, so a top-level message starts a
  new thread and a reply joins its existing one.
- `text` is run through `stripMentions`, which removes `<@…>` mention tokens and
  collapses whitespace.

`dispatch` ignores nagi's own posts: events with a `bot_id`, or whose `userId`
equals `context.botUserId`, are skipped to prevent self-triggering loops. Valid
requests are passed to `deps.handle(req)`; a thrown handler is caught and logged
(`handle threw`) so the socket connection never dies on one bad request. The
authorization gate (team/user allowlist) is applied downstream in
[02-authorization](02-authorization.md), and the handler routes into triage and
dispatch per [05-request-dispatch](05-request-dispatch.md).

### Outbound: SlackPoster, repliers, and the approval gate

`src/slack/ports.ts` defines a minimal `SlackPoster` port (`postMessage`,
`update`, `uploadSnippet`) decoupled from Bolt so adapters are unit-testable
with a fake. `boltPoster` adapts Bolt's `client.chat` / `client.files.uploadV2`
to this port and is exposed as `bot.poster`. Two thread-scoped factories build
on it:

- `makeReplier(poster, channel, threadTs)` → a `ThreadReplier` whose `say(text)`
  posts plain text into the request's thread.
- `makeGate(poster, channel, threadTs)` → an `ApprovalGate` (`post` / `update` /
  `uploadSnippet`) used to render and edit Block Kit approval messages in the
  thread. `post` throws if Slack returns no message `ts`.

### Approval button clicks

`registerApprovalActions` registers Bolt action handlers for the
`APPROVE_ACTION` and `DENY_ACTION` ids (from `src/escalation/blocks.js`). On a
click it `ack()`s, reads the request id from `action.value`, and calls
`approvals.resolve(requestId, { behavior: 'allow' | 'deny', reason })`, where
`reason` names the clicking user (e.g. `approved by <@U…>`). An unknown or
expired request id is logged (`approval click for unknown/expired request`) and
otherwise ignored. The Block Kit message format, serialization, and timeout
policy live in [08-escalation-approvals](08-escalation-approvals.md).

## Capabilities

- Single ingress over Socket Mode with no public inbound endpoint.
- Normalizes both channel mentions (`app_mention`) and DMs (`message.im`) into
  one `RequestContext` shape.
- Threads every reply to the originating message via `threadTs`.
- Suppresses self-triggered events (`bot_id` / own `botUserId`).
- Isolates per-request handler failures so the socket stays connected.
- Provides a Bolt-free `SlackPoster` port so reply and gate adapters are
  fake-testable.
- Routes Approve/Deny clicks to the `ApprovalRegistry` keyed by request id.

## Boundaries

- No decision logic here: authorization, triage, dispatch, queueing, and audit
  all live downstream.
- Only `app_mention` and `message.im` are handled; other Slack events, slash
  commands, and shortcuts are out of scope for v1.
- Approval click handling resolves a registry entry only; the approval UX
  (blocks, serialization, timeouts) is owned by FR 08.
- No reconnect/backoff tuning beyond Bolt's defaults; crash recovery is
  fail-fast under launchd (see FR 11).
- Acknowledges clicks but does not itself update the button message on resolve;
  message edits flow through the `ApprovalGate`/escalation layer.

## Traceability

- **Design**: `docs/tohru.hanai-main-design-20260611-235421.md` — the `slack/`
  module description (app-mention/DM → `RequestContext`), the socket-mode +
  app-level-token decision, and the Block Kit Approve/Deny approach bound to a
  request id (decision D11); thread replies feed clarification only, never
  approvals (D11). Archival design pointer, not a graph node.
- **Modules**: `src/slack/` (`app.ts`, `ports.ts`) and `src/types.ts`
  (`RequestContext`, `ThreadReplier`).
- **Related FR**:
  - [05-request-dispatch](05-request-dispatch.md) — receives the
    `RequestContext` via `handle()` and drives triage/dispatch.
  - [08-escalation-approvals](08-escalation-approvals.md) — owns the Block Kit
    approval UX that this layer's button clicks resolve.
  - [11-daemon-lifecycle](11-daemon-lifecycle.md) — wires and starts the bot and
    governs crash recovery.

# nagi — AI Concierge

A long-running personal daemon that turns a Slack message into a deterministic,
budgeted, human-escalating multi-agent workflow run on your own machine, and
replies in the same Slack thread.

Message the bot from your phone → it classifies the request (LLM triage), picks
a registered [`ai-workflow-engine`](../ai-workflow-engine) workflow, runs it with
real local agent CLIs (`claude`, `codex`), surfaces any mid-run tool-approval
requests as buttons in the thread, and posts the result back. This is the v1
"thin slice" of the design in [`docs/`](./docs).

## How it works

```
Slack message → allowlist gate → triage (claude, JSON schema)
   → registry lookup + arg validation → runWorkflow(engine)
   → result in-thread.  Mid-run: approval buttons in-thread.
```

- **Triage** is a single direct call to the claude adapter (its own model,
  timeout, and token cap; escalation disabled). It returns
  `{workflowId, args, confidence, clarificationQuestion?}`.
- **Dispatch** validates the extracted args against the chosen workflow's zod
  schema. Low confidence, an unknown workflow, or a schema miss all collapse to
  one **clarification** reply in-thread; your reply re-runs triage with the
  original request appended.
- **Escalation**: when an agent hits a tool that needs approval, nagi posts a
  Block Kit message with **Approve**/**Deny** buttons bound to the request id.
  Concurrent approvals from a parallel swarm are serialized — one question at a
  time. Default policy is `wait` (the claude adapter caps the hook at 24h).
- **Single-flight**: one workflow runs at a time; a second request is queued
  with a "busy, queued" reply and runs when the current one finishes.
- **Control commands**: send `status` to see the queue, or `cancel`/`stop` to
  kill the active run and drop the queue. These bypass the workflow queue.
- **Audit**: every request appends a line to `audit.jsonl` (identity, text,
  chosen workflow, args, approvals, outcome). Best-effort — never crashes the
  request path.

## Authorization (required, not optional)

The claude adapter grants unrestricted Bash on the host. nagi therefore refuses
any message whose Slack **team id** is not `slack.allowedTeamId` or whose user
is not in `slack.allowedUserIds` — before triage or any engine call.

## Repos are aliases

Workflows reference repositories by **alias** (`repos` in the config), never a
free-form path. A request for an unknown repo gets a clarification listing the
valid aliases. The dispatcher sets the run-level `cwd` to the alias's absolute
path, so agents operate inside the target repo.

## Setup

1. **Create a Slack app** (https://api.slack.com/apps → from scratch).
   - **Socket Mode**: enable; create an **App-Level Token** with
     `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`).
   - **Interactivity**: enable (required for approval buttons).
   - **Event Subscriptions** (bot events): `app_mention`, `message.im`.
   - **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `im:history`,
     `im:read`, `im:write`, `files:write`.
   - Install to your workspace → **Bot User OAuth Token** → `SLACK_BOT_TOKEN`
     (`xoxb-…`).

2. **Configure**:
   ```sh
   cp .env.example .env                      # add the two tokens
   cp nagi.config.example.json nagi.config.json   # set team/user ids + repo aliases
   ```
   Find your team id and user id from any Slack profile / `auth.test`.

3. **Build & run**:
   ```sh
   pnpm install
   pnpm build
   pnpm start            # or: pnpm dev (tsx, no build)
   ```
   DM the bot, or @-mention it in a channel it's in.

## Always-on (launchd)

`deploy/com.reedom.nagi.plist` runs nagi under launchd with `KeepAlive`. Crash
recovery is fail-fast: any unhandled fault exits non-zero and launchd restarts a
clean process. Edit the paths/tokens, `chmod 600`, copy to
`~/Library/LaunchAgents/`, and `launchctl load` it.

## Workflows

Seed workflows live in `src/registry/workflows/`:
- **`review-repo`** — review a repo (or its working diff) and summarize risks.
- **`research`** — research a question from several angles in parallel, then
  synthesize (exercises approval serialization + budget under concurrency).

A registry entry is `{ id, description, argsSchema (zod), module }` where
`module` is a real engine `WorkflowModule`. Add one in
`src/registry/index.ts`'s `SEED_FACTORIES`; it becomes triageable immediately.

## Triage eval

`test/fixtures/triage-cases.ts` holds the golden set (one per workflow +
clarification + unknown-repo triggers). `pnpm test` always checks the dataset's
integrity. To run it against the live model:

```sh
NAGI_EVAL_LIVE=1 pnpm test
```

Grow the set from real `audit.jsonl` misfires.

## Tests

```sh
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
```

## Known v1 limitations (by design)

- **In-memory queue**: in-flight and queued work is lost on restart. The v1.5
  path is to replay un-terminated `audit.jsonl` entries (with idempotency care).
- **Cancellation is best-effort**: the engine exposes no `AbortSignal`, so
  `cancel` kills the daemon's descendant agent processes by process tree. A
  clean engine-level cancellation token is the documented follow-up.
- Single workflow at a time; no progress streaming. Both stack on top of this
  slice without rework (daemon hardening = v1.5; the workflow foundry = v2).

## Relationship to the engine

nagi consumes `ai-workflow-engine` as a library (`runWorkflow`, the adapter
factories, and the `ApprovalChannel` types). The engine stays a clean,
process-exit-free runtime; nagi owns the Slack front door, triage, registry,
queue, audit, and the Slack `ApprovalChannel`.

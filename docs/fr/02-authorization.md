---
refs:
  id: fr:02-authorization
  kind: fr
  title: "Authorization"
  spec: nagi-v1
  related:
    - fr:01-slack-front-door
    - fr:05-request-dispatch
    - fr:09-audit-log
  modules:
    - src/auth/allowlist.ts
---

# FR 02: Authorization

> A non-optional allowlist gate that pins both the Slack workspace and the
> requesting user before any inbound message can reach triage or an engine
> call. It runs first in the dispatch pipeline because the underlying CLI
> adapters grant unrestricted Bash on the host.

## Purpose

nagi drives the `claude` and `codex` CLI adapters, which execute with
unrestricted Bash on the host machine. Any message that reaches triage can
therefore cause arbitrary commands to run. Authorization is consequently a v1
requirement, not a tunable option (D14): every request must clear a fixed
allowlist before nagi will act on it.

## User-visible Behavior

### The gate

`checkAuth(config, req)` inspects only `req.teamId` and `req.userId` and returns
an `AuthResult` of `{ allowed: boolean; reason?: string }`. A request must clear
BOTH of two independent checks, evaluated in order:

| Order | Check | Source field | Failure `reason` |
|---|---|---|---|
| 1 | Workspace pin | `slack.allowedTeamId` (single id) | `workspace not allowlisted` |
| 2 | User allowlist | `slack.allowedUserIds` (non-empty array) | `user not allowlisted` |

The team-id pin is checked first: a request from the wrong workspace is refused
without consulting the user list. Only a request whose `teamId` equals the
configured `allowedTeamId` AND whose `userId` is included in `allowedUserIds`
receives `{ allowed: true }`. See [10-configuration](10-configuration.md) for
how these keys are validated (`allowedTeamId` is a required non-empty string;
`allowedUserIds` must contain at least one entry).

### Refusal message

A blocked request gets one fixed reply, posted to the thread via the replier:

```
Sorry, I can't act on requests from this account. Ask the operator to add you to the allowlist.
```

This is the exported `REFUSAL_MESSAGE` constant. The internal `reason` from
`AuthResult` is never shown to the user; it is recorded only in the audit log.

### Placement in the pipeline

The gate is the first thing `Dispatcher.handle()` does after building the
replier, ahead of control-command parsing, resident routing, and queueing. When
`checkAuth` returns `allowed: false`, the dispatcher posts `REFUSAL_MESSAGE` and
returns immediately — triage, the work queue, and every engine adapter are
never reached. See [05-request-dispatch](05-request-dispatch.md) for the full
ordering of steps that follow a successful gate.

### Refused requests are still audited

A refusal is not silent. Before returning, the dispatcher records the request
with outcome `'refused'`, attaching `{ detail: <reason> }` when `checkAuth`
supplied one (e.g. `workspace not allowlisted` or `user not allowlisted`). The
audit entry carries the same identity and message fields as any other request
(`teamId`, `userId`, `channel`, `threadTs`, `text`). `'refused'` is one of the
enumerated audit outcomes. See [09-audit-log](09-audit-log.md).

## Capabilities

- Pins a single trusted Slack workspace via `slack.allowedTeamId`.
- Restricts action to an explicit set of Slack users via `slack.allowedUserIds`.
- Returns a structured `AuthResult` with a machine-readable `reason` on failure.
- Fails closed: any request not matching both checks is refused.
- Produces an auditable `'refused'` record for every blocked request, including
  the failure reason.
- Posts a single, uniform refusal message regardless of which check failed (the
  reason is not leaked to the requester).

## Boundaries

- No per-workflow or per-command permission rules — authorization is a single
  identity gate, not a capability matrix (per-workflow permission rules beyond
  the user allowlist are out of scope by design).
- Only `teamId` and `userId` are consulted; channel, thread, or message content
  play no part in the decision.
- No roles, groups, or hierarchy: `allowedUserIds` is a flat membership list.
- The allowlist is static configuration; nagi has no in-band command to add or
  remove users (the refusal message directs the requester to the operator).
- Credentials never participate: Slack tokens come from the environment, and the
  audit trail records identities, not secrets (D14).

## Traceability

- **Design**: `docs/tohru.hanai-main-design-20260611-235421.md` (archival) —
  Authorization as a v1 requirement and the auth gate pinning workspace/team ID
  alongside the user allowlist (decision D14); README.md "Authorization
  (required, not optional)".
- **Modules**: `src/auth/allowlist.ts` (`checkAuth`, `AuthResult`,
  `REFUSAL_MESSAGE`).
- **Related FR**:
  - [01-slack-front-door](01-slack-front-door.md) — supplies the `teamId` and
    `userId` on the `RequestContext` the gate inspects.
  - [05-request-dispatch](05-request-dispatch.md) — places the gate first in the
    dispatch pipeline, ahead of triage and queueing.
  - [09-audit-log](09-audit-log.md) — records every refused request with outcome
    `'refused'` and the failure reason.

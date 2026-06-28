---
refs:
  id: fr:09-audit-log
  kind: fr
  title: "Audit Log"
  spec: nagi-v1
  related:
    - fr:05-request-dispatch
    - fr:10-configuration
  modules:
    - src/audit.ts
---

# FR 09: Audit Log

> Every request nagi handles appends exactly one line to an append-only JSONL audit log (D14): who asked, the raw text, the chosen workflow and args, how many approvals it took, and the terminal outcome. Writes are best-effort — a logging failure is warned and swallowed, never crashing the request path — and the resulting file is the golden-set seed for triage eval.

## Purpose

The audit log is the durable record of *what nagi was asked to do and what it did*. Because the claude adapter grants unrestricted Bash on the host, the trail records identities and intent for accountability. It deliberately stores identities, not credentials (Slack tokens come from the environment, never config). The same file is the raw material the triage golden set grows from ([03-triage](03-triage.md)): real misfires in `audit.jsonl` become new eval cases.

## User-visible Behavior

### `makeAuditLog(path, log, clock?)`

`makeAuditLog` (`src/audit.ts`) returns an `AuditLog` with a single `record(entry)` method. Each call serializes `{ ts, ...entry }` to one line of JSON and `appendFileSync`s it to `path`. The timestamp is injected by the log itself — callers pass `Omit<AuditEntry, 'ts'>`; `ts` defaults to `new Date().toISOString()` via an injectable `clock` (tests substitute a fixed clock).

### Entry shape

One JSON object per line (`AuditEntry`):

| Field | Type | Always present? | Source |
| --- | --- | --- | --- |
| `ts` | string (ISO 8601) | yes | injected by `record()` via `clock()` |
| `teamId` | string | yes | `req.teamId` |
| `userId` | string | yes | `req.userId` |
| `channel` | string | optional | `req.channel` |
| `threadTs` | string | optional | `req.threadTs` |
| `text` | string | yes | `req.text` (raw inbound text) |
| `outcome` | `Outcome` | yes | the terminal category (see below) |
| `workflowId` | string | optional | the triaged/dispatched workflow id |
| `args` | unknown | optional | the workflow args |
| `approvals` | number | optional | escalation approvals resolved during the run |
| `detail` | string | optional | free-form reason (refusal reason, error, control sub-command) |
| `tokens` | number | optional | reserved by `AuditEntry`; not currently written — deferred |

The base fields (`teamId`, `userId`, `channel`, `threadTs`, `text`, `outcome`) are filled by the dispatcher's `record()` helper from the `RequestContext`; `workflowId` / `args` / `approvals` / `detail` ride in as the `extra` overlay per call site ([05-request-dispatch](05-request-dispatch.md)).

### Outcome values

Every request outcome from the dispatcher maps to exactly one of these (`Outcome` in `src/types.ts`, all reached from `src/dispatcher/dispatcher.ts`):

| `outcome` | When recorded |
| --- | --- |
| `refused` | auth gate denied the message ([02-authorization](02-authorization.md)); `detail` carries the reason |
| `control` | a control word ran (`status` / `done` / `cancel`); `detail` names the sub-command ([07-control-commands](07-control-commands.md)) |
| `clarification` | triage confidence too low; a question was parked and posted |
| `dispatched` | a workflow was selected and the "On it" ack was sent |
| `completed` | a dispatched run finished; `approvals` reflects gates resolved |
| `failed` | triage threw, a run threw, or a resident send failed; `detail` carries the error |
| `cancelled` | `cancel`/`stop` tore down active work, or a run rejected while cancelling |
| `resident-input` | an in-thread message was piped into a live resident REPL ([13-resident-agent](13-resident-agent.md)) |
| `resident-ready` | a surfaced run finished and its surface is live for follow-up ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)) |

A single request can produce more than one line over its lifetime: e.g. `dispatched` then `completed`/`failed`/`cancelled`, or `resident-ready` then later `resident-input`.

### Best-effort semantics

`record()` wraps `appendFileSync` in a try/catch. On failure it calls `log.warn('audit write failed', { error })` and returns — the request path continues. Auditing is observability, never a precondition: a full disk or a bad path degrades the trail but does not drop a reply or kill a run.

## Capabilities

- Append-only JSONL: one self-describing line per recorded outcome, greppable and replay-friendly.
- Identity + intent capture: team, user, channel, thread, raw text, chosen workflow, args, approvals, outcome.
- Injectable clock for deterministic tests.
- Crash-safe writes: failures are logged and swallowed.
- Feeds the triage eval golden set — misfires become regression cases ([03-triage](03-triage.md)).

## Boundaries

- **Not a queue journal.** The log records request outcomes, not in-flight queue state; in-memory queued/in-flight work is still lost on restart ([06-single-flight-queue](06-single-flight-queue.md)).
- **No crash recovery in v1.** The documented v1.5 path is to replay un-terminated `audit.jsonl` entries (with idempotency care) to recover interrupted work — out of scope here.
- **No `tokens` accounting yet.** `AuditEntry.tokens` exists for D14's "token usage" goal but no call site populates it — deferred.
- **No rotation/retention/redaction.** The file grows unbounded; lifecycle management is left to the operator.

## Traceability

- **Design decisions**: D14 (append-only JSONL audit log: timestamp, team/user, raw text, chosen workflow, args, approvals, token usage, outcome; best-effort writes that never crash the request path).
- **Modules**: `src/audit.ts`.
- **Related FR**: [05-request-dispatch](05-request-dispatch.md) — the dispatcher is the sole caller of `record()` and the source of every outcome; [10-configuration](10-configuration.md) — `auditLogPath` (default `./audit.jsonl`) sets where the log is written.

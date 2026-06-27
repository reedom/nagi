---
refs:
  id: fr:11-daemon-lifecycle
  kind: fr
  title: "Daemon Lifecycle"
  spec: nagi-v1
  depends_on:
    - fr:10-configuration
  related:
    - fr:01-slack-front-door
    - fr:12-agentbus-surfaced-lane
  modules:
    - src/index.ts
    - src/logger.ts
    - src/util/id.ts
    - src/util/timeout.ts
    - deploy/com.reedom.nagi.plist
---

# FR 11: Daemon Lifecycle

> nagi is a single long-running process. `main` is the composition root that wires every collaborator in a fixed order and starts the Slack bot; a structured stderr logger, prefixed id minting, and a promise-timeout helper are its small shared utilities; and a fail-fast crash policy paired with launchd `KeepAlive` (6A) means any unhandled fault exits non-zero so a clean process restarts rather than limping on.

## Purpose

Everything in nagi hangs off one process started once and kept alive. `src/index.ts` `main` is the composition root: it loads inputs ([10-configuration](10-configuration.md)), constructs the registry, audit log, queue, thread store, approval/pending/resident registries, the agent adapters, the dispatcher ([05-request-dispatch](05-request-dispatch.md)) and the Slack bot ([01-slack-front-door](01-slack-front-door.md)), registers nagi on the agentbus and pumps its inbox ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)), schedules a periodic thread-state sweep, then blocks on `bot.start()`. The runtime policy is deliberately blunt (6A): rather than build in-process reconnection and recovery, an unhandled fault crashes the process and launchd restarts it clean.

## User-visible Behavior

### Startup order (`main`)

`main` runs these steps in sequence; a throw at any step is caught and exits the process non-zero (see [fail-fast](#fail-fast-crash-policy-6a)):

1. `loadDotenv()` — seed `process.env` from `.env` before any secret is read ([10-configuration](10-configuration.md)).
2. `loadConfig(NAGI_CONFIG ?? './nagi.config.json')` + `loadSecrets(process.env)` — validate config, read the two Slack tokens.
3. Build core collaborators: `repoAliases`, `makeRegistry`, `makeAuditLog`, `WorkQueue`, `makeThreadStore`, `ApprovalRegistry`, `PendingRuns`, `ResidentSessions`.
4. Build adapters: `makeClaudeAdapter()` (full Bash), `makeCodexAdapter({ sandbox: 'danger-full-access' })`, and a per-run cmux surface adapter factory `makeSurfaceAdapter(runId, …)` bound to the chosen `runId` and the `pending` registry, plus a best-effort `closeSurface` and a `cmuxHost`/`host` for driving resident REPLs.
5. Construct the `Dispatcher` ([05-request-dispatch](05-request-dispatch.md)) with all of the above, plus `newRunId: () => newId('run')` and `newApprovalId: () => newId('appr')`.
6. `createSlackBot(...)` ([01-slack-front-door](01-slack-front-door.md)); its `poster` is late-bound back into the dispatcher (the dispatcher only touches `poster` lazily, so the late binding is safe).
7. `await register(NAGI_INSTANCE, { persistent: true })` then start the inbox pump ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)).
8. Start the thread-state sweep interval.
9. `await bot.start()` — the process now lives in the Bolt socket-mode loop.

### Timing constants

Defined at the top of `src/index.ts`:

| Constant | Value | Role |
| --- | --- | --- |
| `SWEEP_INTERVAL_MS` | `5 * 60 * 1000` (5 min) | Period of the thread-state sweep `setInterval`. |
| `SURFACE_CEILING_MS` | `30 * 60 * 1000` (30 min) | Max wall-clock a surfaced run is awaited; passed to the dispatcher as `surfaceCeilingMs` ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)). |
| `NAGI_INSTANCE` | `'nagi'` | agentbus instance name used for `register`, `awaitInbox`, `reply`, and the surface adapter. |

### Thread-state sweep

`setInterval(() => { const removed = threadStore.sweep(); if (removed !== 0) logger.info('swept expired clarifications', { removed }); }, SWEEP_INTERVAL_MS)`. The interval is `unref()`'d so it never keeps the process alive on its own. It evicts expired clarification state ([03-triage](03-triage.md)) and logs only when it actually removed something.

### Structured logger (`src/logger.ts`)

A deliberately tiny `Logger` with `info` / `warn` / `error`, each taking a message and optional `meta` record. Output goes to **stderr** as `[nagi:<level>] <msg>{ …json meta }`; under launchd stderr is captured to `StandardErrorPath`. The single shared `logger` instance is threaded into the audit log, queue, dispatcher, bot, and bridge.

### Id minting (`src/util/id.ts`)

`newId(prefix)` returns `` `${prefix}_${randomUUID().slice(0, 8)}` `` — a short, prefixed, collision-resistant id. `main` uses it for run ids (`newId('run')`) and approval ids (`newId('appr')`, both in dispatch and in the agentbus bridge), keeping ids readable in logs and audit lines.

### Timeout helper (`src/util/timeout.ts`)

`withTimeout(work, ms, label)` rejects with a `TimeoutError` (`<label> timed out after <ms>ms`) if `work` has not settled in `ms`, clearing its timer on settle. It only bounds how long the request path **waits**; the underlying work (e.g. the short-lived triage CLI) is not killed. This backs the triage timeout ([03-triage](03-triage.md)).

### Fail-fast crash policy (6A)

Three handlers, all exiting non-zero so launchd starts a clean process instead of one limping in a half-broken state:

| Trigger | Handler | Effect |
| --- | --- | --- |
| `unhandledRejection` | logs `unhandledRejection` with the reason | `process.exit(1)` |
| `uncaughtException` | logs `uncaughtException` with the error | `process.exit(1)` |
| `main().catch(...)` (startup throw) | logs `startup failed` with the error | `process.exit(1)` |

### launchd integration (`deploy/com.reedom.nagi.plist`)

The plist runs `node dist/index.js` with `RunAtLoad` and `KeepAlive` both `true`, so a clean exit (from any of the three handlers above) is immediately relaunched. It carries `EnvironmentVariables` (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `NAGI_CONFIG`, `PATH`), a `WorkingDirectory`, and `StandardOutPath` / `StandardErrorPath` log files. Install is `cp` to `~/Library/LaunchAgents/` then `launchctl load`; the file holds tokens, so `chmod 600`. See [README](../../README.md) "Always-on (launchd)" and "Build & run".

### agentbus as a hard startup dependency

`await register(NAGI_INSTANCE, { persistent: true })` runs during startup, so a missing/broken agentbus binary throws and fails fast via the startup catch. Once running, the inbox pump tolerates transient faults: a failed `awaitInbox` poll is logged (`agentbus inbox poll failed`) and retried after a 1 s pause, so a hiccup never crashloops the daemon; a `handleEnvelope` that throws is caught and logged per-envelope. See [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md).

## Capabilities

- Wire the whole daemon in one fixed, fail-fast startup order and hand control to the Slack bot.
- Mint short prefixed run/approval ids and bound waits with a reusable promise timeout.
- Emit structured stderr logs captured by launchd.
- Sweep expired thread-state on a 5-minute, `unref`'d interval without holding the process open.
- Restart cleanly on any unhandled fault via fail-fast exits paired with launchd `KeepAlive` (6A).
- Treat agentbus registration as a hard startup dependency while keeping the inbox poll resilient to transient errors.

## Boundaries

- **No in-process reconnect/recovery (6A)**: there is no Bolt socket-mode reconnect handling or self-healing; an unhandled fault exits and relies on launchd to relaunch.
- **In-memory state lost on restart**: the queue, thread store, approval/pending/resident registries are all in-process; in-flight and queued work does not survive a restart ([06-single-flight-queue](06-single-flight-queue.md)). Audit-log replay is the deferred v1.5 path.
- **No hot reload**: config and secrets are read once in `main`; changes need a restart ([10-configuration](10-configuration.md)).
- **No graceful drain on shutdown**: the daemon does not wait for an active run to finish before exiting; the surface adapters' `closeSurface` is best-effort.
- **`withTimeout` does not cancel work**: it only stops waiting; killing processes is a separate concern ([07-control-commands](07-control-commands.md)).

## Traceability

- **Design**: see `docs/tohru.hanai-main-design-20260611-235421.md` — decision 6A (crash recovery is fail-fast + launchd `KeepAlive`: any unhandled fault exits non-zero and a clean process is restarted; in-memory queue loss on restart is accepted for v1, audit-log replay deferred to v1.5). README "Always-on (launchd)" documents the same operational contract.
- **Modules**: `src/index.ts` (`main` composition root, the timing constants, fail-fast handlers, inbox pump, sweep), `src/logger.ts` (structured stderr `logger`), `src/util/id.ts` (`newId`), `src/util/timeout.ts` (`withTimeout`/`TimeoutError`), `deploy/com.reedom.nagi.plist` (launchd agent).
- **Related FR**: [10-configuration](10-configuration.md) is loaded first in `main` and is the unit a restart re-reads; [01-slack-front-door](01-slack-front-door.md) is the last thing `main` starts and the live event loop the process runs in; [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md) is the registration + inbox pump `main` stands up and the consumer of `SURFACE_CEILING_MS`.

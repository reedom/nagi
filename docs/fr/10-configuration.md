---
refs:
  id: fr:10-configuration
  kind: fr
  title: "Configuration"
  spec: nagi-v1
  related:
    - fr:02-authorization
    - fr:03-triage
    - fr:04-workflow-registry
    - fr:11-daemon-lifecycle
  modules:
    - src/config.ts
    - src/util/env.ts
---

# FR 10: Configuration

> All operator-tunable settings live in one validated JSON object; secrets (the two Slack tokens) come only from the environment, never the config file. A zod schema parses and defaults the JSON; missing secrets fail fast at startup.

## Purpose

nagi splits its inputs cleanly: a JSON **config file** holds everything an operator tunes (workspace pin, user allowlist, repo scope allowlist, triage policy, budget, audit path), while **secrets** (Slack tokens) come from the environment. The split is deliberate — the audit log records identities, not credentials (D14), so tokens must never land in a file that could be committed or logged. `src/config.ts` is the single validated `NagiConfig` object the rest of the daemon reads; `src/util/env.ts` seeds `process.env` from an optional `.env` before secrets are read.

## User-visible Behavior

### Two sources, loaded in order

At startup (`src/index.ts` `main`) nagi:

1. `loadDotenv()` — best-effort `.env` load (see below), so `.env` values populate `process.env`.
2. Resolves the config path from `NAGI_CONFIG`, default `./nagi.config.json`.
3. `loadConfig(path)` — reads the file (a read failure throws `cannot read config at <path>: …`), `JSON.parse`s it, and validates with the zod `configSchema` (`parseConfig`). A schema violation throws and the daemon exits non-zero ([11-daemon-lifecycle](11-daemon-lifecycle.md)).
4. `loadSecrets(process.env)` — pulls the two Slack tokens, throwing if either is missing.

### JSON config schema

Validated by `configSchema` in `src/config.ts`. Every field below is what the code actually parses; unspecified optional fields take the listed default.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `slack.allowedTeamId` | `string` (non-empty) | required | Slack workspace/team id the auth gate pins to (D14). See [02-authorization](02-authorization.md). |
| `slack.allowedUserIds` | `string[]` (≥1, non-empty entries) | required | User-id allowlist; only these users may drive nagi (D14). See [02-authorization](02-authorization.md). |
| `repoScopes` | `string[]` (≥1, non-empty entries) | required | Host/owner glob allowlist. Only ghq repos whose path segment matches one of these prefix globs may be touched by an agent (security boundary). |
| `learnedReposPath` | `string` | `./learned-repos.json` | Path of the JSON file where ticket→repo-graph resolutions are persisted across runs. |
| `maxRepos` | `int` (positive) | `10` | Upper bound on how many repos a single ticket's dependency graph may grow to; protects against runaway graph expansion. |
| `worktree.script` | `string` (non-empty) | `scripts/worktree-provision.worktrunk.sh` | Script nagi invokes to create or enter a per-ticket worktree. Swapping this value selects the mechanism (worktrunk, plain git, or a custom script) without editing shipped files. The script runs with `cwd = repoPath`, `argv[1] = ticket`, and `NAGI_TICKET`/`NAGI_REPO_PATH` in the environment; it must print the worktree's absolute path as its final stdout line. |
| `triage.model` | `string` (non-empty) | `claude-sonnet-4-6` | Model the triage call uses. See [03-triage](03-triage.md). |
| `triage.confidenceThreshold` | `number` (0–1) | `0.6` | Below this, triage posts a clarification instead of dispatching. |
| `triage.timeoutMs` | `int` (positive) | `60000` | Timeout for the triage call (its own runtime policy, escalation disabled). |
| `triage.tokenCap` | `int` (positive) | `2000` | Advisory token ceiling for triage; an overrun is audited, not fatal. |
| `defaultBudget` | `int` (positive) or `null` | `null` | Default per-request token budget; `null` = unbounded. Registry entries may override it ([04-workflow-registry](04-workflow-registry.md)). |
| `auditLogPath` | `string` | `./audit.jsonl` | Path of the append-only JSONL audit log ([09-audit-log](09-audit-log.md)). |
| `cmux.socketPath` | `string` (non-empty) | _omitted_ | Optional explicit cmux socket for the surfaced lane ([12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)). |
| `cmux.password` | `string` (non-empty) | _omitted_ | Optional explicit cmux password. |
| `cmux.window` | `string` (non-empty) | _omitted_ | Optional explicit cmux window. |

`triage` itself defaults to `{}` (so all four sub-keys default individually), and the whole `cmux` block is optional.

### The optional `cmux` block

When `cmux` is omitted, the host runs `cmux` with no `--socket`/`--password` and cmux self-resolves from its own environment (`CMUX_SOCKET_PATH`, `CMUX_SOCKET_PASSWORD`), default socket, and saved settings. `src/index.ts` only forwards `socketPath`/`password` to the cmux adapter when present. Set this block only when nagi's environment does not inherit those vars (e.g. a bare launchd context); the env vars are preferred so the password stays out of the config file.

### Secrets and `.env`

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | Bot user OAuth token (`xoxb-…`); `loadSecrets` throws `SLACK_BOT_TOKEN is required` if unset. |
| `SLACK_APP_TOKEN` | yes | App-level socket-mode token (`xapp-…`); throws `SLACK_APP_TOKEN is required` if unset. |
| `NAGI_CONFIG` | no | Path to the JSON config; default `./nagi.config.json`. |
| `NAGI_ENV_FILE` | no | Path `loadDotenv` reads; default `.env`. |

`loadDotenv` (`src/util/env.ts`) is best-effort: a missing file is fine (under launchd the secrets come from the plist's `EnvironmentVariables` and there is no `.env`), so it returns silently. An existing-but-malformed file fails loudly — `process.loadEnvFile` propagates the parse error so the daemon refuses to start with broken secrets. Example files: `.env.example`, `nagi.config.example.json`; setup steps are in [README](../../README.md).

## Capabilities

- One validated `NagiConfig` object the whole daemon reads, with sensible defaults for triage, budget, and audit path.
- A `repoScopes` allowlist that enforces the security boundary: only ghq repos matching a configured host/owner glob prefix may be touched by an agent.
- Configurable learned-repos persistence path and repo-graph size cap (`learnedReposPath`, `maxRepos`).
- A swappable worktree provisioner script (`worktree.script`) that selects the mechanism (worktrunk, plain git, or custom) via a config value rather than a file edit.
- Optional explicit cmux access for the surfaced lane without forcing the password into the file.
- Secrets sourced from the environment, optionally seeded from a `.env` file via `NAGI_ENV_FILE`.

## Boundaries

- **No hot reload**: config and secrets are read once in `main`; changing the file requires restarting the daemon ([11-daemon-lifecycle](11-daemon-lifecycle.md)).
- **Secrets only via environment**: the two Slack tokens are never read from the JSON config (D14 keeps credentials out of the audited file).
- The config layer only parses and validates; it does not execute, enforce budgets, or apply auth — those live in dispatch, the queue, and the auth gate respectively.
- `.env` loading is best-effort for presence but strict for content: missing is fine, malformed aborts startup.

## Traceability

- **Design**: see `docs/tohru.hanai-main-design-20260611-235421.md` — D14 (append-only JSONL audit log plus team-ID pin and user allowlist; the audit trail records identities, not credentials, which is why secrets stay in the environment); and `docs/superpowers/specs/2026-06-28-conversational-repo-resolution-design.md` — R2 (scope allowlist as the security boundary), R5 (learned-repos JSON persistence), R8 (swappable worktree provisioner script), R10 (`maxRepos` cap).
- **Modules**: `src/config.ts` (`configSchema`/`NagiConfig`, `loadConfig`, `loadSecrets`), `src/util/env.ts` (`loadDotenv`).
- **Related FR**: [02-authorization](02-authorization.md) consumes `slack.allowedTeamId`/`allowedUserIds`; [03-triage](03-triage.md) consumes the `triage.*` block; [04-workflow-registry](04-workflow-registry.md) consumes `repoScopes`, `learnedReposPath`, `maxRepos`, `worktree.script`, and `defaultBudget`; [11-daemon-lifecycle](11-daemon-lifecycle.md) loads config/secrets at startup and is the unit restarted to apply changes.

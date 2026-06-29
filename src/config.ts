import { readFileSync } from 'node:fs';
import { z } from 'zod';

// All operator-tunable settings live in one validated object. Secrets (Slack
// tokens) come from the environment, never the config file (D14 audit trail
// records identities, not credentials).

const triageSchema = z.object({
  model: z.string().min(1).default('claude-sonnet-4-6'),
  // Below this, triage posts a clarification instead of dispatching.
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  // The triage call gets its own runtime policy (escalation disabled).
  timeoutMs: z.number().int().positive().default(60_000),
  // Advisory ceiling; an overrun is audited, not fatal (triage output is
  // schema-bounded and small).
  tokenCap: z.number().int().positive().default(2_000),
});

const configSchema = z.object({
  slack: z.object({
    // The auth gate pins the workspace AND the user allowlist (D14).
    allowedTeamId: z.string().min(1),
    allowedUserIds: z.array(z.string().min(1)).min(1),
  }),
  // The host/owner scope allowlist: ghq repos whose segments match one of
  // these globs are the only candidates an agent may ever touch (security).
  repoScopes: z.array(z.string().min(1)).min(1),
  // Where learned ticket->repo-graph resolutions persist (runtime-written).
  learnedReposPath: z.string().default('./learned-repos.json'),
  // Upper bound on a ticket's dependency graph; protects against runaway growth.
  maxRepos: z.number().int().positive().default(10),
  // The provisioner script nagi runs to create/enter a worktree. Selecting a
  // different script swaps the mechanism (worktrunk, plain git, ...).
  worktree: z
    .object({ script: z.string().min(1).default('scripts/worktree-provision.worktrunk.sh') })
    .default({}),
  // Optional explicit cmux access for the surfaced lane. When omitted, the host
  // runs `cmux` with no --socket/--password and cmux self-resolves from its env
  // (CMUX_SOCKET_PATH, CMUX_SOCKET_PASSWORD), default socket, and saved Settings.
  // Set this only when nagi's environment does NOT inherit those (e.g. bare
  // launchd); prefer the env vars otherwise to keep the password out of config.
  cmux: z
    .object({
      socketPath: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
      window: z.string().min(1).optional(),
    })
    .optional(),
  triage: triageSchema.default({}),
  // Default per-request token budget; entries may override (3A). null = unbounded.
  defaultBudget: z.number().int().positive().nullable().default(null),
  auditLogPath: z.string().default('./audit.jsonl'),
  // Default Claude permission mode for workflow agents; a workflow's
  // wf.agent({ permissionMode }) overrides it per call. Tunes claude's BUILT-IN
  // permission flow. nagi's Slack approval gate is a PermissionRequest hook — a
  // conditional substitute for claude's own prompt that fires ONLY when claude would
  // ask a human, so 'bypassPermissions' (and tools claude auto-allows) skip the gate.
  permissionMode: z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions']).default('default'),
});

export type TriageConfig = z.infer<typeof triageSchema>;
export type NagiConfig = z.infer<typeof configSchema>;

export interface Secrets {
  botToken: string;
  appToken: string;
}

export function parseConfig(raw: unknown): NagiConfig {
  return configSchema.parse(raw);
}

export function loadConfig(path: string): NagiConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config at ${path}: ${err instanceof Error ? err.message : err}`);
  }
  return parseConfig(JSON.parse(text));
}

export function loadSecrets(env: NodeJS.ProcessEnv): Secrets {
  const botToken = env['SLACK_BOT_TOKEN'];
  const appToken = env['SLACK_APP_TOKEN'];
  if (!botToken) throw new Error('SLACK_BOT_TOKEN is required');
  if (!appToken) throw new Error('SLACK_APP_TOKEN is required');
  return { botToken, appToken };
}


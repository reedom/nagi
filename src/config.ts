import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
  // Repo references are a configured alias map; free-form paths are
  // unrepresentable in workflow arg schemas (D13).
  repos: z.record(z.string().min(1), z.string().refine(isAbsolute, 'repo path must be absolute')),
  // Optional cmux access for the surfaced lane; absent → surfaced runs are disabled.
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

/** The aliases workflows may reference, derived from the repo map (D13). */
export function repoAliases(config: NagiConfig): string[] {
  return Object.keys(config.repos);
}

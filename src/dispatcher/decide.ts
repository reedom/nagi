import type { ZodError } from 'zod';
import { repoAliases, type NagiConfig } from '../config.js';
import type { Registry, RegistryEntry } from '../registry/index.js';
import type { TriageResult } from '../triage/schema.js';

// The single "can we dispatch yet?" decision (4A). Every reason we cannot
// dispatch collapses to one unified clarification path: low confidence, an
// unknown workflow id, or args that fail the entry's schema.

export type Decision =
  | {
      kind: 'dispatch';
      entry: RegistryEntry;
      args: Record<string, unknown>;
      cwd?: string;
      budget: number | null;
    }
  | { kind: 'clarify'; question: string };

export function decide(config: NagiConfig, registry: Registry, triage: TriageResult): Decision {
  const punt = triage.clarificationQuestion?.trim();
  if (punt) return { kind: 'clarify', question: punt };

  if (triage.confidence < config.triage.confidenceThreshold) {
    return { kind: 'clarify', question: chooseWorkflowQuestion(registry) };
  }

  const entry = registry.get(triage.workflowId);
  if (!entry) return { kind: 'clarify', question: chooseWorkflowQuestion(registry) };

  const parsed = entry.argsSchema.safeParse(triage.args);
  if (!parsed.success) {
    return { kind: 'clarify', question: schemaQuestion(parsed.error, config) };
  }

  const args = parsed.data as Record<string, unknown>;
  const cwd = resolveCwd(config, args);
  const budget = entry.budgetOverride ?? config.defaultBudget;
  return { kind: 'dispatch', entry, args, ...(cwd ? { cwd } : {}), budget };
}

function resolveCwd(config: NagiConfig, args: Record<string, unknown>): string | undefined {
  const repo = args['repo'];
  return typeof repo === 'string' ? config.repos[repo] : undefined;
}

function chooseWorkflowQuestion(registry: Registry): string {
  const options = registry.list().map((e) => `• *${e.id}* — ${e.description}`).join('\n');
  return `I'm not sure which workflow fits. I can run:\n${options}\nWhich would you like, and with what details?`;
}

function schemaQuestion(error: ZodError, config: NagiConfig): string {
  const issue = error.issues[0];
  const field = issue && issue.path.length !== 0 ? String(issue.path[0]) : 'an argument';
  if (field === 'repo') {
    const aliases = repoAliases(config);
    const list = aliases.length === 0 ? '(none configured)' : aliases.join(', ');
    return `I couldn't match that to a known repo. Valid repos: ${list}. Which one?`;
  }
  return `I need a clearer value for \`${field}\` (${issue?.message ?? 'invalid'}). Could you restate it?`;
}

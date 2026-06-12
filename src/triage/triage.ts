import type { CliAdapter } from 'ai-workflow-engine';
import type { TriageConfig } from '../config.js';
import type { Registry } from '../registry/index.js';
import type { Logger } from '../logger.js';
import { withTimeout } from '../util/timeout.js';
import { buildTriagePrompt, buildTriageUserPrompt } from './prompt.js';
import { triageJsonSchema, triageResultSchema, type TriageResult } from './schema.js';

// Triage is a DIRECT single call to the claude adapter (not a registered
// workflow — agent() exists only inside workflow bodies). It runs with its own
// runtime policy: a fixed model, a timeout, a token-cap warning, and NO
// escalation (the spec carries no escalation field).

export interface TriageDeps {
  adapter: CliAdapter;
  policy: TriageConfig;
  registry: Registry;
  aliases: string[];
  log: Logger;
}

export async function runTriage(deps: TriageDeps, text: string): Promise<TriageResult> {
  const instructions = buildTriagePrompt(deps.registry, deps.aliases);
  const spec = {
    prompt: buildTriageUserPrompt(text),
    model: deps.policy.model,
    schema: triageJsonSchema,
    instructions,
    tools: [] as string[],
  };
  const result = await withTimeout(deps.adapter.run(spec), deps.policy.timeoutMs, 'triage');
  if (deps.policy.tokenCap < result.usage.outputTokens) {
    deps.log.warn('triage exceeded token cap', {
      cap: deps.policy.tokenCap,
      outputTokens: result.usage.outputTokens,
    });
  }
  if (result.data === undefined) {
    throw new Error('triage returned no structured output');
  }
  return triageResultSchema.parse(result.data);
}

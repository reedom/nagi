import { zodToReadable } from './describe.js';
import type { Registry } from '../registry/index.js';

// The triage system prompt is built fresh from the live registry so a new
// workflow becomes triageable the moment it is registered.

export function buildTriagePrompt(registry: Registry, aliases: string[]): string {
  const entries = registry
    .list()
    .map((e) => `- id: ${e.id}\n  description: ${e.description}\n  args: ${zodToReadable(e.argsSchema)}`)
    .join('\n');
  const repoList = aliases.length === 0 ? '(none configured)' : aliases.join(', ');
  return [
    'You are the triage step of an AI concierge. Given a user request, pick the single',
    'best workflow to run and extract its arguments. You MUST return JSON matching the',
    'provided schema and nothing else.',
    '',
    'Available workflows:',
    entries,
    '',
    `Known repo aliases (the ONLY valid values for a "repo" argument): ${repoList}`,
    '',
    'Rules:',
    '- workflowId MUST be one of the listed ids. If none fits, set confidence low and',
    '  put a one-sentence clarificationQuestion describing what you need.',
    '- Extract args strictly from the listed arg shapes. Never invent a repo alias.',
    '- confidence is your honest probability (0..1) that this dispatch is correct.',
    '- If the request is ambiguous or under-specified, lower confidence and ask via',
    '  clarificationQuestion instead of guessing.',
  ].join('\n');
}

export function buildTriageUserPrompt(text: string): string {
  return `User request:\n${text}`;
}

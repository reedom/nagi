import { z } from 'zod';
import type { WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import type { EntryFactory, RegistryEntry } from '../types.js';

interface ReviewArgs { repoHint: string; scope: 'repo' | 'diff'; focus?: string }

const reviewModule: WorkflowModule = {
  meta: { name: 'review-repo', description: 'Review a repository or its working diff and summarize the top risks.' },
  async default(wf: WorkflowApi): Promise<unknown> {
    const args = wf.args as ReviewArgs;
    const target = args.scope === 'diff' ? 'the current uncommitted/working diff' : 'the repository as a whole';
    const focus = args.focus ? `\n\nPay special attention to: ${args.focus}.` : '';
    wf.phase('review');
    const result = await wf.agent(
      `Locate the repo matching "${args.repoHint}" with your tools, cd into it, and review ${target}. ` +
        `Identify the most important correctness, security, and maintainability risks. ` +
        `Use read-only inspection (git, ripgrep, file reads). ` +
        `Return a concise prioritized summary with file:line references.${focus}`,
      { label: 'review', tools: ['Bash', 'Read', 'Grep', 'Glob'] },
    );
    return { summary: result.text, usage: result.usage };
  },
};

export const reviewRepoEntry: EntryFactory = (): RegistryEntry => ({
  id: 'review-repo',
  description:
    'Review a repository (or its working diff) and summarize the most important risks. ' +
    'Use when the user asks to review, audit, or assess a repo or a diff.',
  argsSchema: z.object({
    repoHint: z.string().min(1),
    scope: z.enum(['repo', 'diff']).default('repo'),
    focus: z.string().optional(),
  }),
  module: reviewModule,
});

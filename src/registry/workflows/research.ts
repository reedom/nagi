import { z } from 'zod';
import type { WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import type { WorkflowFactory, RegistryEntry } from '../types.js';

// Seed workflow #2: a small parallel research pipeline. Chosen for mechanism
// coverage, not topic: the fan-out exercises approval serialization (1A) and
// budget under real concurrency when agents escalate at once.

interface ResearchArgs {
  question: string;
}

const ANGLES = ['fundamentals and definitions', 'trade-offs and risks', 'concrete current options'];

const researchModule: WorkflowModule = {
  meta: {
    name: 'research',
    description: 'Research a question from several angles in parallel, then synthesize.',
    phases: [{ title: 'gather' }, { title: 'synthesize' }],
  },
  async default(wf: WorkflowApi): Promise<unknown> {
    const { question } = wf.args as ResearchArgs;
    wf.phase('gather');
    const findings = await wf.parallel(
      ANGLES.map((angle) => () =>
        wf.agent(`Research this question focusing on ${angle}: ${question}`, {
          label: `gather:${angle.split(' ')[0]}`,
          tools: ['Bash', 'Read', 'Grep', 'Glob'],
        }),
      ),
    );
    wf.phase('synthesize');
    const notes = findings
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .map((f, i) => `## Angle ${i + 1}\n${f.text}`)
      .join('\n\n');
    const synthesis = await wf.agent(
      `Synthesize these research notes into one concise, balanced answer to "${question}":\n\n${notes}`,
      { label: 'synthesize' },
    );
    return { answer: synthesis.text };
  },
};

export const researchEntry: WorkflowFactory = (): RegistryEntry => ({
  id: 'research',
  description:
    'Research an open question from multiple angles and synthesize an answer. ' +
    'Use when the user asks to research, investigate, or compare options for a topic.',
  argsSchema: z.object({
    question: z.string().min(1),
  }),
  module: researchModule,
});

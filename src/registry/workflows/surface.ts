import { z } from 'zod';
import type { WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import type { WorkflowFactory, RegistryEntry } from '../types.js';

interface SurfaceArgs {
  task: string;
}

const surfaceModule: WorkflowModule = {
  meta: {
    name: 'surface',
    description: 'Run one interactive agent on a cmux surface and report its result.',
  },
  async default(wf: WorkflowApi): Promise<unknown> {
    const args = wf.args as SurfaceArgs;
    const result = await wf.agent(args.task, { cli: 'cmux' });
    return { text: result.text };
  },
};

export const surfaceEntry: WorkflowFactory = (): RegistryEntry => ({
  id: 'surface',
  description:
    'Run a task as an interactive agent on a visible cmux surface (you can watch and intervene). ' +
    'The surface stays resident: reply in the same thread to keep talking to it, and say `done` to close it. ' +
    'Use when the user asks to open/run something on a surface, or wants a watchable interactive run.',
  argsSchema: z.object({ task: z.string().min(1) }),
  module: surfaceModule,
  surfaced: true,
});

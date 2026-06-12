import { z } from 'zod';
import type { WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import type { EntryFactory, RegistryEntry } from '../types.js';

// A deliberate test affordance: the agent is granted NO tools, but is told it
// must run a shell command. The first tool attempt is not pre-authorized, so
// the broker escalates and you get Approve/Deny buttons in the thread — the
// only reliable way to exercise the escalation round-trip, since the real seed
// workflows pre-authorize the tools they use.
//
// Registered only when NAGI_ENABLE_APPROVAL_DEMO=1 (see registry/index.ts).

const demoModule: WorkflowModule = {
  meta: {
    name: 'approval-demo',
    description: 'Force a tool-approval prompt to test the escalation round-trip.',
  },
  async default(wf: WorkflowApi): Promise<unknown> {
    const result = await wf.agent(
      'You MUST use the Bash tool to run exactly `date -u` and report its output verbatim. ' +
        'Do not answer from memory — you must actually call the tool.',
      { label: 'approval-demo' }, // no `tools` granted → the Bash call escalates
    );
    return { summary: `Approval demo finished. Agent reported:\n${result.text}` };
  },
};

export const approvalDemoEntry: EntryFactory = (): RegistryEntry => ({
  id: 'approval-demo',
  description:
    'Run a harmless command (`date -u`) that requires tool approval, to test the ' +
    'Approve/Deny escalation buttons. Use when the user asks to test approvals or escalation.',
  argsSchema: z.object({}),
  module: demoModule,
});

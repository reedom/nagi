// src/registry/workflows/investigate-ticket.ts
import { z } from 'zod';
import type { WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import type { NagiConfig } from '../../config.js';
import type { RegistryEntry } from '../types.js';
import { RepoMemory } from '../../repo/memory.js';
import { ScriptProvisioner } from '../../repo/worktree.js';
import { listScopedRepos } from '../../repo/ghq.js';
import { resolveAndSchedule, type ResolveDeps } from './steps/resolve-and-schedule.js';
import { RepoGraph } from '../../repo/graph.js';

interface InvestigateArgs { ticketRef: string; repoHint?: string }

function makeModule(config: NagiConfig): WorkflowModule {
  return {
    meta: { name: 'investigate-ticket', description: 'Investigate a ticket across its dependent repositories.' },
    async default(wf: WorkflowApi): Promise<unknown> {
      const args = wf.args as InvestigateArgs;
      const deps: ResolveDeps = {
        scopes: config.repoScopes,
        maxRepos: config.maxRepos,
        memory: RepoMemory.load(config.learnedReposPath),
        provisioner: new ScriptProvisioner(config.worktree.script),
        listRepos: (scopes) => listScopedRepos(scopes),
      };
      const result = await resolveAndSchedule(wf, args.ticketRef, deps);
      const diagram = RepoGraph.fromData(result.graph).render();
      return {
        ticket: args.ticketRef,
        halted: result.halted ?? null,
        findings: result.findings.map((f) => ({ repo: f.repo, findings: f.findings })),
        graph: diagram,
      };
    },
  };
}

export function makeInvestigateTicketEntry(config: NagiConfig): RegistryEntry {
  return {
    id: 'investigate-ticket',
    description:
      'Investigate a ticket end-to-end: find the starting repo, root-cause it, and follow ' +
      'repo-to-repo dependencies. Use when the user references a ticket (e.g. ABC-1234, XYZ-1234).',
    argsSchema: z.object({ ticketRef: z.string().min(1), repoHint: z.string().optional() }),
    module: makeModule(config),
  };
}

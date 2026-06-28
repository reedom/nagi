// src/registry/workflows/steps/resolve-and-schedule.ts
import { z } from 'zod';
import type { WorkflowApi } from 'ai-workflow-engine';
import { RepoGraph } from '../../../repo/graph.js';
import { filterScope } from '../../../repo/scope.js';
import type { RepoMemory } from '../../../repo/memory.js';
import type { WorktreeProvisioner } from '../../../repo/worktree.js';
import type { DiscoveredDependency, RepoGraphData } from '../../../repo/types.js';

export interface NodeFinding { repo: string; findings: string; dependencies: DiscoveredDependency[] }
export interface ResolveDeps {
  scopes: string[];
  maxRepos: number;
  memory: RepoMemory;
  provisioner: WorktreeProvisioner;
  listRepos: (scopes: string[]) => Promise<string[]>;
}
export interface ResolveResult {
  graph: RepoGraphData;
  findings: NodeFinding[];
  halted?: { reason: 'cycle' | 'maxRepos'; detail: string };
}

const identifySchema = z.object({ repos: z.array(z.string()) });
const investigateSchema = z.object({
  findings: z.string(),
  dependencies: z.array(z.object({ repo: z.string(), reason: z.string() })).default([]),
});

// Seed the graph from memory if known, else ask the identify agent which of the
// scoped candidates the ticket starts in. Only in-scope repos enter the graph.
async function seed(wf: WorkflowApi, ticket: string, deps: ResolveDeps, graph: RepoGraph): Promise<void> {
  const known = deps.memory.get(ticket);
  if (known) { for (const n of filterScope(known.nodes, deps.scopes).approved) graph.addNode(n); return; }
  const candidates = await deps.listRepos(deps.scopes);
  const res = await wf.agent(
    `Ticket: ${ticket}\nUsing your available ticket tools, read it and pick the repo(s) where ` +
      `investigation should START, choosing only from this candidate list:\n${candidates.join('\n')}\n` +
      `Return { "repos": [...] } with absolute paths copied verbatim from the list.`,
    { label: 'identify', phase: 'identify', schema: identifySchema, tools: ['Bash', 'Read', 'Grep'] },
  );
  const picked = identifySchema.parse(res.data).repos;
  for (const p of filterScope(picked, deps.scopes).approved) graph.addNode(p);
}

export async function resolveAndSchedule(wf: WorkflowApi, ticket: string, deps: ResolveDeps): Promise<ResolveResult> {
  const graph = new RepoGraph();
  await seed(wf, ticket, deps, graph);

  const findings: NodeFinding[] = [];
  let halted: ResolveResult['halted'];

  while (graph.hasUnprocessed() && !halted) {
    const ready = graph.readyNodes();
    const batch = await wf.parallel(
      ready.map((repo) => async () => investigateNode(wf, ticket, repo, deps)),
    );
    for (let i = 0; i < batch.length; i += 1) {
      const node = batch[i];
      const repo = ready[i] as string;
      if (!node) {
        graph.markProcessed(repo);
        findings.push({ repo, findings: 'investigation failed (no agent result)', dependencies: [] });
        continue;
      }
      graph.markProcessed(node.repo);
      findings.push(node);
      halted = absorb(graph, node, deps);
      if (halted) break;
    }
    if (graph.size() !== 0 && deps.maxRepos <= graph.size() && graph.hasUnprocessed() && !halted) {
      halted = { reason: 'maxRepos', detail: `graph reached the ${deps.maxRepos}-repo cap` };
    }
  }

  const data = graph.toData();
  deps.memory.remember(ticket, data);
  return { graph: data, findings, ...(halted ? { halted } : {}) };
}

// Provision a worktree and run the investigate agent inside it.
async function investigateNode(wf: WorkflowApi, ticket: string, repo: string, deps: ResolveDeps): Promise<NodeFinding> {
  const cwd = await deps.provisioner.provision(repo, ticket);
  const res = await wf.agent(
    `You are in a worktree for ticket ${ticket} at ${cwd}. Root-cause the ticket here. ` +
      `If the cause depends on OTHER repositories, list each as a dependency with a short reason. ` +
      `Return { "findings": "...", "dependencies": [{ "repo": "<absolute path>", "reason": "..." }] }.`,
    { label: 'investigate', phase: 'investigate', schema: investigateSchema, tools: ['Bash', 'Read', 'Grep'], cwd },
  );
  const parsed = investigateSchema.parse(res.data);
  return { repo, findings: parsed.findings, dependencies: parsed.dependencies };
}

// Scope-filter discovered dependencies, then add edges; signal a cycle halt.
function absorb(graph: RepoGraph, node: NodeFinding, deps: ResolveDeps): ResolveResult['halted'] {
  const approved = filterScope(node.dependencies.map((d) => d.repo), deps.scopes).approved;
  for (const dep of node.dependencies) {
    if (!approved.includes(dep.repo)) continue;
    if (graph.wouldCreateCycle(node.repo, dep.repo)) {
      return { reason: 'cycle', detail: `${node.repo} <-> ${dep.repo}` };
    }
    graph.addEdge(node.repo, dep.repo, dep.reason);
  }
  return undefined;
}

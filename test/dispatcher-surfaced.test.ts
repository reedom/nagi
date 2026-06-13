import { describe, expect, it, vi } from 'vitest';
import type { AgentResult, CliAdapter, RunOptions, WorkflowModule } from 'ai-workflow-engine';
import { Dispatcher } from '../src/dispatcher/dispatcher.js';
import { WorkQueue } from '../src/dispatcher/queue.js';
import { makeRegistry } from '../src/registry/index.js';
import { makeThreadStore } from '../src/thread-state.js';
import { ApprovalRegistry } from '../src/escalation/approval-registry.js';
import { PendingRuns } from '../src/agentbus-bridge/pending-runs.js';
import { repoAliases } from '../src/config.js';
import type { RequestContext } from '../src/types.js';
import { fakeAdapter, recordingAudit, recordingReplier, silentLogger, testConfig, tick } from './helpers.js';

type RunFn = (mod: WorkflowModule, opts: RunOptions) => Promise<unknown>;

function surfaceHarness() {
  const config = testConfig();
  const registry = makeRegistry(config);
  const audit = recordingAudit();
  const queue = new WorkQueue(silentLogger);
  const threadStore = makeThreadStore();
  const replier = recordingReplier();
  const pending = new PendingRuns();
  const triageAdapter = fakeAdapter([
    { data: { workflowId: 'surface', args: { repo: 'engine', task: 't' }, confidence: 1 } },
  ]);
  const gate = { post: async () => ({ ts: 'x' }), update: async () => {}, uploadSnippet: async () => {} };
  const closeSurface = vi.fn(async () => {});
  const makeSurfaceAdapter = (runId: string): CliAdapter => ({
    id: 'cmux',
    caps: { schema: false, resume: false, tools: true },
    async run(): Promise<AgentResult> {
      pending.setSurfaceRef(runId, `workspace:${runId}`); // mimic the real onSurface -> setSurfaceRef wiring
      const r = await pending.awaitExisting(runId);
      return { text: r.text, raw: {}, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  });
  const runWorkflowFn: RunFn = async (_mod, opts) => {
    const adapter = opts.adapters['cmux'];
    if (!adapter) throw new Error('no cmux adapter injected');
    const r = await adapter.run({ prompt: 't' } as never);
    return { text: r.text };
  };
  const dispatcher = new Dispatcher({
    config,
    registry,
    triage: { adapter: triageAdapter, policy: config.triage, registry, aliases: repoAliases(config), log: silentLogger },
    adapters: { claude: triageAdapter, codex: triageAdapter },
    audit,
    queue,
    threadStore,
    approvals: new ApprovalRegistry(),
    log: silentLogger,
    makeReplier: () => replier,
    makeGate: () => gate,
    newRunId: () => 'run-surf',
    newApprovalId: () => 'appr',
    cancelActiveRun: () => 0,
    pending,
    makeSurfaceAdapter,
    surfaceCeilingMs: 10_000,
    closeSurface,
    runWorkflowFn,
  });
  return { dispatcher, replier, audit, queue, pending, closeSurface };
}

function req(over: Partial<RequestContext> = {}): RequestContext {
  return { teamId: 'T1', userId: 'U1', channel: 'C1', threadTs: 't1', text: 'open a surface and run t on engine', ...over };
}

describe('surfaced dispatch', () => {
  it('frees the queue while a surfaced run is in flight, then posts the result', async () => {
    const h = surfaceHarness();
    await h.dispatcher.handle(req());
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.queue.status().active).toBeFalsy();
    expect(h.pending.active()).toHaveLength(1);
    expect(h.replier.said.some((s) => /the answer/.test(s))).toBe(false);
    const runId = h.pending.active()[0]!;
    h.pending.resolveResult(runId, 'the answer');
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.replier.said.some((s) => /the answer/.test(s))).toBe(true);
    expect(h.audit.entries.at(-1)?.outcome).toBe('completed');
  });

  it('stop cancels active surfaced runs and closes their surfaces', async () => {
    const h = surfaceHarness();
    await h.dispatcher.handle(req());
    for (let i = 0; i < 10; i += 1) await tick();
    const runId = h.pending.active()[0]!;
    // surfaceRef was set by the adapter via the onSurface path, NOT injected by the test
    await h.dispatcher.handle(req({ text: 'cancel' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.closeSurface).toHaveBeenCalledWith(`workspace:${runId}`);
    expect(h.pending.active()).toEqual([]);
    expect(h.replier.said.some((s) => /cancel/i.test(s))).toBe(true);
  });
});

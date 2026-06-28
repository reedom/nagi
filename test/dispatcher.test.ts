import { describe, expect, it, vi } from 'vitest';
import type { RunOptions, WorkflowModule } from 'ai-workflow-engine';
import { Dispatcher } from '../src/dispatcher/dispatcher.js';
import { WorkQueue } from '../src/dispatcher/queue.js';
import { buildRegistry } from '../src/registry/index.js';
import { makeThreadStore } from '../src/thread-state.js';
import { ApprovalRegistry } from '../src/escalation/approval-registry.js';
import { PendingRuns } from '../src/agentbus-bridge/pending-runs.js';
import { ResidentSessions } from '../src/residents/resident-sessions.js';
import type { RequestContext } from '../src/types.js';
import {
  deferred,
  fakeAdapter,
  recordingAudit,
  recordingReplier,
  silentLogger,
  tick,
} from './helpers.js';
import { testConfig } from './helpers.js';
import { reviewRepo, research, surface, investigateTicket } from '../src/workflows/index.js';

type RunFn = (mod: WorkflowModule, opts: RunOptions) => Promise<unknown>;

function harness(triageData: Array<Record<string, unknown>>, runWorkflowFn?: RunFn) {
  const config = testConfig();
  const registry = buildRegistry([reviewRepo, research, surface, investigateTicket], { config });
  const audit = recordingAudit();
  const queue = new WorkQueue(silentLogger);
  const threadStore = makeThreadStore();
  const replier = recordingReplier();
  const adapter = fakeAdapter(triageData.map((data) => ({ data })));
  const gate = {
    post: async () => ({ ts: 'x' }),
    update: async () => {},
    uploadSnippet: async () => {},
  };
  const cancelActiveRun = vi.fn(() => 2);
  const dispatcher = new Dispatcher({
    config,
    registry,
    triage: { adapter, policy: config.triage, registry, log: silentLogger },
    adapters: { claude: adapter, codex: adapter },
    audit,
    queue,
    threadStore,
    approvals: new ApprovalRegistry(),
    log: silentLogger,
    makeReplier: () => replier,
    makeGate: () => gate,
    newRunId: () => 'run',
    newApprovalId: () => 'appr',
    cancelActiveRun,
    pending: new PendingRuns(),
    makeSurfaceAdapter: () => adapter,
    surfaceCeilingMs: 1000,
    closeSurface: async () => {},
    residents: new ResidentSessions(),
    host: { send: async () => {}, sendKey: async () => {} },
    ...(runWorkflowFn ? { runWorkflowFn } : {}),
  });
  return { dispatcher, replier, audit, queue, threadStore, adapter, cancelActiveRun, registry };
}

function req(over: Partial<RequestContext> = {}): RequestContext {
  return { teamId: 'T1', userId: 'U1', channel: 'C1', threadTs: 't1', text: 'review the engine', ...over };
}

async function drain(queue: WorkQueue): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (!queue.status().active && queue.status().queued.length === 0) return;
    await tick();
  }
}

describe('Dispatcher', () => {
  it('refuses a non-allowlisted user without triaging (D14)', async () => {
    const h = harness([]);
    await h.dispatcher.handle(req({ userId: 'U2' }));
    await drain(h.queue);
    expect(h.replier.said.join(' ')).toMatch(/can't act on requests/);
    expect(h.adapter.calls).toHaveLength(0);
    expect(h.audit.entries.at(-1)?.outcome).toBe('refused');
  });

  it('asks a clarification on low confidence and parks thread state', async () => {
    const h = harness([{ workflowId: 'review-repo', args: {}, confidence: 0.2 }]);
    await h.dispatcher.handle(req());
    await drain(h.queue);
    expect(h.replier.said.join(' ')).toMatch(/not sure which workflow/);
    expect(h.threadStore.get('t1')).toBeDefined();
    expect(h.audit.entries.at(-1)?.outcome).toBe('clarification');
  });

  it('consumes a thread reply as a follow-up to the parked clarification', async () => {
    const h = harness(
      [
        { workflowId: 'review-repo', args: {}, confidence: 0.2 },
        { workflowId: 'review-repo', args: { repoHint: 'engine', scope: 'repo' }, confidence: 0.95 },
      ],
      async () => ({ summary: 'reviewed' }),
    );
    await h.dispatcher.handle(req({ text: 'review something' }));
    await drain(h.queue);
    await h.dispatcher.handle(req({ text: 'the engine repo' }));
    await drain(h.queue);
    // Second triage call saw the combined original + follow-up text.
    expect(h.adapter.calls[1]?.prompt).toMatch(/review something/);
    expect(h.adapter.calls[1]?.prompt).toMatch(/the engine repo/);
    expect(h.threadStore.get('t1')).toBeUndefined();
    expect(h.audit.entries.at(-1)?.outcome).toBe('completed');
  });

  it('dispatches a confident request and runs the right module with cwd + budget', async () => {
    let captured: { mod: WorkflowModule; opts: RunOptions } | undefined;
    const runFn: RunFn = async (mod, opts) => {
      captured = { mod, opts };
      return { summary: 'reviewed: looks fine' };
    };
    const h = harness(
      [{ workflowId: 'review-repo', args: { repoHint: 'engine', scope: 'repo' }, confidence: 0.95 }],
      runFn,
    );
    await h.dispatcher.handle(req());
    await drain(h.queue);
    expect(h.replier.said[0]).toMatch(/On it.*review-repo/);
    expect(h.replier.said.at(-1)).toBe('reviewed: looks fine');
    expect(captured?.mod).toBe(h.registry.get('review-repo')?.module);
    expect(captured?.opts.budget).toBe(100_000);
    expect(captured?.opts.escalation?.channel.id).toBe('slack');
    const outcomes = h.audit.entries.map((e) => e.outcome);
    expect(outcomes).toContain('dispatched');
    expect(outcomes).toContain('completed');
  });

  it('reports a workflow failure in-thread, never silent', async () => {
    const runFn: RunFn = async () => {
      throw new Error('budget exhausted');
    };
    const h = harness(
      [{ workflowId: 'research', args: { question: 'why' }, confidence: 0.9 }],
      runFn,
    );
    await h.dispatcher.handle(req({ text: 'research why the sky is blue' }));
    await drain(h.queue);
    expect(h.replier.said.at(-1)).toMatch(/Run failed: budget exhausted/);
    expect(h.audit.entries.at(-1)?.outcome).toBe('failed');
  });

  it('queues a second request while one is running (single-flight)', async () => {
    const gate = deferred<unknown>();
    const runFn: RunFn = () => gate.promise as Promise<unknown>;
    const h = harness(
      [
        { workflowId: 'research', args: { question: 'a' }, confidence: 0.9 },
        { workflowId: 'research', args: { question: 'b' }, confidence: 0.9 },
      ],
      runFn,
    );
    await h.dispatcher.handle(req({ threadTs: 't1', text: 'research a' }));
    for (let i = 0; i < 5; i += 1) await tick(); // let job1 reach the blocked run
    await h.dispatcher.handle(req({ threadTs: 't2', text: 'research b' }));
    expect(h.replier.said.join('\n')).toMatch(/busy with/i);
    gate.resolve({ answer: 'done' });
    await drain(h.queue);
  });

  it('handles status and cancel as out-of-band control commands (D12)', async () => {
    const h = harness([]);
    await h.dispatcher.handle(req({ text: 'status' }));
    expect(h.replier.said.at(-1)).toMatch(/Idle/);
    expect(h.adapter.calls).toHaveLength(0);

    await h.dispatcher.handle(req({ text: 'cancel' }));
    expect(h.cancelActiveRun).toHaveBeenCalledOnce();
    expect(h.replier.said.at(-1)).toMatch(/Cancelling/);
    expect(h.audit.entries.at(-1)?.outcome).toBe('cancelled');
  });
});

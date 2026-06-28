import { describe, expect, it, vi } from 'vitest';
import type { AgentResult, CliAdapter, RunOptions, WorkflowModule } from 'ai-workflow-engine';
import { Dispatcher } from '../src/dispatcher/dispatcher.js';
import { WorkQueue } from '../src/dispatcher/queue.js';
import { buildRegistry } from '../src/registry/index.js';
import { makeThreadStore } from '../src/thread-state.js';
import { ApprovalRegistry } from '../src/escalation/approval-registry.js';
import { PendingRuns } from '../src/agentbus-bridge/pending-runs.js';
import { ResidentSessions } from '../src/residents/resident-sessions.js';
import type { RequestContext } from '../src/types.js';
import { fakeAdapter, recordingAudit, recordingReplier, silentLogger, testConfig, tick } from './helpers.js';
import { reviewRepo, research, surface, investigateTicket } from '../src/workflows/index.js';

type RunFn = (mod: WorkflowModule, opts: RunOptions) => Promise<unknown>;

function surfaceHarness() {
  const config = testConfig();
  const registry = buildRegistry([reviewRepo, research, surface, investigateTicket], { config });
  const audit = recordingAudit();
  const queue = new WorkQueue(silentLogger);
  const threadStore = makeThreadStore();
  const replier = recordingReplier();
  const pending = new PendingRuns();
  const triageAdapter = fakeAdapter([
    { data: { workflowId: 'surface', args: { task: 't' }, confidence: 1 } },
  ]);
  const gate = { post: async () => ({ ts: 'x' }), update: async () => {}, uploadSnippet: async () => {} };
  const closeSurface = vi.fn(async () => {});
  const makeSurfaceAdapter = (runId: string, onSurfaceRef?: (surfaceRef: string) => void): CliAdapter => ({
    id: 'cmux',
    caps: { schema: false, resume: false, tools: true },
    async run(): Promise<AgentResult> {
      const surfaceRef = `workspace:${runId}`;
      pending.setSurfaceRef(runId, surfaceRef); // mimic the real onSurface -> setSurfaceRef wiring
      onSurfaceRef?.(surfaceRef);               // mimic the real onSurface -> resident promotion
      const r = await pending.awaitExisting(runId);
      return { text: r.text, raw: {}, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  });
  const residents = new ResidentSessions();
  const host = { send: vi.fn(async () => {}), sendKey: vi.fn(async () => {}) };
  const runWorkflowFn: RunFn = async (_mod, opts) => {
    const adapter = opts.adapters['cmux'];
    if (!adapter) throw new Error('no cmux adapter injected');
    const r = await adapter.run({ prompt: 't' } as never);
    return { text: r.text };
  };
  const dispatcher = new Dispatcher({
    config,
    registry,
    triage: { adapter: triageAdapter, policy: config.triage, registry, log: silentLogger },
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
    residents,
    host,
    runWorkflowFn,
  });
  return { dispatcher, replier, audit, queue, pending, closeSurface, residents, host };
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
    expect(h.audit.entries.at(-1)?.outcome).toBe('resident-ready');
  });

  it('promotes a launched surface into the resident registry for its thread', async () => {
    const h = surfaceHarness();
    await h.dispatcher.handle(req({ threadTs: 't-res' }));
    for (let i = 0; i < 10; i += 1) await tick();
    const resident = h.residents.getByThread('t-res');
    expect(resident).toMatchObject({ runId: 'run-surf', surfaceRef: 'workspace:run-surf' });
    // The launch result is still posted to the thread, plus the interactive hint.
    h.pending.resolveResult('run-surf', 'the answer');
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.replier.said.some((s) => /reply here to keep talking/i.test(s))).toBe(true);
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

describe('resident ingress', () => {
  it('pipes a follow-up in a resident thread straight to the REPL, skipping triage', async () => {
    const h = surfaceHarness();
    h.residents.add({ runId: 'run-surf', surfaceRef: 'workspace:run-surf', channel: 'C1', threadTs: 't1' });
    await h.dispatcher.handle(req({ text: 'follow-up question' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.host.send).toHaveBeenCalledWith('workspace:run-surf', 'follow-up question');
    expect(h.host.sendKey).toHaveBeenCalledWith('workspace:run-surf', 'Return');
    expect(h.queue.status().active).toBeFalsy(); // never entered the queue / triage
    expect(h.audit.entries.at(-1)?.outcome).toBe('resident-input');
  });

  it('closes the resident and notifies when the surface is gone', async () => {
    const h = surfaceHarness();
    h.host.send.mockRejectedValueOnce(new Error('no such surface'));
    h.residents.add({ runId: 'run-surf', surfaceRef: 'workspace:run-surf', channel: 'C1', threadTs: 't1' });
    await h.dispatcher.handle(req({ text: 'hello?' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.residents.getByThread('t1')).toBeUndefined();
    expect(h.replier.said.some((s) => /resident seems gone/i.test(s))).toBe(true);
  });

  it('triages normally in a thread with no resident', async () => {
    const h = surfaceHarness();
    await h.dispatcher.handle(req());
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.host.send).not.toHaveBeenCalled();
    expect(h.pending.active()).toHaveLength(1); // the surface workflow launched
  });

  it('done retires the thread resident and closes its surface', async () => {
    const h = surfaceHarness();
    h.residents.add({ runId: 'run-surf', surfaceRef: 'workspace:run-surf', channel: 'C1', threadTs: 't1' });
    await h.dispatcher.handle(req({ text: 'done' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.closeSurface).toHaveBeenCalledWith('workspace:run-surf');
    expect(h.residents.getByThread('t1')).toBeUndefined();
    expect(h.replier.said.some((s) => /closed/i.test(s))).toBe(true);
  });

  it('done in a thread with no resident posts a friendly notice', async () => {
    const h = surfaceHarness();
    await h.dispatcher.handle(req({ text: 'done', threadTs: 't-empty' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.closeSurface).not.toHaveBeenCalled();
    expect(h.replier.said.some((s) => /no .*resident/i.test(s))).toBe(true);
  });

  it('stop closes every resident surface and clears the registry', async () => {
    const h = surfaceHarness();
    h.residents.add({ runId: 'r-a', surfaceRef: 'workspace:r-a', channel: 'C1', threadTs: 't-a' });
    h.residents.add({ runId: 'r-b', surfaceRef: 'workspace:r-b', channel: 'C1', threadTs: 't-b' });
    await h.dispatcher.handle(req({ text: 'stop', threadTs: 't-ctl' }));
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.closeSurface).toHaveBeenCalledWith('workspace:r-a');
    expect(h.closeSurface).toHaveBeenCalledWith('workspace:r-b');
    expect(h.residents.list()).toEqual([]);
  });
});

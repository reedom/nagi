import { describe, expect, it, vi } from 'vitest';
import { handleEnvelope } from '../src/agentbus-bridge/bridge.js';
import { PendingRuns } from '../src/agentbus-bridge/pending-runs.js';
import { ApprovalRegistry } from '../src/escalation/approval-registry.js';

function deps(over: Partial<Parameters<typeof handleEnvelope>[1]> = {}) {
  const posts: any[] = [];
  const poster = {
    postMessage: vi.fn(async (a: any) => { posts.push(a); return { ts: 'ts1' }; }),
    update: vi.fn(async () => {}),
    uploadSnippet: vi.fn(async () => {}),
  };
  const pending = new PendingRuns();
  const approvals = new ApprovalRegistry();
  return { poster, pending, approvals, posts, base: { poster, pending, approvals, registry: approvals, newId: () => 'appr1', agentbusReply: vi.fn(async () => {}), log: { info(){}, warn(){}, error(){} } as any, ...over } };
}

const never = { schedule: (_f: () => void, _m: number) => () => {} };

describe('handleEnvelope', () => {
  it('posts progress to the run thread', async () => {
    const d = deps();
    void d.pending.await('r1', { channel: 'C', threadTs: 'T1', ceilingMs: 1000 }, never).catch(() => {});
    await handleEnvelope({ id: 'm', kind: 'message', from: 'ext:awe-r1', payload: { type: 'progress', runId: 'r1', text: 'step 1' } }, d.base);
    expect(d.poster.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C', thread_ts: 'T1', text: expect.stringContaining('step 1') }));
  });

  it('resolves a result for the run', async () => {
    const d = deps();
    const awaited = d.pending.await('r2', { channel: 'C', threadTs: 'T2', ceilingMs: 1000 }, never);
    await handleEnvelope({ id: 'm', kind: 'message', from: 'ext:awe-r2', payload: { type: 'result', runId: 'r2', text: 'done' } }, d.base);
    await expect(awaited).resolves.toEqual({ text: 'done' });
  });

  it('posts an approval and replies after a button resolves it', async () => {
    const d = deps();
    void d.pending.await('r3', { channel: 'C', threadTs: 'T3', ceilingMs: 1000 }, never).catch(() => {});
    const p = handleEnvelope(
      { id: 'ask9', kind: 'ask', from: 'ext:awe-r3', payload: { type: 'approval', runId: 'r3', tool: 'Bash', input: { command: 'ls' } } },
      d.base,
    );
    // simulate the Bolt button handler resolving the approval
    await new Promise((r) => setTimeout(r, 0));
    d.base.approvals.resolve('appr1', { behavior: 'allow', reason: 'ok' });
    await p;
    expect(d.base.agentbusReply).toHaveBeenCalledWith('ask9', expect.objectContaining({ behavior: 'allow' }));
  });

  it('ignores envelopes for unknown runs', async () => {
    const d = deps();
    await handleEnvelope({ id: 'm', kind: 'message', from: 'x', payload: { type: 'progress', runId: 'ghost', text: 'x' } }, d.base);
    expect(d.poster.postMessage).not.toHaveBeenCalled();
  });

  it('keeps two concurrent runs isolated (no thread crossing)', async () => {
    const d = deps();
    void d.pending.await('rA', { channel: 'CA', threadTs: 'TA', ceilingMs: 1000 }, never).catch(() => {});
    const awaitedB = d.pending.await('rB', { channel: 'CB', threadTs: 'TB', ceilingMs: 1000 }, never);
    await handleEnvelope({ id: 'm1', kind: 'message', from: 'ext:awe-rA', payload: { type: 'progress', runId: 'rA', text: 'A-step' } }, d.base);
    await handleEnvelope({ id: 'm2', kind: 'message', from: 'ext:awe-rB', payload: { type: 'progress', runId: 'rB', text: 'B-step' } }, d.base);
    expect(d.poster.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'CA', thread_ts: 'TA', text: expect.stringContaining('A-step') }));
    expect(d.poster.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'CB', thread_ts: 'TB', text: expect.stringContaining('B-step') }));
    // resolving rB must not resolve or disturb rA
    await handleEnvelope({ id: 'm3', kind: 'message', from: 'ext:awe-rB', payload: { type: 'result', runId: 'rB', text: 'B-done' } }, d.base);
    await expect(awaitedB).resolves.toEqual({ text: 'B-done' });
    expect(d.pending.active()).toEqual(['rA']);
  });
});

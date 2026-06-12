import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from 'ai-workflow-engine';
import { ApprovalRegistry } from '../src/escalation/approval-registry.js';
import { makeSlackApprovalChannel, type ApprovalGate } from '../src/escalation/slack-channel.js';

function fakeGate() {
  const posts: Array<{ ts: string; text: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  const snippets: Array<{ title: string; content: string }> = [];
  let n = 0;
  const gate: ApprovalGate = {
    async post(text) {
      n += 1;
      const ts = `ts${n}`;
      posts.push({ ts, text });
      return { ts };
    },
    async update(ts, text) {
      updates.push({ ts, text });
    },
    async uploadSnippet(title, content) {
      snippets.push({ title, content });
    },
  };
  return { gate, posts, updates, snippets };
}

function req(label: string, policy?: PermissionRequest['policy']): PermissionRequest {
  return {
    runId: 'run1',
    agentLabel: label,
    cli: 'claude',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    ...(policy ? { policy } : {}),
  };
}

const ids = () => {
  let n = 0;
  return () => `id${(n += 1)}`;
};

describe('SlackApprovalChannel', () => {
  it('serializes concurrent requests: only one approval is posted at a time (1A)', async () => {
    const { gate, posts } = fakeGate();
    const registry = new ApprovalRegistry();
    const channel = makeSlackApprovalChannel({ gate, registry, newId: ids() });

    const p1 = channel.request(req('agent-a'));
    const p2 = channel.request(req('agent-b'));
    await new Promise((r) => setImmediate(r));

    // Second request must not post until the first resolves.
    expect(posts).toHaveLength(1);
    expect(registry.size()).toBe(1);

    registry.resolve('id1', { behavior: 'allow' });
    expect(await p1).toEqual({ behavior: 'allow' });
    await new Promise((r) => setImmediate(r));

    expect(posts).toHaveLength(2);
    registry.resolve('id2', { behavior: 'deny', reason: 'no' });
    expect(await p2).toEqual({ behavior: 'deny', reason: 'no' });
  });

  it('resolves allow when the approve button fires', async () => {
    const { gate, updates } = fakeGate();
    const registry = new ApprovalRegistry();
    const channel = makeSlackApprovalChannel({ gate, registry, newId: ids() });
    const p = channel.request(req('agent-a'));
    await new Promise((r) => setImmediate(r));
    registry.resolve('id1', { behavior: 'allow', reason: 'ok' });
    expect(await p).toEqual({ behavior: 'allow', reason: 'ok' });
    expect(updates[0]?.text).toMatch(/Approved/);
  });

  it("denies on timeout when policy.onTimeout is 'deny'", async () => {
    const { gate } = fakeGate();
    const registry = new ApprovalRegistry();
    // schedule fires synchronously to simulate timeout elapse.
    const channel = makeSlackApprovalChannel({
      gate,
      registry,
      newId: ids(),
      schedule: (fn) => {
        fn();
        return () => {};
      },
    });
    const decision = await channel.request(req('agent-a', { timeoutMs: 10, onTimeout: 'deny' }));
    expect(decision.behavior).toBe('deny');
  });

  it('attaches a snippet for oversized tool input instead of truncating', async () => {
    const { gate, snippets } = fakeGate();
    const registry = new ApprovalRegistry();
    const channel = makeSlackApprovalChannel({ gate, registry, newId: ids() });
    const big = { command: 'x'.repeat(5000) };
    const p = channel.request({ ...req('agent-a'), toolInput: big });
    await new Promise((r) => setImmediate(r));
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.content).toContain('x'.repeat(5000));
    registry.resolve('id1', { behavior: 'allow' });
    await p;
  });
});

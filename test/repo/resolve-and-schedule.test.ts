// test/repo/resolve-and-schedule.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoMemory } from '../../src/repo/memory.js';
import { resolveAndSchedule, type ResolveDeps } from '../../src/registry/workflows/steps/resolve-and-schedule.js';

// Minimal WorkflowApi fake: agent() returns scripted .data by label.
function fakeWf(byLabel: Record<string, unknown[]>) {
  const calls: Record<string, number> = {};
  return {
    args: {},
    phase() {},
    async agent(_p: string, opts?: { label?: string; schema?: unknown }) {
      const label = opts?.label ?? 'default';
      const i = calls[label] ?? 0; calls[label] = i + 1;
      const queue = byLabel[label] ?? [];
      return { text: '', data: queue[Math.min(i, queue.length - 1)], raw: null, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async parallel<T>(thunks: Array<() => Promise<T>>) { return Promise.all(thunks.map((t) => t())); },
    async pipeline() { return []; },
  } as any;
}

function deps(over: Partial<ResolveDeps>): ResolveDeps {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-sched-'));
  return {
    scopes: ['github.com/acme/*'],
    maxRepos: 10,
    memory: RepoMemory.load(join(dir, 'm.json')),
    provisioner: { async provision(p) { return `${p}.wt`; } },
    listRepos: async () => ['/ghq/github.com/acme/app', '/ghq/github.com/acme/engine'],
    ...over,
  };
}

describe('resolveAndSchedule', () => {
  it('processes a dependency before its dependent and records the graph', async () => {
    const wf = fakeWf({
      identify: [{ repos: ['/ghq/github.com/acme/app'] }],
      investigate: [
        { findings: 'app cause', dependencies: [{ repo: '/ghq/github.com/acme/engine', reason: 'calls engine' }] },
        { findings: 'engine cause', dependencies: [] },
      ],
    });
    const r = await resolveAndSchedule(wf, 'DEA-1', deps({}));
    expect(r.halted).toBeUndefined();
    expect(r.graph.nodes).toContain('/ghq/github.com/acme/engine');
    expect(r.findings.map((f) => f.findings).sort()).toEqual(['app cause', 'engine cause']);
  });

  it('drops out-of-scope discovered repos', async () => {
    const wf = fakeWf({
      identify: [{ repos: ['/ghq/github.com/acme/app'] }],
      investigate: [{ findings: 'x', dependencies: [{ repo: '/ghq/github.com/evil/x', reason: 'no' }] }],
    });
    const r = await resolveAndSchedule(wf, 'DEA-2', deps({}));
    expect(r.graph.nodes).not.toContain('/ghq/github.com/evil/x');
  });

  it('halts on a dependency cycle', async () => {
    const wf = fakeWf({
      identify: [{ repos: ['/ghq/github.com/acme/app'] }],
      investigate: [
        { findings: 'a', dependencies: [{ repo: '/ghq/github.com/acme/engine', reason: 'a->e' }] },
        { findings: 'e', dependencies: [{ repo: '/ghq/github.com/acme/app', reason: 'e->a (cycle)' }] },
      ],
    });
    const r = await resolveAndSchedule(wf, 'DEA-3', deps({}));
    expect(r.halted?.reason).toBe('cycle');
  });
});

import { describe, expect, it } from 'vitest';
import { surfaceEntry } from '../src/registry/workflows/surface.js';

describe('surface workflow entry', () => {
  it('is marked surfaced and validates {repo, task}', () => {
    const e = surfaceEntry(['engine', 'web']);
    expect(e.id).toBe('surface');
    expect(e.surfaced).toBe(true);
    expect(e.argsSchema.safeParse({ repo: 'engine', task: 'do it' }).success).toBe(true);
    expect(e.argsSchema.safeParse({ repo: 'nope', task: 'x' }).success).toBe(false);
    expect(e.argsSchema.safeParse({ repo: 'engine' }).success).toBe(false);
  });
  it('runs a single cmux agent with the task', async () => {
    const e = surfaceEntry(['engine']);
    const calls: any[] = [];
    const wf: any = { args: { repo: 'engine', task: 'review auth' }, agent: async (p: string, o: any) => { calls.push({ p, o }); return { text: 'ok', usage: { inputTokens: 0, outputTokens: 0 } }; } };
    const out = await e.module.default(wf);
    expect(calls[0].o).toEqual({ cli: 'cmux' });
    expect(calls[0].p).toBe('review auth');
    expect(out).toEqual({ text: 'ok' });
  });
});

import { describe, expect, it } from 'vitest';
import { surfaceEntry } from '../src/registry/workflows/surface.js';

describe('surface workflow entry', () => {
  it('is marked surfaced and validates {task}', () => {
    const e = surfaceEntry();
    expect(e.id).toBe('surface');
    expect(e.surfaced).toBe(true);
    expect(e.argsSchema.safeParse({ task: 'do it' }).success).toBe(true);
    expect(e.argsSchema.safeParse({}).success).toBe(false);
  });
  it('runs a single cmux agent with the task', async () => {
    const e = surfaceEntry();
    const calls: Array<{ p: string; o: unknown }> = [];
    const wf = {
      args: { task: 'review auth' },
      agent: async (p: string, o: unknown) => { calls.push({ p, o }); return { text: 'ok', usage: { inputTokens: 0, outputTokens: 0 } }; },
    };
    const out = await e.module.default(wf as never);
    expect(calls[0]?.o).toEqual({ cli: 'cmux' });
    expect(calls[0]?.p).toBe('review auth');
    expect(out).toEqual({ text: 'ok' });
  });
});

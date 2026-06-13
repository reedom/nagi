import { describe, expect, it, vi } from 'vitest';
import { PendingRuns } from '../src/agentbus-bridge/pending-runs.js';

describe('PendingRuns', () => {
  it('resolves the awaited result for a run', async () => {
    const p = new PendingRuns();
    const fns = { schedule: (fn: () => void, _ms: number) => { void fn; return () => {}; } };
    const awaited = p.await('r1', { channel: 'C', threadTs: '1', ceilingMs: 1000 }, fns);
    expect(p.get('r1')?.threadTs).toBe('1');
    p.resolveResult('r1', 'the answer');
    await expect(awaited).resolves.toEqual({ text: 'the answer' });
    expect(p.get('r1')).toBeUndefined();
  });
  it('rejects on cancel and on ceiling', async () => {
    const p = new PendingRuns();
    const immediate = { schedule: (fn: () => void, _ms: number) => { fn(); return () => {}; } };
    await expect(p.await('r2', { channel: 'C', threadTs: '2', ceilingMs: 1 }, immediate)).rejects.toThrow(/ceiling/);
    const never = { schedule: (_fn: () => void, _ms: number) => () => {} };
    const a = p.await('r3', { channel: 'C', threadTs: '3', ceilingMs: 1000 }, never);
    p.cancel('r3');
    await expect(a).rejects.toThrow(/cancelled/);
  });
  it('lists active runs and cancels all', () => {
    const p = new PendingRuns();
    const never = { schedule: (_fn: () => void, _ms: number) => () => {} };
    void p.await('a', { channel: 'C', threadTs: '1', ceilingMs: 1000 }, never).catch(() => {});
    void p.await('b', { channel: 'C', threadTs: '2', ceilingMs: 1000 }, never).catch(() => {});
    expect(p.active().sort()).toEqual(['a', 'b']);
    expect(p.cancelAll()).toBe(2);
    expect(p.active()).toEqual([]);
  });
});

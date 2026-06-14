import { describe, expect, it } from 'vitest';
import { ResidentSessions } from '../src/residents/resident-sessions.js';

const session = (over: Partial<{ runId: string; surfaceRef: string; channel: string; threadTs: string }> = {}) => ({
  runId: 'run-1',
  surfaceRef: 'workspace:run-1',
  channel: 'C1',
  threadTs: 't1',
  ...over,
});

describe('ResidentSessions', () => {
  it('looks a session up by thread and by run', () => {
    const r = new ResidentSessions();
    r.add(session());
    expect(r.getByThread('t1')).toMatchObject({ runId: 'run-1', surfaceRef: 'workspace:run-1' });
    expect(r.getByRun('run-1')).toMatchObject({ threadTs: 't1' });
  });

  it('remove clears both the thread and the run index', () => {
    const r = new ResidentSessions();
    r.add(session());
    expect(r.remove('t1')).toMatchObject({ runId: 'run-1' });
    expect(r.getByThread('t1')).toBeUndefined();
    expect(r.getByRun('run-1')).toBeUndefined();
    expect(r.remove('t1')).toBeUndefined();
  });

  it('lists every live session', () => {
    const r = new ResidentSessions();
    r.add(session());
    r.add(session({ runId: 'run-2', surfaceRef: 'workspace:run-2', threadTs: 't2' }));
    expect(r.list().map((s) => s.threadTs).sort()).toEqual(['t1', 't2']);
  });
});

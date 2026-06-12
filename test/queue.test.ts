import { describe, expect, it } from 'vitest';
import { WorkQueue } from '../src/dispatcher/queue.js';
import { deferred, silentLogger, tick } from './helpers.js';

describe('WorkQueue single-flight', () => {
  it('admits the first job immediately', async () => {
    const queue = new WorkQueue(silentLogger);
    const gate = deferred<void>();
    const admission = queue.enqueue({ label: 'first', run: () => gate.promise });
    expect(admission).toEqual({ accepted: true });
    expect(queue.status().active).toBe('first');
    gate.resolve();
    await tick();
  });

  it('queues a second job behind the active one and runs it in order', async () => {
    const queue = new WorkQueue(silentLogger);
    const order: string[] = [];
    const g1 = deferred<void>();
    queue.enqueue({ label: 'first', run: async () => { order.push('first'); await g1.promise; } });
    const admission = queue.enqueue({ label: 'second', run: async () => { order.push('second'); } });
    expect(admission.accepted).toBe(false);
    if (!admission.accepted) {
      expect(admission.busyWith).toBe('first');
      expect(admission.position).toBe(1);
    }
    g1.resolve();
    await tick();
    await tick();
    expect(order).toEqual(['first', 'second']);
    expect(queue.status().active).toBeUndefined();
  });

  it('keeps pumping after a job throws', async () => {
    const queue = new WorkQueue(silentLogger);
    const order: string[] = [];
    queue.enqueue({ label: 'boom', run: async () => { throw new Error('fail'); } });
    await tick();
    queue.enqueue({ label: 'after', run: async () => { order.push('after'); } });
    await tick();
    expect(order).toEqual(['after']);
  });

  it('clearPending drops queued jobs', async () => {
    const queue = new WorkQueue(silentLogger);
    const g1 = deferred<void>();
    queue.enqueue({ label: 'active', run: () => g1.promise });
    queue.enqueue({ label: 'q1', run: async () => {} });
    queue.enqueue({ label: 'q2', run: async () => {} });
    expect(queue.clearPending()).toBe(2);
    g1.resolve();
    await tick();
  });
});

import { describe, expect, it } from 'vitest';
import { makeThreadStore } from '../src/thread-state.js';

describe('thread store TTL', () => {
  it('returns a live pending clarification', () => {
    let now = 1_000;
    const store = makeThreadStore({ ttlMs: 100, now: () => now });
    store.set('t1', { originalText: 'review engine', question: 'which repo?' });
    expect(store.get('t1')?.question).toBe('which repo?');
  });

  it('evicts an expired entry on access (check-on-access)', () => {
    let now = 1_000;
    const store = makeThreadStore({ ttlMs: 100, now: () => now });
    store.set('t1', { originalText: 'x', question: 'q' });
    now = 1_201;
    expect(store.get('t1')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('sweeps all expired entries', () => {
    let now = 0;
    const store = makeThreadStore({ ttlMs: 100, now: () => now });
    store.set('a', { originalText: 'x', question: 'q' });
    store.set('b', { originalText: 'y', question: 'q' });
    now = 500;
    expect(store.sweep()).toBe(2);
    expect(store.size()).toBe(0);
  });

  it('delete consumes an entry', () => {
    const store = makeThreadStore();
    store.set('a', { originalText: 'x', question: 'q' });
    store.delete('a');
    expect(store.get('a')).toBeUndefined();
  });
});

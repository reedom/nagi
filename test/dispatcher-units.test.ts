import { describe, expect, it } from 'vitest';
import { parseControl } from '../src/dispatcher/control.js';
import { errorMessage, formatResult, formatStatus, shortLabel } from '../src/dispatcher/format.js';
import { descendantPids } from '../src/dispatcher/kill-tree.js';
import { stripMentions, toRequestContext } from '../src/slack/app.js';

describe('parseControl', () => {
  it('recognizes status and cancel synonyms', () => {
    expect(parseControl(' status ')).toBe('status');
    expect(parseControl('Cancel')).toBe('cancel');
    expect(parseControl('stop')).toBe('cancel');
    expect(parseControl('review the engine')).toBeUndefined();
  });
});

describe('format helpers', () => {
  it('shortLabel collapses whitespace and truncates', () => {
    expect(shortLabel('  review   the\nengine ')).toBe('review the engine');
    expect(shortLabel('a'.repeat(60)).endsWith('…')).toBe(true);
  });

  it('formatResult prefers summary/answer fields', () => {
    expect(formatResult({ summary: 'done' })).toBe('done');
    expect(formatResult({ answer: 'yes' })).toBe('yes');
    expect(formatResult({ other: 1 })).toContain('"other"');
  });

  it('formatStatus shows idle and queued', () => {
    expect(formatStatus({ queued: [] })).toMatch(/Idle/);
    expect(formatStatus({ active: 'a', queued: ['b', 'c'] })).toMatch(/Running: \*a\*/);
  });

  it('errorMessage unwraps Error and non-Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('kill-tree descendantPids', () => {
  it('walks the process table transitively', () => {
    const table = new Map<number, number[]>([
      [1, [2, 3]],
      [2, [4]],
      [4, [5]],
    ]);
    expect(descendantPids(1, table).sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    expect(descendantPids(3, table)).toEqual([]);
  });
});

describe('slack event normalization', () => {
  it('strips mentions', () => {
    expect(stripMentions('<@U123> review   the engine')).toBe('review the engine');
  });

  it('builds a RequestContext, defaulting threadTs to ts', () => {
    const req = toRequestContext({
      event: { user: 'U1', channel: 'C1', ts: '111.0', text: '<@B> hi' },
      context: { teamId: 'T1' },
    });
    expect(req).toEqual({ teamId: 'T1', userId: 'U1', channel: 'C1', threadTs: '111.0', text: 'hi' });
  });

  it('returns undefined when required fields are missing', () => {
    expect(toRequestContext({ event: { channel: 'C1' }, context: {} })).toBeUndefined();
  });
});

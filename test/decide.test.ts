import { describe, expect, it } from 'vitest';
import { decide } from '../src/dispatcher/decide.js';
import { makeRegistry } from '../src/registry/index.js';
import { triageResultSchema } from '../src/triage/schema.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const registry = makeRegistry(config);

const triage = (over: Partial<Record<string, unknown>>) =>
  triageResultSchema.parse({ workflowId: 'review-repo', args: {}, confidence: 0.9, ...over });

describe('decide (4A unified clarification path)', () => {
  it('dispatches a valid review-repo request with the resolved cwd', () => {
    const d = decide(config, registry, triage({ args: { repo: 'engine', scope: 'repo' } }));
    expect(d.kind).toBe('dispatch');
    if (d.kind === 'dispatch') {
      expect(d.entry.id).toBe('review-repo');
      expect(d.cwd).toBe('/tmp/engine');
      expect(d.budget).toBe(100_000);
      expect(d.args).toMatchObject({ repo: 'engine', scope: 'repo' });
    }
  });

  it('dispatches research with no cwd', () => {
    const d = decide(config, registry, triage({ workflowId: 'research', args: { question: 'why' } }));
    expect(d.kind).toBe('dispatch');
    if (d.kind === 'dispatch') expect(d.cwd).toBeUndefined();
  });

  it('clarifies when triage punts', () => {
    const d = decide(config, registry, triage({ clarificationQuestion: 'which repo?' }));
    expect(d).toEqual({ kind: 'clarify', question: 'which repo?' });
  });

  it('clarifies on low confidence', () => {
    const d = decide(config, registry, triage({ args: { repo: 'engine' }, confidence: 0.3 }));
    expect(d.kind).toBe('clarify');
  });

  it('clarifies on an unknown workflow id (hallucination)', () => {
    const d = decide(config, registry, triage({ workflowId: 'nope', confidence: 0.95 }));
    expect(d.kind).toBe('clarify');
  });

  it('clarifies and lists valid repos when the repo alias is unknown (D13)', () => {
    const d = decide(config, registry, triage({ args: { repo: 'ghost' } }));
    expect(d.kind).toBe('clarify');
    if (d.kind === 'clarify') expect(d.question).toMatch(/engine, web/);
  });

  it('clarifies and names the bad field on schema failure', () => {
    const d = decide(config, registry, triage({ workflowId: 'research', args: {} }));
    expect(d.kind).toBe('clarify');
    if (d.kind === 'clarify') expect(d.question).toMatch(/question/);
  });
});

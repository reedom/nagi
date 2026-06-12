import { describe, expect, it } from 'vitest';
import { runTriage } from '../src/triage/triage.js';
import { makeRegistry } from '../src/registry/index.js';
import { fakeAdapter, recordingLogger, testConfig } from './helpers.js';
import type { CliAdapter } from 'ai-workflow-engine';

const config = testConfig();
const registry = makeRegistry(config);
const aliases = ['engine', 'web'];

function deps(adapter: CliAdapter, log = recordingLogger()) {
  return { adapter, policy: config.triage, registry, aliases, log };
}

describe('runTriage', () => {
  it('returns parsed structured output', async () => {
    const adapter = fakeAdapter([
      { data: { workflowId: 'review-repo', args: { repo: 'engine' }, confidence: 0.9 } },
    ]);
    const result = await runTriage(deps(adapter), 'review the engine');
    expect(result.workflowId).toBe('review-repo');
    expect(result.confidence).toBe(0.9);
    // It sends a schema and the prompt enumerates workflows + repos.
    expect(adapter.calls[0]?.schema).toBeDefined();
    expect(adapter.calls[0]?.instructions).toMatch(/review-repo/);
    expect(adapter.calls[0]?.instructions).toMatch(/engine, web/);
  });

  it('throws when the adapter returns no structured output', async () => {
    const adapter = fakeAdapter([{ text: 'oops' }]);
    await expect(runTriage(deps(adapter), 'x')).rejects.toThrow(/structured output/);
  });

  it('warns when the token cap is exceeded', async () => {
    const log = recordingLogger();
    const adapter = fakeAdapter([
      {
        data: { workflowId: 'research', args: { question: 'q' }, confidence: 0.8 },
        usage: { inputTokens: 0, outputTokens: 999_999 },
      },
    ]);
    await runTriage(deps(adapter, log), 'x');
    expect(log.warns.some((w) => /token cap/.test(w))).toBe(true);
  });

  it('times out a hung adapter', async () => {
    const hung: CliAdapter = {
      id: 'hung',
      caps: { schema: true, resume: false, tools: true },
      run: () => new Promise(() => {}),
    };
    const fastPolicy = testConfig({ triage: { confidenceThreshold: 0.6, timeoutMs: 20 } });
    await expect(
      runTriage({ adapter: hung, policy: fastPolicy.triage, registry, aliases, log: recordingLogger() }, 'x'),
    ).rejects.toThrow(/timed out/);
  });
});

import { describe, expect, it } from 'vitest';
import { makeClaudeAdapter } from 'ai-workflow-engine';
import { makeRegistry } from '../src/registry/index.js';
import { repoAliases } from '../src/config.js';
import { runTriage } from '../src/triage/triage.js';
import { decide } from '../src/dispatcher/decide.js';
import { recordingLogger, testConfig } from './helpers.js';
import { triageCases, type CaseExpectation } from './fixtures/triage-cases.js';

const config = testConfig();
const registry = makeRegistry(config);

function isDispatch(e: CaseExpectation): e is { workflowId: string } {
  return 'workflowId' in e;
}

// Always-on dataset integrity checks: the golden set stays coherent with the
// registry even when the model is not exercised in CI.
describe('triage golden set integrity (7A)', () => {
  it('ships at least 15 cases', () => {
    expect(triageCases.length).toBeGreaterThanOrEqual(15);
  });

  it('every dispatch target is a real workflow id', () => {
    for (const c of triageCases) {
      if (isDispatch(c.expect)) expect(registry.has(c.expect.workflowId)).toBe(true);
    }
  });

  it('covers every registered workflow and includes clarification triggers', () => {
    const covered = new Set(triageCases.filter((c) => isDispatch(c.expect)).map((c) => (c.expect as { workflowId: string }).workflowId));
    for (const id of registry.ids()) expect(covered.has(id)).toBe(true);
    expect(triageCases.some((c) => !isDispatch(c.expect))).toBe(true);
    expect(triageCases.some((c) => c.name === 'unknown repo')).toBe(true);
  });
});

// Live evaluation against the real claude adapter. Opt-in (needs the `claude`
// CLI, a model, and is non-deterministic) so `pnpm test` stays green offline.
const live = process.env['NAGI_EVAL_LIVE'] === '1';
describe.skipIf(!live)('triage live eval', () => {
  const deps = {
    adapter: makeClaudeAdapter(),
    policy: config.triage,
    registry,
    aliases: repoAliases(config),
    log: recordingLogger(),
  };

  it.each(triageCases)('$name', async ({ input, expect: expectation }) => {
    const result = await runTriage(deps, input);
    const decision = decide(config, registry, result);
    if (isDispatch(expectation)) {
      expect(decision.kind).toBe('dispatch');
      if (decision.kind === 'dispatch') expect(decision.entry.id).toBe(expectation.workflowId);
    } else {
      expect(decision.kind).toBe('clarify');
    }
  }, 60_000);
});

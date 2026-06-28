import { describe, expect, it } from 'vitest';
import { createNagi } from '../src/create-nagi.js';
import { z } from 'zod';
import type { WorkflowFactory } from '../src/registry/types.js';

const config = {
  slack: { allowedTeamId: 'T', allowedUserIds: ['U'] },
  repoScopes: ['github.com/x/*'],
};
const trivial: WorkflowFactory = () => ({
  id: 'noop', description: 'noop', argsSchema: z.object({}),
  module: { meta: { name: 'noop', description: 'noop' }, async default() { return {}; } },
});

describe('createNagi', () => {
  it('returns a handle with start/stop', () => {
    const h = createNagi({ config, workflows: [trivial] });
    expect(typeof h.start).toBe('function');
    expect(typeof h.stop).toBe('function');
  });
  it('throws on empty workflows', () => {
    expect(() => createNagi({ config, workflows: [] })).toThrow(/workflow/i);
  });
  it('throws on invalid config object', () => {
    expect(() => createNagi({ config: { slack: {} } as never, workflows: [trivial] })).toThrow();
  });
});

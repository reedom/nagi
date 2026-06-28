import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildRegistry, type WorkflowFactory } from '../src/registry/types.js';
import { parseConfig } from '../src/config.js';

const ctx = { config: parseConfig({ slack: { allowedTeamId: 'T', allowedUserIds: ['U'] }, repoScopes: ['github.com/x/*'] }) };

describe('buildRegistry with ctx', () => {
  it('passes ctx to each factory and indexes by id', () => {
    const a: WorkflowFactory = (c) => ({ id: 'a', description: c.config.repoScopes[0] ?? '', argsSchema: z.object({}), module: { meta: { name: 'a', description: 'a' }, async default() { return {}; } } });
    const reg = buildRegistry([a], ctx);
    expect(reg.ids()).toEqual(['a']);
    expect(reg.get('a')?.description).toBe('github.com/x/*');
  });
});

import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const base = { slack: { allowedTeamId: 'T', allowedUserIds: ['U'] }, repoScopes: ['github.com/reedom/*'] };

describe('cmux config', () => {
  it('defaults cmux to undefined', () => {
    expect(parseConfig(base).cmux).toBeUndefined();
  });
  it('accepts a cmux block', () => {
    const c = parseConfig({ ...base, cmux: { socketPath: '/tmp/c.sock', password: 'pw', window: 'window:1' } });
    expect(c.cmux).toEqual({ socketPath: '/tmp/c.sock', password: 'pw', window: 'window:1' });
  });
});

import { describe, expect, it } from 'vitest';
import { checkAuth } from '../src/auth/allowlist.js';
import { testConfig } from './helpers.js';

describe('checkAuth', () => {
  const config = testConfig();

  it('allows an allowlisted user in the allowlisted team', () => {
    expect(checkAuth(config, { teamId: 'T1', userId: 'U1' })).toEqual({ allowed: true });
  });

  it('refuses a foreign workspace', () => {
    const result = checkAuth(config, { teamId: 'T999', userId: 'U1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/workspace/);
  });

  it('refuses a non-allowlisted user even in the right workspace', () => {
    const result = checkAuth(config, { teamId: 'T1', userId: 'U2' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/user/);
  });
});

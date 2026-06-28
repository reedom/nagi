import { describe, expect, it } from 'vitest';
import { filterScope } from '../../src/repo/scope.js';

const scopes = ['github.com/acme/*', 'github.com/reedom/*'];

describe('filterScope', () => {
  it('approves paths whose host/owner segments match a scope', () => {
    const r = filterScope(['/Users/x/ghq/github.com/acme/acme-app'], scopes);
    expect(r.approved).toEqual(['/Users/x/ghq/github.com/acme/acme-app']);
    expect(r.rejected).toEqual([]);
  });

  it('rejects out-of-scope owners', () => {
    const r = filterScope(['/Users/x/ghq/github.com/evilcorp/secret'], scopes);
    expect(r.approved).toEqual([]);
    expect(r.rejected).toEqual(['/Users/x/ghq/github.com/evilcorp/secret']);
  });

  it('does not match on substring (segment-aware)', () => {
    const r = filterScope(['/Users/x/ghq/github.com/acme-evil/x'], scopes);
    expect(r.rejected).toHaveLength(1);
  });

  it('rejects paths too short to contain host/owner/name', () => {
    expect(filterScope(['/tmp/x'], scopes).rejected).toEqual(['/tmp/x']);
  });
});

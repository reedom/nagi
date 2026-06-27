import { describe, expect, it } from 'vitest';
import { listScopedRepos } from '../../src/repo/ghq.js';

const out = [
  '/Users/x/ghq/github.com/acme/acme-app',
  '/Users/x/ghq/github.com/reedom/nagi',
  '/Users/x/ghq/github.com/evilcorp/secret',
].join('\n') + '\n';

describe('listScopedRepos', () => {
  it('returns only in-scope absolute paths', async () => {
    const repos = await listScopedRepos(['github.com/reedom/*'], async () => out);
    expect(repos).toEqual(['/Users/x/ghq/github.com/reedom/nagi']);
  });

  it('throws a clear error when ghq is unavailable', async () => {
    await expect(
      listScopedRepos(['github.com/reedom/*'], async () => { throw new Error('spawn ghq ENOENT'); }),
    ).rejects.toThrow(/ghq/);
  });
});

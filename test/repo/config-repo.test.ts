import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';

const base = {
  slack: { allowedTeamId: 'T', allowedUserIds: ['U'] },
  repoScopes: ['github.com/reedom/*'],
};

describe('repo resolution config', () => {
  it('defaults learnedReposPath, maxRepos, and worktree.script', () => {
    const c = parseConfig(base);
    expect(c.learnedReposPath).toBe('./learned-repos.json');
    expect(c.maxRepos).toBe(10);
    expect(c.worktree.script).toBe('scripts/worktree-provision.worktrunk.sh');
    expect(c.repoScopes).toEqual(['github.com/reedom/*']);
  });

  it('requires at least one repo scope', () => {
    expect(() => parseConfig({ ...base, repoScopes: [] })).toThrow();
  });
});

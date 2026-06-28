import { describe, expect, it } from 'vitest';
import { ScriptProvisioner } from '../../src/repo/worktree.js';

describe('ScriptProvisioner', () => {
  it('returns the last stdout line as the worktree cwd', async () => {
    const fakeRun = async () => 'creating...\n/Users/x/ghq/github.com/reedom/nagi.DEA-1\n';
    const p = new ScriptProvisioner('scripts/worktree-provision.worktrunk.sh', fakeRun);
    expect(await p.provision('/repo', 'DEA-1')).toBe('/Users/x/ghq/github.com/reedom/nagi.DEA-1');
  });

  it('throws when the script prints no path', async () => {
    const p = new ScriptProvisioner('s.sh', async () => '   \n');
    await expect(p.provision('/repo', 'DEA-1')).rejects.toThrow(/no worktree path/);
  });
});

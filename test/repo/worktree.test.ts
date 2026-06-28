import { describe, expect, it } from 'vitest';
import { ScriptProvisioner } from '../../src/repo/worktree.js';

describe('ScriptProvisioner', () => {
  it('returns the last stdout line as the worktree cwd', async () => {
    const fakeRun = async () => 'creating...\n/Users/x/ghq/github.com/reedom/nagi.ABC-1\n';
    const p = new ScriptProvisioner('scripts/worktree-provision.worktrunk.sh', fakeRun);
    expect(await p.provision('/repo', 'ABC-1')).toBe('/Users/x/ghq/github.com/reedom/nagi.ABC-1');
  });

  it('throws when the script prints no path', async () => {
    const p = new ScriptProvisioner('s.sh', async () => '   \n');
    await expect(p.provision('/repo', 'ABC-1')).rejects.toThrow(/no worktree path/);
  });

  it('rejects a ticket containing path-traversal characters before running the script', async () => {
    let ran = false;
    const fakeRun = async () => { ran = true; return '/some/path\n'; };
    const p = new ScriptProvisioner('s.sh', fakeRun);
    await expect(p.provision('/repo', '../../tmp/x')).rejects.toThrow(/invalid ticket/);
    expect(ran).toBe(false);
  });

  it('rejects a ticket with a leading slash before running the script', async () => {
    let ran = false;
    const fakeRun = async () => { ran = true; return '/some/path\n'; };
    const p = new ScriptProvisioner('s.sh', fakeRun);
    await expect(p.provision('/repo', '/etc/passwd')).rejects.toThrow(/invalid ticket/);
    expect(ran).toBe(false);
  });
});

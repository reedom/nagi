import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface WorktreeProvisioner {
  provision(repoPath: string, ticket: string): Promise<string>;
}

export type ScriptRunner = (script: string, repoPath: string, ticket: string) => Promise<string>;

// Runs the selected script with cwd = repoPath and ticket via argv + env.
const defaultRunner: ScriptRunner = async (script, repoPath, ticket) => {
  const { stdout } = await exec(script, [ticket], {
    cwd: repoPath,
    env: { ...process.env, NAGI_TICKET: ticket, NAGI_REPO_PATH: repoPath },
  });
  return stdout;
};

// The mechanism is selected by config.worktree.script; this just runs it and
// reads back the worktree path the script prints as its final stdout line.
export class ScriptProvisioner implements WorktreeProvisioner {
  constructor(private readonly script: string, private readonly run: ScriptRunner = defaultRunner) {}

  async provision(repoPath: string, ticket: string): Promise<string> {
    // Reject ticket values that could escape the worktree path via directory traversal.
    if (!/^[A-Za-z0-9._-]+$/.test(ticket)) {
      throw new Error(`invalid ticket: must match [A-Za-z0-9._-], got: ${ticket}`);
    }
    const stdout = await this.run(this.script, repoPath, ticket);
    const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length !== 0);
    const last = lines[lines.length - 1];
    if (!last) throw new Error(`worktree script printed no worktree path: ${this.script}`);
    return last;
  }
}

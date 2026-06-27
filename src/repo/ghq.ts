import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { filterScope } from './scope.js';

const run = promisify(execFile);

export type GhqRunner = () => Promise<string>;

const defaultRunner: GhqRunner = async () => {
  const { stdout } = await run('ghq', ['list', '-p']); // -p = absolute paths
  return stdout;
};

/** Absolute ghq repo paths, narrowed to the configured scopes (the candidate set). */
export async function listScopedRepos(scopes: string[], runner: GhqRunner = defaultRunner): Promise<string[]> {
  let raw: string;
  try {
    raw = await runner();
  } catch (err) {
    throw new Error(`ghq list failed (is ghq installed?): ${err instanceof Error ? err.message : err}`);
  }
  const all = raw.split('\n').map((l) => l.trim()).filter((l) => l.length !== 0);
  return filterScope(all, scopes).approved;
}

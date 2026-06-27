import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoMemory } from '../../src/repo/memory.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nagi-mem-')); file = join(dir, 'learned.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('RepoMemory', () => {
  it('returns undefined for unknown tickets and a missing file', () => {
    expect(RepoMemory.load(file).get('DEA-1')).toBeUndefined();
  });

  it('persists and reloads a ticket graph', () => {
    const m = RepoMemory.load(file);
    m.remember('DEA-1', { nodes: ['/a'], edges: [] });
    expect(RepoMemory.load(file).get('DEA-1')).toEqual({ nodes: ['/a'], edges: [] });
  });

  it('persists aliases', () => {
    const m = RepoMemory.load(file);
    m.rememberAlias('engine', '/abs/engine');
    expect(RepoMemory.load(file).getAlias('engine')).toBe('/abs/engine');
  });
});

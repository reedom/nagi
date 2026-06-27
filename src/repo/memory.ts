import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { RepoGraphData, RepoMemoryData } from './types.js';

const EMPTY: RepoMemoryData = { version: 1, tickets: {}, aliases: {} };

export class RepoMemory {
  private constructor(private readonly path: string, private data: RepoMemoryData) {}

  static load(path: string): RepoMemory {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as RepoMemoryData;
      if (parsed.version === 1) return new RepoMemory(path, parsed);
    } catch {
      // Missing or corrupt file -> start empty; we never throw on read.
    }
    return new RepoMemory(path, structuredClone(EMPTY));
  }

  get(ticket: string): RepoGraphData | undefined { return this.data.tickets[ticket]; }
  getAlias(name: string): string | undefined { return this.data.aliases[name]; }

  remember(ticket: string, graph: RepoGraphData): void {
    this.data.tickets[ticket] = graph;
    this.flush();
  }

  rememberAlias(name: string, repoPath: string): void {
    this.data.aliases[name] = repoPath;
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path); // atomic replace
  }
}

import type { RepoEdge, RepoGraphData } from './types.js';

// Repo dependency DAG. Edge from -> to means "from depends on to"; the
// dependency (to) is scheduled before the dependent (from).
export class RepoGraph {
  private readonly nodes: string[] = [];
  private readonly edges: RepoEdge[] = [];
  private readonly processed = new Set<string>();

  addNode(p: string): void {
    if (!this.nodes.includes(p)) this.nodes.push(p);
  }

  has(p: string): boolean { return this.nodes.includes(p); }
  size(): number { return this.nodes.length; }

  // Dependencies of a node = the out-edge targets.
  private dependenciesOf(p: string): string[] {
    return this.edges.filter((e) => e.from === p).map((e) => e.to);
  }

  // Adding from -> to closes a cycle iff `to` can already reach `from`.
  wouldCreateCycle(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length !== 0) {
      const cur = stack.pop() as string;
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.dependenciesOf(cur));
    }
    return false;
  }

  addEdge(from: string, to: string, reason: string): void {
    this.addNode(from);
    this.addNode(to);
    // Idempotent: skip duplicate edges so re-discovery on re-run does not accumulate them.
    if (!this.edges.some((e) => e.from === from && e.to === to)) {
      this.edges.push({ from, to, reason });
    }
  }

  markProcessed(p: string): void { this.processed.add(p); }
  hasUnprocessed(): boolean { return this.nodes.some((n) => !this.processed.has(n)); }

  // Ready = unprocessed AND every dependency already processed.
  readyNodes(): string[] {
    return this.nodes.filter(
      (n) => !this.processed.has(n) && this.dependenciesOf(n).every((d) => this.processed.has(d)),
    );
  }

  toData(): RepoGraphData {
    return { nodes: [...this.nodes], edges: this.edges.map((e) => ({ ...e })) };
  }

  static fromData(d: RepoGraphData): RepoGraph {
    const g = new RepoGraph();
    for (const n of d.nodes) g.addNode(n);
    for (const e of d.edges) g.addEdge(e.from, e.to, e.reason);
    return g;
  }

  render(): string {
    const lines = ['graph LR'];
    for (const e of this.edges) lines.push(`  ${JSON.stringify(e.from)} --> ${JSON.stringify(e.to)}`);
    for (const n of this.nodes) if (!this.edges.some((e) => e.from === n || e.to === n)) lines.push(`  ${JSON.stringify(n)}`);
    return lines.join('\n');
  }
}

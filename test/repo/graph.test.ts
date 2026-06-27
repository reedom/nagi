import { describe, expect, it } from 'vitest';
import { RepoGraph } from '../../src/repo/graph.js';

describe('RepoGraph', () => {
  it('treats leaves (no dependencies) as immediately ready', () => {
    const g = new RepoGraph();
    g.addNode('/a'); g.addNode('/b');
    expect(new Set(g.readyNodes())).toEqual(new Set(['/a', '/b']));
  });

  it('holds a dependent back until its dependency is processed', () => {
    const g = new RepoGraph();
    g.addNode('/app'); g.addNode('/engine');
    g.addEdge('/app', '/engine', 'app calls engine'); // app depends on engine
    expect(g.readyNodes()).toEqual(['/engine']);       // dependency first
    g.markProcessed('/engine');
    expect(g.readyNodes()).toEqual(['/app']);
  });

  it('detects cycles before they are added', () => {
    const g = new RepoGraph();
    g.addNode('/a'); g.addNode('/b');
    g.addEdge('/a', '/b', 'a->b');
    expect(g.wouldCreateCycle('/b', '/a')).toBe(true);
    expect(g.wouldCreateCycle('/a', '/b')).toBe(false);
  });

  it('round-trips through toData/fromData', () => {
    const g = new RepoGraph();
    g.addNode('/a'); g.addNode('/b'); g.addEdge('/a', '/b', 'r');
    const g2 = RepoGraph.fromData(g.toData());
    expect(g2.toData()).toEqual({ nodes: ['/a', '/b'], edges: [{ from: '/a', to: '/b', reason: 'r' }] });
  });
});

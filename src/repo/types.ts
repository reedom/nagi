export interface RepoEdge { from: string; to: string; reason: string } // from depends on to
export interface RepoGraphData { nodes: string[]; edges: RepoEdge[] }
export interface RepoMemoryData {
  version: 1;
  tickets: Record<string, RepoGraphData>;
  aliases: Record<string, string>;
}
export interface DiscoveredDependency { repo: string; reason: string }

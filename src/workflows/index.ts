// Opt-in built-in workflows + author helpers. Import as `nagi/workflows`.
export { reviewRepoEntry as reviewRepo } from '../registry/workflows/review-repo.js';
export { researchEntry as research } from '../registry/workflows/research.js';
export { surfaceEntry as surface } from '../registry/workflows/surface.js';
export { approvalDemoEntry as approvalDemo } from '../registry/workflows/approval-demo.js';
export { investigateTicket } from '../registry/workflows/investigate-ticket.js';

export { resolveAndSchedule } from '../registry/workflows/steps/resolve-and-schedule.js';
export type { ResolveDeps, ResolveResult, NodeFinding } from '../registry/workflows/steps/resolve-and-schedule.js';
export { filterScope } from '../repo/scope.js';
export { listScopedRepos } from '../repo/ghq.js';
export { RepoMemory } from '../repo/memory.js';
export { RepoGraph } from '../repo/graph.js';
export { ScriptProvisioner } from '../repo/worktree.js';
export type { WorktreeProvisioner } from '../repo/worktree.js';
export type { RepoEdge, RepoGraphData, DiscoveredDependency } from '../repo/types.js';

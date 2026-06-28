import { E as EntryFactory, W as WorkflowFactory, c as WorkflowApi } from '../types-DWQjEzd2.js';
import 'zod';

declare const reviewRepoEntry: EntryFactory;

declare const researchEntry: EntryFactory;

declare const surfaceEntry: EntryFactory;

declare const approvalDemoEntry: EntryFactory;

declare const investigateTicket: WorkflowFactory;

interface RepoEdge {
    from: string;
    to: string;
    reason: string;
}
interface RepoGraphData {
    nodes: string[];
    edges: RepoEdge[];
}
interface DiscoveredDependency {
    repo: string;
    reason: string;
}

declare class RepoMemory {
    private readonly path;
    private data;
    private constructor();
    static load(path: string): RepoMemory;
    get(ticket: string): RepoGraphData | undefined;
    getAlias(name: string): string | undefined;
    remember(ticket: string, graph: RepoGraphData): void;
    rememberAlias(name: string, repoPath: string): void;
    private flush;
}

interface WorktreeProvisioner {
    provision(repoPath: string, ticket: string): Promise<string>;
}
type ScriptRunner = (script: string, repoPath: string, ticket: string) => Promise<string>;
declare class ScriptProvisioner implements WorktreeProvisioner {
    private readonly script;
    private readonly run;
    constructor(script: string, run?: ScriptRunner);
    provision(repoPath: string, ticket: string): Promise<string>;
}

interface NodeFinding {
    repo: string;
    findings: string;
    dependencies: DiscoveredDependency[];
}
interface ResolveDeps {
    scopes: string[];
    maxRepos: number;
    memory: RepoMemory;
    provisioner: WorktreeProvisioner;
    listRepos: (scopes: string[]) => Promise<string[]>;
}
interface ResolveResult {
    graph: RepoGraphData;
    findings: NodeFinding[];
    halted?: {
        reason: 'cycle' | 'maxRepos';
        detail: string;
    };
}
declare function resolveAndSchedule(wf: WorkflowApi, ticket: string, deps: ResolveDeps): Promise<ResolveResult>;

interface ScopeResult {
    approved: string[];
    rejected: string[];
}
declare function filterScope(repoPaths: string[], scopes: string[]): ScopeResult;

type GhqRunner = () => Promise<string>;
/** Absolute ghq repo paths, narrowed to the configured scopes (the candidate set). */
declare function listScopedRepos(scopes: string[], runner?: GhqRunner): Promise<string[]>;

declare class RepoGraph {
    private readonly nodes;
    private readonly edges;
    private readonly processed;
    addNode(p: string): void;
    has(p: string): boolean;
    size(): number;
    private dependenciesOf;
    wouldCreateCycle(from: string, to: string): boolean;
    addEdge(from: string, to: string, reason: string): void;
    markProcessed(p: string): void;
    hasUnprocessed(): boolean;
    readyNodes(): string[];
    toData(): RepoGraphData;
    static fromData(d: RepoGraphData): RepoGraph;
    render(): string;
}

export { type DiscoveredDependency, type NodeFinding, type RepoEdge, RepoGraph, type RepoGraphData, RepoMemory, type ResolveDeps, type ResolveResult, ScriptProvisioner, type WorktreeProvisioner, approvalDemoEntry as approvalDemo, filterScope, investigateTicket, listScopedRepos, researchEntry as research, resolveAndSchedule, reviewRepoEntry as reviewRepo, surfaceEntry as surface };

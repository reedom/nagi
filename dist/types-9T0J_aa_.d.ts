import { z, ZodType } from 'zod';

interface EscalationPolicy {
    timeoutMs: number;
    onTimeout: 'deny' | 'wait';
}

interface AgentEscalation {
    runId: string;
    socketPath: string;
    agentLabel: string;
    policy: EscalationPolicy;
    rules: string[];
    helperCommand?: string;
}
/**
 * Claude permission mode for a spawned agent, mapped to a CLI flag: `default` (none),
 * `acceptEdits`/`auto` -> `--permission-mode <mode>`, `bypassPermissions` ->
 * `--dangerously-skip-permissions`. This tunes claude's BUILT-IN permission flow;
 * a host's PermissionRequest approval hook (as nagi installs) is a conditional substitute
 * for claude's own prompt — it fires only when claude would ask, so it stays silent under
 * `bypassPermissions` and for tools claude already auto-allows.
 */
type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';
interface AgentSpec {
    prompt: string;
    model?: string;
    schema?: unknown;
    instructions?: string;
    tools?: string[];
    cwd?: string;
    permissionMode?: PermissionMode;
    escalation?: AgentEscalation;
}
interface AgentUsage {
    inputTokens: number;
    outputTokens: number;
}
interface AgentResult<T = unknown> {
    text: string;
    data?: T;
    raw: unknown;
    usage: AgentUsage;
    sessionId?: string;
}
interface SurfaceMeta {
    name?: string;
    description?: string;
}
interface CliAdapter {
    readonly id: string;
    readonly caps: {
        schema: boolean;
        resume: boolean;
        tools: boolean;
    };
    run(spec: AgentSpec): Promise<AgentResult>;
    /** Optional: surfaced adapters that own a workspace can rename/describe it. */
    setMeta?(meta: SurfaceMeta): Promise<void>;
}
interface AgentEscalationOptions {
    timeoutMs?: number;
    onTimeout?: 'deny' | 'wait';
    disabled?: boolean;
}
interface AgentOptions {
    cli?: string;
    model?: string;
    schema?: unknown;
    instructions?: string;
    tools?: string[];
    cwd?: string;
    /** Per-call permission mode; overrides the run-level default. */
    permissionMode?: PermissionMode;
    label?: string;
    phase?: string;
    escalation?: AgentEscalationOptions;
}
type Stage = (prev: unknown, item: unknown, index: number) => unknown;
interface Budget {
    total: number | null;
    spent(): number;
    remaining(): number;
}
interface WorkflowApi {
    agent(prompt: string, opts?: AgentOptions): Promise<AgentResult>;
    parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
    pipeline(items: unknown[], ...stages: Stage[]): Promise<Array<unknown>>;
    phase(title: string): void;
    log(message: string): void;
    budget: Budget;
    args: unknown;
    /** Set the run's surface (cmux workspace) name/description; no-op on lanes without a surface. */
    setSurfaceMeta(meta: SurfaceMeta): Promise<void>;
}
interface WorkflowMeta {
    name: string;
    description: string;
    whenToUse?: string;
    phases?: Array<{
        title: string;
        detail?: string;
        model?: string;
    }>;
}
interface WorkflowModule {
    meta: WorkflowMeta;
    default: (wf: WorkflowApi) => Promise<unknown>;
}

declare const configSchema: z.ZodObject<{
    slack: z.ZodObject<{
        allowedTeamId: z.ZodString;
        allowedUserIds: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        allowedTeamId: string;
        allowedUserIds: string[];
    }, {
        allowedTeamId: string;
        allowedUserIds: string[];
    }>;
    repoScopes: z.ZodArray<z.ZodString, "many">;
    learnedReposPath: z.ZodDefault<z.ZodString>;
    maxRepos: z.ZodDefault<z.ZodNumber>;
    worktree: z.ZodDefault<z.ZodObject<{
        script: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        script: string;
    }, {
        script?: string | undefined;
    }>>;
    cmux: z.ZodOptional<z.ZodObject<{
        socketPath: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodString>;
        window: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        socketPath?: string | undefined;
        password?: string | undefined;
        window?: string | undefined;
    }, {
        socketPath?: string | undefined;
        password?: string | undefined;
        window?: string | undefined;
    }>>;
    triage: z.ZodDefault<z.ZodObject<{
        model: z.ZodDefault<z.ZodString>;
        confidenceThreshold: z.ZodDefault<z.ZodNumber>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        tokenCap: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        model: string;
        confidenceThreshold: number;
        timeoutMs: number;
        tokenCap: number;
    }, {
        model?: string | undefined;
        confidenceThreshold?: number | undefined;
        timeoutMs?: number | undefined;
        tokenCap?: number | undefined;
    }>>;
    defaultBudget: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    auditLogPath: z.ZodDefault<z.ZodString>;
    permissionMode: z.ZodDefault<z.ZodEnum<["default", "acceptEdits", "auto", "bypassPermissions"]>>;
}, "strip", z.ZodTypeAny, {
    slack: {
        allowedTeamId: string;
        allowedUserIds: string[];
    };
    repoScopes: string[];
    learnedReposPath: string;
    maxRepos: number;
    worktree: {
        script: string;
    };
    triage: {
        model: string;
        confidenceThreshold: number;
        timeoutMs: number;
        tokenCap: number;
    };
    defaultBudget: number | null;
    auditLogPath: string;
    permissionMode: "default" | "acceptEdits" | "auto" | "bypassPermissions";
    cmux?: {
        socketPath?: string | undefined;
        password?: string | undefined;
        window?: string | undefined;
    } | undefined;
}, {
    slack: {
        allowedTeamId: string;
        allowedUserIds: string[];
    };
    repoScopes: string[];
    learnedReposPath?: string | undefined;
    maxRepos?: number | undefined;
    worktree?: {
        script?: string | undefined;
    } | undefined;
    cmux?: {
        socketPath?: string | undefined;
        password?: string | undefined;
        window?: string | undefined;
    } | undefined;
    triage?: {
        model?: string | undefined;
        confidenceThreshold?: number | undefined;
        timeoutMs?: number | undefined;
        tokenCap?: number | undefined;
    } | undefined;
    defaultBudget?: number | null | undefined;
    auditLogPath?: string | undefined;
    permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | undefined;
}>;
type NagiConfig = z.infer<typeof configSchema>;
declare function parseConfig(raw: unknown): NagiConfig;
declare function loadConfig(path: string): NagiConfig;

interface RegistryEntry {
    id: string;
    description: string;
    /** Validates triage-extracted args; failure becomes a clarification (4A). */
    argsSchema: ZodType;
    module: WorkflowModule;
    /** Per-entry token budget override; falls back to config.defaultBudget (3A). */
    budgetOverride?: number | null;
    /** Dispatched on the concurrent surfaced lane (bypasses the single-flight queue). */
    surfaced?: boolean;
}
interface NagiContext {
    config: NagiConfig;
}
type WorkflowFactory = (ctx: NagiContext) => RegistryEntry;

export { type AgentOptions as A, type CliAdapter as C, type NagiConfig as N, type RegistryEntry as R, type WorkflowFactory as W, type AgentResult as a, type NagiContext as b, type WorkflowApi as c, type WorkflowModule as d, loadConfig as l, parseConfig as p };

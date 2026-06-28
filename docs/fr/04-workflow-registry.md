---
refs:
  id: fr:04-workflow-registry
  kind: fr
  title: "Workflow Registry"
  spec: nagi-v1
  depends_on:
    - fr:10-configuration
  related:
    - fr:03-triage
    - fr:05-request-dispatch
    - fr:12-agentbus-surfaced-lane
  modules:
    - src/registry/index.ts
    - src/registry/types.ts
    - src/registry/workflows/review-repo.ts
    - src/registry/workflows/research.ts
    - src/registry/workflows/approval-demo.ts
    - src/registry/workflows/investigate-ticket.ts
    - src/registry/workflows/steps/resolve-and-schedule.ts
    - src/repo/scope.ts
    - src/repo/ghq.ts
    - src/repo/memory.ts
    - src/repo/graph.ts
    - src/repo/worktree.ts
    - src/repo/types.ts
---

# FR 04: Workflow Registry

> The hand-registered set of workflows nagi can run. Each entry pairs a triage-facing description and a zod arg schema with a real engine `WorkflowModule`, so the same workflow format powers both hand-written v1 entries and (eventually) generated ones.

## Purpose

v1 dispatch is a fixed, hand-registered registry plus an LLM triage agent — not compose-on-the-fly. The registry is the single source of truth for "what nagi can do": it supplies the menu that triage ([03-triage](03-triage.md)) chooses from, the schemas the dispatcher validates against ([05-request-dispatch](05-request-dispatch.md)), and the executable module the engine runs. Auto-authoring workflows (the foundry) is explicitly v2 and out of scope here.

## User-visible Behavior

### Entry shape

A `RegistryEntry` (`src/registry/types.ts`) carries:

| Field | Type | Role |
| --- | --- | --- |
| `id` | `string` | Stable workflow identifier triage selects by. |
| `description` | `string` | Natural-language summary fed to triage and clarification prompts. |
| `argsSchema` | `ZodType` | Validates triage-extracted args; failure becomes a clarification (4A). |
| `module` | `WorkflowModule` | A **real** engine module (2A); the concierge runs `runWorkflow(entry.module, ...)`. |
| `budgetOverride?` | `number \| null` | Per-entry token budget; falls back to `config.defaultBudget` (3A). |
| `surfaced?` | `boolean` | When `true`, dispatched on the concurrent surfaced lane (see [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md)). |

Embedding a live `WorkflowModule` (decision 2A) means hand-written entries and future generated foundry files share the engine's one workflow format — there is no separate "registry-only" execution path.

### Factories and construction

Entries are not static objects; they are produced by an `EntryFactory = () => RegistryEntry`. `index.ts` holds the seed list and the assembler:

```ts
export const SEED_FACTORIES: EntryFactory[] = [reviewRepoEntry, researchEntry, surfaceEntry];

export function makeRegistry(config: NagiConfig): Registry {
  const seed =
    process.env['NAGI_ENABLE_APPROVAL_DEMO'] === '1'
      ? [...SEED_FACTORIES, approvalDemoEntry]
      : SEED_FACTORIES;
  const base = buildRegistry(seed);
  return new Registry([...base.list(), makeInvestigateTicketEntry(config)]);
}
```

`buildRegistry` calls each factory (zero-arg) and wraps the results in a `Registry` (an id-keyed map exposing `get`, `has`, `ids`, `list`). The `investigate-ticket` entry requires `config` (for `repoScopes`, `learnedReposPath`, `maxRepos`, and `worktree.script`) and is added directly after the seed set. The `approval-demo` entry is opt-in via `NAGI_ENABLE_APPROVAL_DEMO=1` so it never competes for triage in normal use.

### Repo arguments are free-form

Repo references in workflow arg schemas are free-form strings (`z.string()`), not a `z.enum` over a configured alias map. The `repoHint` arg in `review-repo` and the `ticketRef`/`repoHint` args in `investigate-ticket` carry whatever the user typed; the actual repo path is resolved at runtime by the workflow via `ghq list` filtered through the `repoScopes` allowlist in configuration ([10-configuration](10-configuration.md)).

### Shipped seed workflows

- **review-repo** (`workflows/review-repo.ts`): "Review a repository (or its working diff) and summarize the most important risks." Args: `repoHint` (free-form string — the agent locates the repo using its tools), `scope` (`'repo' | 'diff'`, default `'repo'`), optional `focus`. The module runs one read-only review agent (`Bash`, `Read`, `Grep`, `Glob`) that locates the repo from the hint and cds into it.
- **investigate-ticket** (`workflows/investigate-ticket.ts`): "Investigate a ticket end-to-end: find the starting repo, root-cause it, and follow repo-to-repo dependencies." Args: `ticketRef` (required non-empty string, e.g. `DEA-1234`), `repoHint` (optional). The module reads the ticket via the agent's ambient MCP/skills, identifies starting repos from the scope-filtered `ghq list` candidate set, provisions a worktree per repo via `config.worktree.script`, investigates each repo, follows repo-to-repo dependencies as a DAG (independent nodes run in parallel; edges enforce ordering), halts on a dependency cycle (escalate to human) or `maxRepos` limit, and persists the resolved ticket→graph to `config.learnedReposPath`. The DAG scheduling logic lives in `steps/resolve-and-schedule.ts`.
- **research** (`workflows/research.ts`): "Research an open question from multiple angles and synthesize an answer." Args: `question` (non-empty string). The module fans out three angle agents in parallel, then synthesizes — chosen for mechanism coverage (approval serialization and budget under real concurrency), not topic.
- **approval-demo** (`workflows/approval-demo.ts`): a deliberate test affordance with empty args (`z.object({})`). The agent is granted no tools but told it must run `date -u`, forcing a tool escalation so the Approve/Deny round-trip ([08-escalation-approvals](08-escalation-approvals.md)) can be exercised. Opt-in only.

The `surface` entry (`workflows/surface.ts`) is also seeded and carries `surfaced: true`; its surfaced-lane behavior is documented in [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md) and [13-resident-agent](13-resident-agent.md), not here.

### How the registry feeds triage and dispatch

- **Triage** builds its system prompt fresh from the live registry, listing each entry's `id`, `description`, and a readable rendering of `argsSchema` (`src/triage/prompt.ts`). Descriptions are therefore load-bearing selection text.
- **Dispatch** resolves `decide()` (`src/dispatcher/decide.ts`): it looks up `registry.get(triage.workflowId)`, validates `triage.args` with `entry.argsSchema.safeParse`, and sets `budget = entry.budgetOverride ?? config.defaultBudget`. No cwd is resolved here — repo-aware workflows resolve their per-agent working directory after identifying the target repo. An unknown id or a schema failure collapses to a single clarification path (4A). `surfaced` entries are routed to the surfaced lane by the dispatcher.

## Capabilities

- Declare a workflow once as a description + zod arg schema + executable `WorkflowModule`.
- Repo arguments are free-form strings resolved at runtime by the workflow; no static alias enum is required.
- Override the per-entry token budget, otherwise inherit the configured default (3A).
- Mark an entry `surfaced` to opt into the concurrent surfaced lane.
- Toggle the approval-demo entry on via an environment flag without touching the seed list.
- `investigate-ticket`: agent-driven, ticket-first repo discovery with DAG scheduling, parallel independent node execution, cycle detection, and memory persistence.

## Boundaries

- No runtime registration API: the seed set is hand-edited in `index.ts`; there is no add/remove at runtime.
- The foundry (auto-authoring / compose-on-the-fly workflows) is v2 and deferred.
- The registry does not execute, schedule, queue, or budget-enforce; it only describes. Validation, lane routing, and budget application happen in dispatch ([05-request-dispatch](05-request-dispatch.md)).
- Repo resolution (free-form hint → absolute path) is performed at runtime inside each workflow via `src/repo/` utilities; the registry does not hold or resolve repo paths.

## Traceability

- **Design decisions**: 2A (registry entries embed a real `WorkflowModule`; generated and hand-written entries share one format) and 3A (default per-request budget with per-entry override); R3 (resolution lives in the dispatched workflow), R4 (triage extracts free-form `ticketRef`/`repoHint`; the static repo enum is retired), R6–R10 (DAG scheduling, parallelism, cycle halt, maxRepos cap).
- **Modules**: `src/registry/index.ts`, `src/registry/types.ts`, `src/registry/workflows/review-repo.ts`, `src/registry/workflows/research.ts`, `src/registry/workflows/approval-demo.ts`, `src/registry/workflows/investigate-ticket.ts`, `src/registry/workflows/steps/resolve-and-schedule.ts`, `src/repo/scope.ts`, `src/repo/ghq.ts`, `src/repo/memory.ts`, `src/repo/graph.ts`, `src/repo/worktree.ts`, `src/repo/types.ts`.
- **Related FR**: [03-triage](03-triage.md) consumes entry descriptions and schemas to select a workflow; [05-request-dispatch](05-request-dispatch.md) validates args and applies the budget; [12-agentbus-surfaced-lane](12-agentbus-surfaced-lane.md) handles `surfaced: true` entries; [10-configuration](10-configuration.md) supplies `repoScopes`, `learnedReposPath`, `maxRepos`, `worktree.script`, and the default budget.

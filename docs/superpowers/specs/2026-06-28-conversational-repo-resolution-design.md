# Conversational repo resolution + worktrunk integration

Status: design (approved for spec review)
Date: 2026-06-28
Author: tohru.hanai (with Claude)

## Problem

Today nagi only touches repos that appear as a static alias map in
`nagi.config.json` (`repos`), baked into every workflow's `argsSchema` as a
`z.enum` at startup (decision D13). Two limitations:

1. nagi cannot **learn** which repos it may touch from conversation and
   remember the resolution for next time.
2. nagi has no notion of the worktrunk worktree layout
   (`<repo-base>.<ticket>`, from `worktree-path = "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}"`),
   so it cannot operate inside per-ticket worktrees.

This design replaces the static alias map with **agent-driven, ticket-first
repo discovery** gated by a **deterministic scope boundary**, persists the
result, and operates inside worktrunk worktrees via a **replaceable
provisioner**.

## Goals / non-goals

Goals:
- Resolve target repo(s) from a ticket reference using an agent (ticket -> repo
  is a reasoning task; the mapping is not a literal string match).
- Keep the security boundary deterministic and in nagi: agent proposes repos,
  nagi scope-filters them before any work happens.
- Support a ticket spanning **multiple repos** discovered **during**
  investigation, modelled as a repo-level dependency DAG.
- Remember per-ticket resolutions for reuse.
- Operate inside worktrunk worktrees, with the worktree mechanism swappable.

Non-goals:
- nagi does not hardcode a ticket provider (Linear/Jira). The agent uses
  ambient MCP/skills.
- No database. Persistence is a JSON state file, matching the existing
  `audit.jsonl` / thread-state file conventions.
- Resolution does not run in triage or the dispatcher core; it is a workflow
  step (keep nagi thin).

## Key decisions

| # | Decision |
|---|---|
| R1 | Repo source of truth = `ghq list -p` (absolute paths), not config. |
| R2 | Candidate set is pre-filtered by a **scope allowlist** (`host/owner` prefix globs) before being shown to the agent, AND the agent's chosen repos are scope-filtered again on the way back (defence in depth; the return gate is authoritative). |
| R3 | Resolution is **agent-driven** and lives in the dispatched workflow, not triage/dispatcher. |
| R4 | triage stays thin: extracts a free-form `ticketRef` (and optional `repoHint`). The static `repos` enum (D13) is retired. |
| R5 | Persistence = JSON state file (`learnedReposPath`, default `./learned-repos.json`). |
| R6 | A ticket's repos form a **dependency DAG**; edge `A -> B` means "A depends on B"; process dependencies (upstream/leaves) first. |
| R7 | Independent ready nodes run **in parallel** (`wf.parallel`) from the start. |
| R8 | Worktree provisioning is a **replaceable external script** (`WorktreeProvisioner` -> `ScriptProvisioner`): nagi invokes the script at `config.worktree.script` (default `scripts/worktree-provision.sh`, wrapping worktrunk `wt`) with `cwd = repoPath`; the script creates/enters the worktree and prints its absolute path on stdout. Swapping the script swaps the mechanism. |
| R9 | **Cycle detection halts** the run and escalates to a human in-thread; nagi does not auto-resolve cycles. |
| R10 | A `maxRepos` cap bounds graph growth (runaway protection). |

## Architecture

Three responsibilities, with the security boundary held by nagi:

```
triage (thin)        : pick workflow + extract free-form { ticketRef, repoHint? }.
   | dispatch          No repo enum, no cwd resolution (repo is unknown yet).
   v
investigate-ticket workflow.default()  (host TS; receives agent results)
   |
   |  resolve-and-schedule step (component):
   |   graph = RepoGraph()
   |   initial = memory.get(ticket) ?? identifyInitialRepo(wf, ticket, scopedCandidates)
   |   graph.addNodes( scope.filter(initial).approved )          # nagi gate
   |
   |   while graph.hasUnprocessed() and graph.size <= maxRepos:
   |     ready = graph.readyNodes()        # deps processed, mutually independent
   |     results = await wf.parallel(ready.map(node => () => processNode(node)))
   |     for { node, findings, dependencies } in results:
   |       graph.markProcessed(node, findings)
   |       for dep in scope.filter(dependencies).approved:        # nagi gate
   |         if graph.wouldCreateCycle(node -> dep):
   |           escalateCycleToHuman(node, dep); HALT               # R9
   |         graph.addNode(dep.repo); graph.addEdge(node -> dep.repo, dep.reason)
   |
   |   memory.remember(ticket, graph)
   |   return report(graph)                # dep-ordered findings + DAG diagram
   v
processNode(node):
   worktreeCwd = provisioner.provision(node.repoPath, ticket)     # R8, swappable
   return await investigate(wf, node, ticket, { cwd: worktreeCwd, schema })
            # agent root-causes; returns { findings, dependencies: [{ repo, reason }] }
```

The scope filter is a pure function invoked at **every** graph expansion, so no
repo enters the graph (and thus gets a worktree / agent) without passing the
`host/owner` boundary.

## Components

New module group `src/repo/`:

- `ghq.ts` — `listScopedRepos(scopes): Promise<string[]>`. Runs `ghq list -p`
  via `child_process`, returns absolute paths filtered to `scopes`. Guard-clause
  errors if `ghq` is absent.
- `scope.ts` — `filterScope(repoPaths, scopes): { approved: string[]; rejected: string[] }`.
  Pure. Matches a ghq absolute path's `host/owner/name` tail against `host/owner`
  prefix globs. Fully unit-testable; this is the security boundary.
- `memory.ts` — `RepoMemory` over a JSON file:
  `get(ticketRef): RepoGraphData | undefined`, `remember(ticketRef, graph)`,
  plus an `aliases` map for non-ticket hints. Atomic write (temp + rename).
- `worktree.ts` — `interface WorktreeProvisioner { provision(repoPath, ticket): Promise<string /* worktree cwd */> }`
  and a default `ScriptProvisioner` that runs the **external script** at
  `config.worktree.script` with `cwd = repoPath` and `ticket` passed via argv +
  env (`NAGI_TICKET`, `NAGI_REPO_PATH`). The script owns the mechanism (create /
  switch the worktree) and prints the worktree's absolute path as its last stdout
  line; `ScriptProvisioner` reads that back as the agent cwd. **The mechanism is
  selected by config, not by editing a file.** `config.worktree.script` is the
  selector: the repo ships example scripts under `scripts/` (e.g. a worktrunk
  wrapper and a plain `git worktree add` variant), and the operator points the
  config value at whichever one — or at their own script — without touching the
  shipped files. Default config selects the worktrunk example.
- `graph.ts` — `RepoGraph`: nodes (approved repo paths) + edges
  (`from -> to`, reason). Provides `readyNodes()` (topo frontier of independent
  nodes), `wouldCreateCycle(edge)`, `markProcessed`, serialization for memory,
  and a mermaid/text renderer for the report.

New workflow + step:

- `src/registry/workflows/investigate-ticket.ts` — the central workflow.
  `argsSchema: { ticketRef: z.string(), repoHint: z.string().optional() }`.
- `src/registry/workflows/steps/resolve-and-schedule.ts` — the DAG scheduler
  component (the body sketched above), reusable by other repo/ticket workflows.

Changed:

- `src/config.ts` — add `repoScopes: string[]`, `learnedReposPath: string`,
  `worktree: { command: string; cwdTemplate: string }`, `maxRepos: number`.
  Remove `repos` and `repoAliases`.
- `src/registry/types.ts` — remove `repoEnum`. `EntryFactory` no longer needs
  the alias list (or it is dropped entirely if nothing else uses it).
- `src/registry/index.ts` — drop `repoAliases(config)` wiring.
- `src/dispatcher/decide.ts` — remove `resolveCwd` (config.repos) and the `repo`
  branch of `schemaQuestion`. The dispatch decision no longer resolves a cwd;
  cwd is set per-agent inside the workflow after resolution.
- `src/registry/workflows/review-repo.ts` — retrofit to take a free-form
  `repoHint` and resolve via the same scope/ghq path (single-repo case of the
  scheduler). Secondary to `investigate-ticket`.

## Data: memory schema

```json
{
  "version": 1,
  "tickets": {
    "DEA-1234": {
      "nodes": ["/abs/ghq/github.com/acme/acme-engine",
                "/abs/ghq/github.com/acme/acme-app"],
      "edges": [
        { "from": "/abs/ghq/github.com/acme/acme-app",
          "to":   "/abs/ghq/github.com/acme/acme-engine",
          "reason": "app calls engine API" }
      ]
    }
  },
  "aliases": { "engine": "/abs/ghq/github.com/reedom/ai-workflow-engine" }
}
```

On re-reference, the known graph seeds the scheduler; every node still passes
`filterScope` each run (scopes may have tightened since).

**Edges vs parallelism.** Edges are kept even though independent repos run in
parallel — they are not redundant with it, they *define* it. Two repos run in
parallel precisely when there is no path between them; an edge is exactly the
ordering constraint that forbids parallelism. So independent repos are
represented by the *absence* of an edge, not by dropping edges from the schema.
Persisting edges also lets a re-run reproduce the dependency-ordered report and
schedule without re-discovering structure. (If a ticket's repos turn out fully
independent, `edges` is simply `[]`.)

## Config additions (example)

```json
{
  "repoScopes": ["github.com/acme/*", "github.com/reedom/*"],
  "learnedReposPath": "./learned-repos.json",
  "maxRepos": 10,
  "worktree": {
    "script": "scripts/worktree-provision.worktrunk.sh"
  }
}
```

`config.worktree.script` **selects** which script nagi runs — switching
mechanisms is a config edit, never a file edit. The repo ships a couple of
example scripts (worktrunk, plain git) under `scripts/`; point the config value
at one of them or at your own. The selected script is invoked with
`cwd = repoPath`, `argv[1] = ticket`, and `NAGI_TICKET` / `NAGI_REPO_PATH` in the
environment. It must create or switch to the worktree and print its absolute
path as the final stdout line. The worktrunk example:

```sh
#!/usr/bin/env bash
# scripts/worktree-provision.worktrunk.sh — example provisioner (worktrunk).
set -euo pipefail
ticket="${1:?ticket required}"
wt switch "$ticket" >&2          # worktrunk creates ../<repoBase>.<ticket>
# worktrunk's path = {{repo_path}}/../{{repo}}.{{branch|sanitize}}
base="$(basename "$PWD")"
printf '%s\n' "$(cd "$PWD/../${base}.${ticket}" && pwd)"
```

Swapping to plain git is just a different script
(`git worktree add ../<repoBase>.<ticket> -b <ticket>` then echo the path).

## Error handling & security

- **Scope is the boundary.** No repo is provisioned or handed to an agent
  without passing `filterScope`. The agent only ever sees a scope-pre-filtered
  candidate list, and its picks are re-filtered on return (R2).
- `ghq` / `wt` absence or non-zero exit -> guard-clause error, audited, run
  fails loudly (no silent fallback).
- **Cycle** -> halt + in-thread escalation with the offending edge/path; human
  re-invokes with guidance (R9).
- `maxRepos` exceeded -> halt + report partial graph (R10).
- memory writes contain only approved absolute paths and reasons; no secrets
  (consistent with D14).

## Testing

- `scope.filterScope` — globs, host/owner boundaries, rejection set (security).
- `RepoMemory` — round-trip, atomic write, missing file, schema version.
- `listScopedRepos` — `ghq` mocked; scope filtering; ghq-absent error.
- `RepoGraph` — `readyNodes` frontier, parallel-ready independence,
  `wouldCreateCycle` true/false, topo order, serialization.
- `ScriptProvisioner` — argv/env passed correctly; reads back last stdout line
  as cwd; non-zero exit -> guard error; script runner mocked.
- `resolve-and-schedule` — `wf.agent` mocked to drive: memory hit/miss,
  out-of-scope rejection, single repo, multi-repo fan-out (parallel batch),
  dynamic discovery across levels, cycle halt, maxRepos halt.

## Open items deferred (YAGNI)

- Parallelizing across SCCs is moot: cycles halt rather than group-investigate.
- `aliases` (non-ticket hint) reuse is included but minimal; richer fuzzy
  matching can come later.
- review-repo retrofit can land after `investigate-ticket` if scope creeps.
```

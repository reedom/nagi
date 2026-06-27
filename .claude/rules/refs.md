---
description: "Doc cross-reference graph: judgment calls the post-edit hook cannot make. Trigger-specific excerpts of this rule are auto-injected by .claude/hooks/refs-postedit.sh."
paths: **/*.md
---

# Cross-reference rule

The post-edit hook (`.claude/hooks/refs-postedit.sh`) auto-runs `validate` after every `.md` edit and `touched <file>` after every source edit under `src/`. When an edit matches one of the triggers below (new `.md`, source change, `kinds.md` edit), the hook also injects the matching excerpt of this rule into context.

For the schema and CLI behaviour of `kusara` itself, invoke the `kusara:refs-schema` and `kusara:kinds-manifest` skills.

**This rule covers only what the hook cannot decide.** Do not re-run `validate` or `touched` manually unless investigating a specific failure.

## Trigger: creating a new `.md`

Pick kind by matching the file path against `docs/kinds.md` `path_globs`:

| Situation | Action |
|---|---|
| Path matches an existing kind's `path_globs` | Add `refs:` of that kind. Mirror the closest sibling's frontmatter shape. |
| New instance of an existing kind, in a new location | Extend that kind's `path_globs` in `docs/kinds.md`, then add `refs:`. |
| New category of doc | Add a new kind entry to `docs/kinds.md` (name + `path_globs` + `id_pattern`; add `index.output` only if a generated index is wanted), then add `refs:`. |
| Deliberately outside graph (README / template / scratch / generated / archival snapshot under `docs/superpowers/**` or dated design docs) | No `refs:`. Tighten the kind's glob if validate now complains. |

Field reference: invoke the `kusara:refs-schema` skill. Don't guess fields.

## Trigger: source change under any `modules:` path

The hook prints docs of record via `touched`. Decide per change type:

| Change type | Doc update? |
|---|---|
| Internal: refactor, bugfix, perf, dependency bump | none |
| New / changed config key | `fr:10-configuration` |
| New / changed Slack event subscription, scope, or DM/mention handling | `fr:01-slack-front-door` |
| New / changed control command (`status` / `cancel` / `stop` / `done`) | `fr:07-control-commands` |
| New / changed triage shape, policy, or confidence handling | `fr:03-triage` |
| New / changed registry entry, arg schema, or seed workflow | `fr:04-workflow-registry` |
| New / changed escalation / approval (Block Kit, serialization, timeout) | `fr:08-escalation-approvals` |
| New / changed agentbus envelope, surfaced lane, or pending-run binding | `fr:12-agentbus-surfaced-lane` |
| New / changed resident lifecycle or in-thread routing | `fr:13-resident-agent` |
| New / removed end-to-end behaviour | the relevant `fr:NN-*` doc of record |

If unsure whether a change is "public surface", err on the side of updating the doc.

## Trigger: rename / delete of a doc

Every reference to the old ID elsewhere in the graph becomes dangling. Update the references; the hook surfaces leftovers on next edit.

## Trigger: editing the body of a graph-linked `.md`

The hook surfaces the doc's immediate `implements` / `depends_on` / `related` / `modules` plus reverse direct impact via `kusara show`.

Treat the surfaced list as a **content-drift checklist**: if this edit changed observable behaviour (not a typo or prose-only tweak), each linked doc may need a matching wording update so the two stay coherent. Skim the listed docs and update any whose body would otherwise drift from this file's new content. The validator cannot detect prose drift — only the human / agent reading the diff can.

Skip the sweep when the edit is a typo, formatting, or pure clarification with no behavioural change.

## Trigger: editing `docs/kinds.md`

| Edit type | Risk |
|---|---|
| Tightening a `path_globs` | safe |
| Loosening or adding new globs | every newly-matched file must have `refs:` (validator enforces) |
| Renaming a kind | invalidates every `kind: <old-name>` in existing front matter; audit + rewrite |
| Adding `index.output` | run `kusara index` once to materialize the file |

## What the hook handles (do NOT re-run unless debugging)

- `kusara validate` after every `.md` edit
- `kusara touched <file>` after every source / `kinds.md` edit
- All graph-integrity errors (dangling refs, dup IDs, unknown kinds, missing-frontmatter under a declared glob)

## Schema pointers

- Field-level reference: `kusara:refs-schema` skill
- Kind manifest: `docs/kinds.md` (and the `kusara:kinds-manifest` skill)
- Feature narratives: `docs/fr/` (per-feature docs of record)

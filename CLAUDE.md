# nagi

## Docs are graph-managed (kusara)

This repo uses [kusara](docs/kinds.md) to keep code and docs in sync via a cross-reference graph.

- **Docs of record** live in `docs/fr/` (per-feature narratives). Treat them as the source of truth for behaviour; archival/dated docs elsewhere under `docs/` are deliberately outside the graph.
- **Cross-reference rules** the post-edit hook cannot decide: `.claude/rules/refs.md`. Read it before authoring `refs:` metadata, renaming/deleting docs, or editing `docs/kinds.md`.
- **Automatic checks**: a PostToolUse hook (`.claude/hooks/refs-postedit.sh`) runs `kusara validate` / `touched` / `show` after every edit and injects the matching rule excerpt. Do not re-run `validate` or `touched` manually unless debugging a specific failure.
- **Schema reference**: invoke the `kusara:refs-schema` skill for `refs:` fields and the `kusara:kinds-manifest` skill for the kinds manifest. Don't guess fields.

When a source change under a `modules:` path alters observable behaviour, update the relevant `docs/fr/NN-*` doc of record (see the decision table in `.claude/rules/refs.md`).

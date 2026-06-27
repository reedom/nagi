---
refs:
  id: fr:03-triage
  kind: fr
  title: "LLM Triage"
  spec: nagi-v1
  depends_on:
    - fr:10-configuration
  related:
    - fr:04-workflow-registry
    - fr:05-request-dispatch
  modules:
    - src/triage/
---

# FR 03: LLM Triage

> Triage turns one free-form Slack message into a structured dispatch decision
> by making a single direct call to the `claude` adapter. It is NOT a registered
> workflow — `agent()` exists only inside workflow bodies — so it runs under its
> own explicit runtime policy (model, timeout, token cap) with escalation
> disabled, and returns `{workflowId, args, confidence, clarificationQuestion?}`.

## Purpose

Every authorized request must be mapped to exactly one registered workflow plus
its arguments before nagi can run anything. Triage performs that classification
with the LLM: given the user's text and a description of the live registry, it
picks the single best workflow id and extracts that workflow's args. Because the
underlying CLI adapter grants unrestricted Bash, triage runs only after the
authorization gate (see [02-authorization](02-authorization.md)) and is kept
deliberately small and schema-bounded.

Triage is intentionally a plain adapter call, not a workflow: the engine's
`agent()` helper is available only inside workflow bodies, and folding triage
into the registry would invite recursion and escalation it does not need. It
therefore carries its own runtime policy from config (Codex amendment "Triage
gets its own explicit runtime policy: model, timeout, token cap, escalation
disabled").

## User-visible Behavior

### Output shape

Triage must return JSON matching exactly this shape (`triageJsonSchema` /
`triageResultSchema` in `schema.ts`), handed to the adapter via its
`--json-schema` flag:

| Field | Type | Notes |
|---|---|---|
| `workflowId` | string (required) | Must be one of the listed registry ids. |
| `args` | object (required) | Extracted workflow args; defaults to `{}`. |
| `confidence` | number 0..1 (required) | Honest probability the dispatch is correct. |
| `clarificationQuestion` | string or null (optional) | One sentence describing what is missing when triage cannot decide. |

`additionalProperties` is `false`. The Zod schema (`triageResultSchema`) is kept
in lockstep with the JSON Schema and is what the raw model output is parsed
against after the call.

### Prompt assembly

The system prompt is built fresh on every call from the live registry, so a
newly registered workflow becomes triageable immediately (`buildTriagePrompt`
in `prompt.ts`). For each registry entry it emits the `id`, `description`, and a
compact, shallow rendering of the entry's Zod `argsSchema` produced by
`zodToReadable` (`describe.ts`) — e.g. `{ repo: one of [engine | web], focus:
string (optional) }`. It then lists the known repo aliases (the ONLY valid
values for a `repo` argument), falling back to `(none configured)` when none are
configured. See [04-workflow-registry](04-workflow-registry.md) for the entry
shape and [10-configuration](10-configuration.md) for the alias map.

The prompt's fixed rules instruct the model to: pick a `workflowId` from the
listed ids (or lower confidence and ask via `clarificationQuestion` if none
fits); extract args strictly from the listed shapes and never invent a repo
alias; report `confidence` honestly; and prefer a clarification over guessing
when the request is ambiguous. The user text is wrapped by
`buildTriageUserPrompt` as `User request:\n<text>`.

### `runTriage` flow

`runTriage(deps, text)` (`triage.ts`) takes `TriageDeps`
(`{ adapter, policy, registry, aliases, log }`) and:

1. Builds the system instructions and user prompt.
2. Assembles a spec `{ prompt, model: policy.model, schema: triageJsonSchema,
   instructions, tools: [] }` — note `tools` is empty (no tool access during
   triage).
3. Runs `adapter.run(spec)` wrapped in `withTimeout(..., policy.timeoutMs,
   'triage')`.
4. Compares output tokens to `policy.tokenCap`: an overrun is logged as a
   `warn` (`triage exceeded token cap`), not fatal — triage output is small and
   schema-bounded (advisory ceiling).
5. Throws `triage returned no structured output` when `result.data` is
   undefined.
6. Returns `triageResultSchema.parse(result.data)` — the raw model output is
   validated/parsed before it leaves triage.

### Policy

The policy comes from the `triage` config block (`TriageConfig` in `config.ts`,
defined in [10-configuration](10-configuration.md)):

| Key | Default | Role |
|---|---|---|
| `model` | `claude-sonnet-4-6` | Adapter model for the triage call. |
| `confidenceThreshold` | `0.6` | Below this, the consumer posts a clarification instead of dispatching. |
| `timeoutMs` | `60000` | Hard timeout enforced by `withTimeout`. |
| `tokenCap` | `2000` | Advisory output-token ceiling; an overrun is audited, not fatal. |

`runTriage` itself enforces only `model`, `timeoutMs`, and `tokenCap`. The
`confidenceThreshold` comparison and the decision to dispatch vs. clarify live
in the consumer `decide()` in [05-request-dispatch](05-request-dispatch.md).

## Capabilities

- Classifies a free-form request into one registered workflow id plus extracted
  args via a single, schema-constrained `claude` adapter call.
- Builds its prompt from the live registry on every call, so new workflows are
  triageable the moment they register.
- Constrains the `repo` argument to the configured alias set and instructs the
  model never to invent an alias.
- Emits an honest `confidence` and an optional one-sentence
  `clarificationQuestion` so the dispatcher can punt cleanly.
- Runs under an explicit policy: fixed model, hard timeout, advisory token cap,
  no tools, and no escalation.
- Validates raw model output against `triageResultSchema` before returning.

## Boundaries

- Triage does not decide dispatch vs. clarification: the
  `confidenceThreshold` check and `decide()` consumer live in
  [05-request-dispatch](05-request-dispatch.md).
- Not a registered workflow and carries no escalation field — no approvals, no
  `agent()`, no tool access (`tools: []`).
- Exceeding `tokenCap` is logged only; it never aborts or rejects the call.
- Triage does not validate args against the chosen entry's full Zod schema; that
  strict re-validation (and the "names the bad field" clarification, 4A) is the
  dispatcher's job in [04-workflow-registry](04-workflow-registry.md) /
  [05-request-dispatch](05-request-dispatch.md).
- The eval golden set is a test asset, not runtime: `test/fixtures/triage-cases.ts`
  holds one case per workflow plus clarification and unknown-repo triggers,
  checked for integrity by `pnpm test` and run live with `NAGI_EVAL_LIVE=1`. It
  is grown from real `audit.jsonl` misfires (cross-ref [09-audit-log](09-audit-log.md)).

## Traceability

- **Design**: `docs/tohru.hanai-main-design-20260611-235421.md` (archival) — the
  `triage/` component as a direct single adapter call returning
  `{workflowId, args, confidence, clarificationQuestion?}` (architecture sketch);
  the folded Codex amendment "Triage gets its own explicit runtime policy:
  model, timeout, token cap, escalation disabled"; the clarification path (4A)
  and triage eval suite (7A); README.md "Triage" / "Triage eval".
- **Modules**: `src/triage/` (`triage.ts` `runTriage`/`TriageDeps`,
  `schema.ts` `triageJsonSchema`/`triageResultSchema`/`TriageResult`,
  `prompt.ts` `buildTriagePrompt`/`buildTriageUserPrompt`, `describe.ts`
  `zodToReadable`).
- **Related FR**:
  - [10-configuration](10-configuration.md) — supplies the `triage` policy block
    (`model`, `confidenceThreshold`, `timeoutMs`, `tokenCap`) and the repo alias
    map. (depends_on)
  - [04-workflow-registry](04-workflow-registry.md) — provides the entries and
    `argsSchema` rendered into the prompt and re-validated downstream.
  - [05-request-dispatch](05-request-dispatch.md) — consumes the `TriageResult`,
    applies `confidenceThreshold` in `decide()`, and routes dispatch vs.
    clarification.

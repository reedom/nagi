# Manual smoke — Phase 2 surfaced lane

Verifies the end-to-end surfaced lane: a Slack request opens an interactive
`claude` on a cmux surface, and its progress / one tool-approval / result flow
back to the originating thread over agentbus. This is the one gate the automated
suite cannot cover (it needs live Slack + cmux + agentbus + claude).

## 0. Prerequisites (on the host running nagi)

- `agentbus` on `PATH` — `agentbus --version`. nagi `register`s itself as `nagi`
  (persistent) at startup; a missing binary fails startup fast.
- The **cmux app running**, with a reachable socket (see step 1).
- `claude` CLI installed (interactive — not `claude -p`).
- Both packages built on `main`: `pnpm -C agent-surface-adapters build && pnpm -C nagi build`.

## 1. cmux access — env vars are the default

cmux resolves its control socket and password on its own, in this precedence:

- **socket:** `CMUX_SOCKET_PATH` env → else the default `~/.local/state/cmux/cmux.sock`
  (with auto-discovery of tagged/uid sockets, e.g. `cmux-501.sock`).
- **password:** `--password` flag → `CMUX_SOCKET_PASSWORD` env → password saved in
  cmux Settings.

nagi's cmux host only passes `--socket`/`--password` when the `cmux` config block
provides them; **omit the block and cmux self-resolves.** So:

- **nagi started from a cmux-aware shell** (env inherited): no `cmux` block needed.
  Verify `echo $CMUX_SOCKET_PATH` is non-empty where nagi launches.
- **nagi under bare launchd** (`CMUX_*` are auto-set only inside cmux terminals, so a
  plain launchd job won't inherit them): put the vars in the plist —

  ```xml
  <key>EnvironmentVariables</key>
  <dict>
    <key>CMUX_SOCKET_PATH</key><string>/Users/&lt;you&gt;/.local/state/cmux/cmux-501.sock</string>
    <key>CMUX_SOCKET_PASSWORD</key><string>…</string>   <!-- only if not saved in Settings -->
  </dict>
  ```

  — or, equivalently, set the optional `cmux` block in `nagi.config.json`. Prefer the
  env vars to keep the password out of config (consistent with "tokens come from env,
  never config").

## 2. nagi config + secrets + launch

`nagi.config.json` (no `cmux` block in the common case):

```jsonc
{
  "slack": { "allowedTeamId": "T…", "allowedUserIds": ["U…"] },
  "repos": { "engine": "/abs/path/to/engine" },   // absolute paths only
  "auditLogPath": "./audit.jsonl"
}
```

```bash
export SLACK_BOT_TOKEN=xoxb-…
export SLACK_APP_TOKEN=xapp-…          # Socket Mode app-level token
pnpm -C nagi start                      # or: pnpm -C nagi dev   (NAGI_CONFIG defaults to ./nagi.config.json)
```

Watch stderr for config load, `register nagi` success, the inbox pump, and bot start.

## 3. Core round-trip (the headline criterion)

From an allowlisted user/team, DM or @-mention nagi with a request that triages to
`surface`, e.g. **"open a surface and run `pwd && cat README.md` in engine"**.

In the originating thread, confirm in order:

1. ack — `On it — running *surface* …`
2. a cmux surface opens running interactive `claude` (visible; you can watch/intervene)
3. progress posts (`:hourglass_flowing_sand: …`)
4. a tool needing approval → an **Approve/Deny** card → click **Approve** → the agent
   proceeds (the decision is sent back over agentbus)
5. the final result posts to the thread
6. the agent's **own** `agentbus send/reply` reporting did **not** raise an approval
   card (the hardened self-report gate)

## 4. Concurrency (no thread crossing)

While step 3 is still running, send a **second** surfaced request in a **different
thread**. Both surfaces run; progress / approvals / results stay in their own thread.
A normal headless request (e.g. `review engine`) still queues single-flight.

## 5. `stop` / `cancel` (surface-aware)

With a surfaced run active, send `stop` (or `cancel`/`abort`). Confirm the reply reads
`Cancelling: … and cancelled N surface run(s).`, the cmux surface **closes**, and the
thread shows the cancellation. (Closing the surface is what terminates the agent — it
is not in nagi's process tree.)

## 6. Two risks to watch

- **Risk #1 — daemon launch.** Repeat step 3 with nagi under **launchd** (not a
  terminal). If surfaces fail to open, the launchd environment is missing
  `CMUX_SOCKET_PATH`/`CMUX_SOCKET_PASSWORD` — add them (step 1).
- **Risk #3 — double-intercept.** cmux ships its own Claude wrapper
  (`CMUX_CLAUDE_WRAPPER_SHIM`). You should get **exactly one** Approve card per tool —
  from nagi. If a surfaced agent is double-prompted, disable cmux's Claude integration
  for these surfaces.

## Diagnostics

- nagi stderr: `[nagi:*]` lines, incl. `bridge handleEnvelope threw` and
  `agentbus inbox poll failed`.
- `agentbus ls`, `agentbus check-inbox nagi`.
- `audit.jsonl` outcomes: `dispatched` / `completed` / `cancelled` / `failed`.

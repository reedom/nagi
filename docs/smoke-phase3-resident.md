# Manual smoke — Phase 3 resident agent

Verifies the persistent-resident lifecycle on top of the Phase 2 surfaced lane: a
surface launched from Slack **stays alive** and bound to its thread, handles many
turns over time, and retires only on `done` (or a global `stop`). The automated
suite covers the routing/registry logic; this runbook covers the live behaviour it
cannot (real cmux REPL + per-turn Stop hook + claude).

Prereqs are identical to Phase 2 — see `docs/smoke-phase2-surfaced.md` §0–§2 (agentbus
on PATH, cmux app running with a reachable socket, interactive `claude`, both packages
built, nagi config + Slack tokens). Run Phase 2 §3 first to confirm the basic
round-trip before exercising residency.

## 1. Residency — many turns in one thread (the headline criterion)

1. From an allowlisted user, send a request that triages to `surface`, e.g.
   **"open a surface and run `pwd` in engine"**. Confirm the Phase 2 round-trip (ack →
   surface opens → result in thread), then confirm the new one-time hint:
   `:speech_balloon: Surface is live — reply here to keep talking; say` `done` `to close it.`
2. **Reply in the same thread** with a follow-up — e.g. **"now list the files"** — with
   **no** new trigger phrasing. Confirm:
   - nagi does **not** re-triage or post an `On it — running *surface* …` ack;
   - the text reaches the live REPL (you can watch it typed + submitted on the surface);
   - the next turn's result posts back to the **same thread**.

   This is the load-bearing assumption: the interactive Stop hook fires **once per turn**
   and re-uses the **stable runId**, so turn-2+ output routes via the resident registry.
3. Repeat step 2 a few times. Each reply should drive one more turn; results keep
   returning in-thread. `audit.jsonl` shows `resident-input` per follow-up and
   `resident-ready` for the launch turn.

## 2. Mid-turn input (sent immediately — watch for garbling)

While a turn is still producing its answer, send another in-thread reply. nagi pipes it
straight to the REPL (no busy-gating). Confirm claude absorbs the queued input cleanly
and does **not** garble/merge the two messages. (If interleaving proves messy in
practice, that is the signal to revisit the send-immediately decision.)

## 3. Turn-2 approval round-trip

On a **follow-up** turn (not the launch turn), trigger a tool that needs approval.
Confirm the Approve/Deny card appears in the **correct thread** and the decision flows
back over agentbus — i.e. approvals route via the resident binding, not just `PendingRuns`.

## 4. Two concurrent residents (no crossing)

Start a second resident in a **different thread** (another `surface` request). Hold
back-and-forth conversations in both threads. Confirm input and output never cross:
each thread drives only its own surface and receives only its own results.

## 5. Retire with `done`

In a resident thread, send **`done`** (or `close`). Confirm:
- the reply reads `:octagonal_sign: Resident closed.`;
- the cmux surface **closes**;
- a further message in that thread **triages fresh** (it is no longer resident — you get
  an `On it — running …` ack again, not a pipe into the dead surface).

Send `done` in a thread with no resident → `No resident agent in this thread.` (nothing closes).

## 6. Global `stop` closes residents

With one or more residents live, send **`stop`** (or `cancel`/`abort`). Confirm the reply
includes `… and closed N resident(s).`, and every resident surface **closes**. This is the
backstop for the "explicit `done` only, no idle reaping" lifecycle — an abandoned surface
is reclaimed by `stop` or a daemon restart.

## 7. Dead-surface recovery

Close a resident's cmux surface **externally** (outside nagi), then send a message in its
thread. nagi's REPL `send` fails; confirm it posts
`:ghost: Resident seems gone; closing. Send your message again to start fresh.` and drops
the binding, so the next message triages fresh.

## Diagnostics

- nagi stderr: `[surface:*]` / `[nagi:*]` lines; `close-surface failed` warnings.
- `audit.jsonl` outcomes: `resident-ready` (launch turn), `resident-input` (each follow-up),
  `control` (`done`), `cancelled` (`stop`), `failed` (dead surface).
- `agentbus check-inbox nagi` for stuck envelopes.
</content>

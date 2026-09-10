# Discord commands

Commands are matched by piscord before the message reaches the agent.
Matching is case-insensitive; every command needs a leading `/` except bare
`stop` (exact match, no args — `stop that` is chat, not a command).

Access: **anyone** = any member of the channel; **owner** = the configured
`ownerUserId`.

## Command reference

| command | access | what it does |
|---|---|---|
| `stop` / `/stop` | anyone | abort the in-flight run |
| *(any plain message)* | anyone | during a run: interrupts the current step after ~3s, then takes over |
| `/help` | anyone | list the commands |
| `/btw <question>` | anyone | quick side question, answered briefly without disturbing the main run |
| `/jobs` | anyone | list in-flight `pi-bg` dispatches (profile, age, task) |
| `/status` | owner | context-window usage, model, uptime |
| `/reset` | owner | abort the run and restart the pi session |
| `/verbose on\|off` | owner | toggle tool-call forwarding until restart (bare `/verbose` toggles) |
| `/compact [instructions]` | owner | compact the session context (optionally with custom instructions) |
| `/model [name]` | owner | switch model, or list models when run bare |
| `! <command>` | owner | shell passthrough: run `bash -c "<command>"` in the working directory |

## Examples

### stop / /stop

```
/stop
```

Aborts the current run immediately. The run's partial output stays in the
channel (steered steps are already forwarded live).

### mid-run interrupt (any plain message)

A plain message that arrives while a run is in flight does not wait for the
run to finish. After a short grace period (default **3000 ms**, override with
`PISCORD_INTERRUPT_STEP_TIMEOUT_MS` when starting the bridge) the message is
force-delivered: the in-flight step (the current LLM stream / tool call) is
aborted, and once the session settles (~tens of ms) the message starts a
fresh run. The agent continues with your message as its next step — a
redirect, not a full stop.

```
fix the build
> (10s later, still running) actually fix the tests instead
```

The second message interrupts the in-flight step after ~3s and the agent picks
it up. This is for **plain** messages only — commands (`/stop`, `/btw`, …) keep
their existing behavior. `/status` shows an armed interrupt (`interrupt in 3s`)
and an in-flight one (`interrupting`).

If the step finishes before the grace period, the message is delivered normally
as a fresh run instead (the existing mid-turn re-wake). Nothing is ever queued
twice: an interrupted message is removed from the re-wake queue before it is
sent, so it is delivered exactly once. If the session does not settle within
120 s of the abort (a stuck retry or compaction), the message goes back to the
re-wake queue and is delivered when the run ends — still exactly once.
`/stop`, `/reset` and `/restart` during the settle window drop the pending
send, consistent with those commands dropping queued messages.

### /btw

```
/btw what's the exit code convention in pi-wait?
```

Side question answered briefly while the main run continues. A trailing
`. btw` on a normal message does the same:

```
what's the webhook TTL? . btw
```

### /status

```
/status
```

Owner only. Reports context-window usage, active model, and uptime.

### /reset

```
/reset
```

Owner only. Aborts the in-flight run and restarts the pi session fresh (new
context).

### /verbose

```
/verbose on      # show tool calls in forwarded responses
/verbose off     # hide them
/verbose         # toggle
```

Owner only. Takes effect until the next pi restart.

### /compact

```
/compact
/compact keep only the decisions, drop the diffs
```

Owner only. Compacts the session context; with instructions, those become the
compaction instructions. Completion shows up as a `session_compact` event, not
an immediate reply.

### /model

```
/model           # list available models
/model qwen3.8   # switch model
```

Owner only. `/model` is async — the reply confirms after the switch completes.

### /jobs

```
/jobs
```

Lists in-flight `pi-bg` dispatches by reading the process table (the `pi-bg`
wrapper process exists only while a run is live):

```
2 jobs in flight:
- worker · 04:12 · bulk refactor of channel/
- reviewer · 01:30 · adversarial review of PR #12
```

### ! shell passthrough

```
! ls -la
! grep -c expect *.test.ts
```

Runs `bash -c "<command>"` in the agent's working directory. Owner only. 60s
cap (SIGKILL); output is capped at 20k chars and displayed up to 4000 chars
with a `… (truncated)` marker. Messages that don't start with `!` fall through
as normal chat.

> ⚠️ `!` executes arbitrary shell on the agent box. In a private, trusted
> channel this is a feature; it is not a sandbox.

### /help

```
/help
```

Lists the command set (the canonical list lives in
`packages/bridge/channel/index.ts`).

## Non-command behavior worth knowing

- **Bare `stop`** is the only slash-free command, and it must be the entire
  message.
- **Other bots' messages are skipped** on inbound (agent-say traffic does not
  burn a run; no echo loops).
- **pi-bg webhooks are exempt** — the dispatch callback posts to the channel
  without triggering the bot.
- **Mid-run messages are debounced** (2.5s quiet window) and delivered as one
  steer at the next step boundary.

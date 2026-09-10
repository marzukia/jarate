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
| `/help` | anyone | list the commands |
| `/btw <question>` | anyone | quick side question, answered briefly without disturbing the main run |
| `/jobs` | anyone | list in-flight `pi-bg` dispatches (profile, age, task) |
| `/status` | owner | context-window usage, model, uptime |
| `/reset` | owner | abort the run and restart the pi session |
| `/verbose on\|off` | owner | toggle tool-call forwarding until restart (bare `/verbose` toggles) |
| `/compact [instructions]` | owner | compact the session context (optionally with custom instructions) |
| `/model [name]` | owner | switch model, or list models when run bare |
| `/sleep [list \| cancel <id>]` | owner | list or cancel pending session wakes |
| `! <command>` | owner | shell passthrough: run `bash -c "<command>"` in the working directory |

## Examples

### stop / /stop

```
/stop
```

Aborts the current run immediately. The run's partial output stays in the
channel (steered steps are already forwarded live).

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

### /sleep

```
/sleep               # list pending wakes (same as /sleep list)
/sleep list
/sleep cancel <id>   # cancel one
```

Owner only. Lists the agent's pending session wakes (id, channel, wake time,
relative countdown, note) or cancels one by id. The wakes are created by the
`sleep` LLM tool, not by a command.

The `sleep` tool (agent-facing): `sleep(minutes=30, note="...")` or
`sleep(until="2026-09-10T15:00:00Z")` records a wake in
`~/.pi/agent/sleep/wakes.json` and the agent ends its run. The wake is
delivered as a new message in the SAME session when the time comes — via a
30s poller while the bridge is alive, or at `session_start` after a restart
or reboot (due wakes are caught up; stale delivery claims > 10 min old are
re-delivered, so a wake is lost only if the channel is disabled, not if the
process dies).

### /help

```
/help
```

Lists the command set (the canonical list lives in
`piscord/channel/index.ts`).

## Non-command behavior worth knowing

- **Bare `stop`** is the only slash-free command, and it must be the entire
  message.
- **Other bots' messages are skipped** on inbound (agent-say traffic does not
  burn a run; no echo loops).
- **pi-bg webhooks are exempt** — the dispatch callback posts to the channel
  without triggering the bot.
- **Mid-run messages are debounced** (2.5s quiet window) and delivered as one
  steer at the next step boundary.

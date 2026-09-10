# Discord commands

Commands are matched by piscord before the message reaches the agent.
Matching is case-insensitive; every command needs a leading `/` except bare
`stop` (exact match, no args — `stop that` is chat, not a command).

Access: **anyone** = any member of the channel; **owner** = the configured
`ownerUserId`.

## Output tags

Every command / system output the user sees starts with ONE ASCII tag
(kimaki style, no emoji). Bracketed state tags: `[ok]` applied / success,
`[!]` error / rejected / usage, `[..]` in progress, `[new]` new session,
`[queued]` in line, `[-]` stopped / none. Read-only list commands carry a
bracketed content tag (`[status]`, `[usage]`, `[jobs]`, `[wake]`, `[todos]`, `[model]`).
Live run state uses the box-drawing family (`┣ working…`, `┗ done · N calls`),
the todo board its glyph family (`⬦` pending, `⬥` in progress, `✓` done,
`✕` cancelled, `▤` board header) — both families are exempt from the bracket
scheme. Webhook callback embeds are structured and untagged.

| command / output | tag |
|---|---|
| `/stop` | `[-] stopped` |
| `/status` | `[status] …` (error: `[!] status unavailable`) |
| `/usage [all\|session]` | `[usage] …` (error: `[!] usage: …`) |
| `/reset` | `[new] …` |
| `/restart` | `[..] …` |
| `/undo` / `/redo` | `[ok] …` / `[!] …` |
| `/verbose on\|off` | `[ok] …` |
| `/compact` | `[queued] …` / `[..] …` / `[ok] …` / `[!] …` |
| `/model [name]` | `[model] …` (switch: `[ok] …` / `[!] …`) |
| `/jobs` | `[jobs] …` |
| `/todos` | board as-is (`▤` header); empty: `[todos] no open todos` |
| `/sleep list` | `[wake] …` |
| `/sleep cancel` | `[ok] …` / `[!] …` |
| `/btw` usage, other usage errors | `[!] usage: …` |
| owner-only rejection | `[!] owner only` |
| queue ack | `[queued] N in line` |
| run failure post | `[!] …` |
| repetition loop | `[!] …` |
| `!` shell (non-owner) | `[!] …` |

New commands follow the same scheme: one tag, bracketed, lowercase, no emoji.

## Command reference

| command | access | what it does |
|---|---|---|
| `stop` / `/stop` | anyone | abort the in-flight run |
| *(any plain message)* | anyone | during a run: interrupts the current step after ~3s, then takes over |
| `*. queue` (trailing suffix) | anyone | park the message for the re-wake queue: no interrupt, delivered when the run ends |
| *edit a queued message* | owner | the queued entry is re-rendered from the edited text |
| *delete a queued message* | owner | the queued entry (and its interrupt) is dropped |
| `/help` | anyone | list the commands |
| `/btw <question>` | anyone | quick side question, answered briefly without disturbing the main run |
| `/jobs` | anyone | list in-flight `pi-bg` dispatches (profile, age, task) |
| `/status` | owner | context-window usage, model, uptime |
| `/usage [all\|session]` | anyone | token usage: current session (default) or lifetime across all session files |
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

### queue control (`. queue`, edit, delete)

Every message that gets queued while a run is in flight gets a reply ack:

```
[queued] 1 in line
```

The number is the position in that channel's re-wake queue (several messages
may queue behind one run). The `[queued]` line replaces the 👀 ack reaction
for queued messages.

**Edit:** if the owner edits a message that is in the queue, the queued entry
is re-rendered from the edited text. The interrupt (if armed) and the re-wake
both deliver the new text; attachments in the edit are picked up too.

**Delete:** if the owner deletes a queued message, the entry is dropped from
the re-wake queue, its pending interrupt is disarmed, and its `[queued]` ack
is deleted. The remaining line is renumbered.

**`. queue` suffix:** a plain message ending in `. queue` is parked in the
re-wake queue **without** arming the mid-run interrupt — it is delivered as a
fresh run when the current run ends, instead of aborting the in-flight step.

```
run the benchmark suite . queue
```

The suffix is stripped before delivery, so the agent receives `run the
benchmark suite`. The message still gets its `[queued] N in line` ack. This is
the tool for "do this next, but don't interrupt what you're doing".

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

### /usage

```
/usage             # current session (same as /usage session)
/usage session     # current session
/usage all         # lifetime, every session file in the agent home
```

Reads pi's session store (`~/.pi/agent/sessions/*/*.jsonl`), sums assistant
`usage` per entry (de-duplicated by entry id; streaming `message_update`
deltas, missing and zero-usage entries skipped; a torn last line tolerated),
and prices it at the OpenRouter list rates in
`/home/monky/scripts/pi-token-cost.py` (prompt 0.42/1M, completion 3.00/1M,
cacheRead 0.085/1M). One compact line, no emoji:

```
[usage] session   2026-09-10        | 341 turns | in 8.2M | out 61K | cacheRead 0 | est $4.13
[usage] lifetime  2026-08-01..now   | 9,296 turns | in 627.6M | out 6.4M | est $284.39
```

`cacheRead` is shown on the session line as-is (0 on our vLLM); the lifetime
line shows it only when nonzero.

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

While pi is compacting, messages sent to the channel are queued
(`[queued] N in line`) instead of starting a run, so they cannot interrupt or
kill the compaction; they drain in order when the compaction settles. While
ANY channel is compacting, queued messages from every channel wait without
arming the mid-run interrupt (compaction is session-wide; an interrupt
aborts it). Commands behave the same: `/status`, `/jobs`, `/sleep` stay
read-only, `/stop` clears the window and stops (owner only; a non-owner
`/stop` mid-compaction gets an immediate `[!] owner only` instead of being
queued), `/compact` answers `[!] already compacting`, everything else is
queued. If no completion event arrives, the
window clears itself after 10 minutes (logged with a warning).

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
[jobs] 2 jobs in flight:
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

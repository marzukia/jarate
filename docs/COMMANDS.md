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
bracketed content tag (`[status]`, `[usage]`, `[jobs]`, `[wake]`, `[todos]`, `[model]`, `[tasks]`).
Live run state uses the box-drawing frame family (`┣` working, `┌ done` /
`┤ failed` frame with `└` close), the todo board its state glyphs (`├`
pending, `┣` in progress, `├` done (strikethrough, pipe stays connected),
`┤` cancelled, `┌` board header, `└`
close) - both families are exempt from the bracket scheme and must stay
<= 40 cols per line (mobile budget). Webhook callback embeds are framed
and untagged.

| command / output | tag |
|---|---|
| `/stop` | `[-] stopped` |
| `/hold [on|off]` | `[ok] hold on - …` / `[ok] hold off` |
| `/status` | `[status] …` (error: `[!] status unavailable`) |
| `/usage [all\|session]` | `[usage] …` (error: `[!] usage: …`) |
| `/reset` | `[new] …` |
| `/restart` | `[..] …` |
| `/undo` / `/redo` | `[ok] …` / `[!] …` |
| `/verbose [0\|1\|2\|on\|off]` | `[ok] verbose: 1 (essential)` |
| `/hold [on|off]` | `[ok] hold on - buffered until /hold off` |
| `/compact` | `[queued] …` / `[..] …` / `[ok] …` / `[!] …` |
| `/model [name]` | `[model] …` (switch: `[ok] …` / `[!] …`) |
| `/jobs` | `[jobs] …` |
| `/diff [git-range \| file]` | `[ok] …` (errors: `[!] …`) |
| `/todos` | board as-is (`┌` header, `└` close); empty: `[todos] no open todos` |
| `/sleep list` | `[wake] …` |
| `/sleep cancel` | `[ok] …` / `[!] …` |
| `/tasks list` | `[tasks] …` |
| `/tasks cancel` | `[ok] …` / `[!] …` |
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
| `/jobs` | anyone | list `pi-bg` dispatches: in-flight + recent history (`json` for JSON) |
| `/diff [git-range \| file]` | anyone | publish a diff to a shareable self-hosted viewer URL (default: working tree) |
| `/status` | owner | context, model, uptime, run state, verbose level, hold, queue depth, interrupt |
| `/usage [all\|session]` | anyone | token usage: current session (default) or lifetime across all session files |
| `/reset` | owner | abort the run and restart the pi session |
| `/hold [on\|off]` | owner | buffer plain messages in the re-wake queue until released (bare toggles) |
| `/verbose on\|off` | owner | toggle tool-call forwarding until restart (bare `/verbose` toggles) |
| `/compact [instructions]` | owner | compact the session context (optionally with custom instructions) |
| `/model [name]` | owner | switch model, or list models when run bare |
| `/sleep [list \| cancel <id>]` | owner | list or cancel pending session wakes |
| `/tasks [list \| cancel <id>]` | owner | list or cancel scheduled prompt tasks (one-shot / cron) |
| `! <command>` | owner | shell passthrough: run `bash -c "<command>"` in the working directory |

## Examples

### stop / /stop

```
/stop
```

Aborts the current run immediately. The run's partial output stays in the
channel (steered steps are already forwarded live).

> **Held channels** (#39): when the channel is held, the re-wake queue is the
> operator's buffer, and `/stop` does NOT clear it. The ack reports it:
> `[-] stopped - 3 held in line`. The buffer drains on `/hold off` (or the
> entries are deleted one by one).

### /hold

```
/hold on        # buffer: no plain message starts a run until released
/hold off       # release: the buffer drains, oldest first
/hold           # toggle
```

Owner only. Channel-wide queue mode (#39). While held, **every** plain
message is parked in the re-wake queue — even while idle — each one acked
`[queued] N in line`, none of them starting a run and none arming the
mid-run interrupt. Commands (`/stop`, `/verbose`, …) still work normally.

`/hold off` drains the buffer in order: if the channel is idle the oldest
entry runs immediately and the re-wake loop chains the rest, one run each;
while a run is in flight the buffer drains at the next run end.

The hold flag persists across restarts (bridge per-channel state file,
same store as the Discord cursor and the `/verbose` level). `/status`
reports it while on (`hold on`).

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

Owner only. One line: context-window usage, active model, uptime, run
state (idle/running/compacting/op label), the verbosity level (`quiet`
= 0, `verbose 1`, `verbose 2`, see `/verbose`), `hold on` while the
channel is held (see `/hold`), `queue N` for the depth of mid-turn
inbounds waiting on the run, and interrupt state (`interrupting` or
`interrupt in Ns`).

```
[status] ctx 41% · model qwen3.8-27b · up 3h12m · running · verbose 1 · queue 2
```

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
/verbose           # show the current level (no change)
/verbose 1         # text + essential tools (default: edits, side-effect bash, MCP)
/verbose 2         # all tool calls
/verbose 0         # text only (no tool calls)
/verbose on        # legacy: same as /verbose 2
/verbose off       # legacy: same as /verbose 0
```

Owner only. Three levels (kimaki parity):

| level | shown |
| --- | --- |
| `0` text | text responses only; no tool calls |
| `1` essential | text + essential tools: edits/writes, side-effect bash, MCP/custom tools. Hidden: `read`, `list`, `glob`, `grep`, `todoread`, `skill`, `question`, `webfetch`, read-only bash |
| `2` all | every tool call |

Takes effect immediately, including a run in flight (the live block and
the done frame re-filter on the next tool call), and **persists across
restarts** in the bridge's per-channel state file (the same
`channel-state.json` store as the Discord cursor and the `/hold` flag).
The level-1 bash classifier is conservative: any redirect, unknown
command head, or non-read-only `git` subcommand counts as a side effect
and is shown. A run whose calls are all non-essential at level 1 closes
with no done frame (the block is deleted, like a 0-call run).

Without a `/verbose` override the channel falls back to its settings
`forwardToolCalls` (`true` = level 2, unset = level 0).

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
/jobs           # text: in-flight + last 5 completed
/jobs json      # machine-readable: {inflight, history(10)}
```

In-flight via the process table (the `pi-bg` wrapper process exists only
while a run is live); recent history from the `/tmp/pi-bg-<ticket>-*`
artifacts each run leaves (state: `done` / `webhook-failed` / `killed` /
`lost`, plus the success-path webhook HTTP code when recorded):

```
[jobs] 1 job in flight:
- worker · 04:12 · bulk refactor of channel/

recent (newest first):
- 20260910-135501-48211 done · webhook 200 · 12m ago
- 20260910-131200-77319 webhook-failed · webhook 502 · 54m ago
```

Companion bins (installed like `pi-bg`): `pi-bg-tail <id> [lines] [-f]`
reads a run's live output; `pi-bg-kill <id> [--dry-run]` cancels a run via
its cgroup and posts a `KILLED` webhook event.

### /diff

```
/diff                    # working tree diff (git diff HEAD)
/diff main..HEAD          # git diff <range|rev>
/diff path/to/patch.diff  # publish a local diff/patch file
/diff ```diff ... ```     # publish a pasted diff (first fenced block)
```

Renders the diff into a self-contained dark mobile HTML page (syntax
highlighted, no CDN, no external requests) and publishes it to the
self-hosted webdrop shelf; the object key is a random 24-hex guid (96
bits), so the URL is unguessable and is the access control. A 7-day TTL is
stored on the drop; webdrop's purge job is phase 3, so the page stays
fetchable until it is deleted. No third-party service sees the code
(issue #7: critique.work rejected as code exfil). Input cap: 2 MB.
`[!] diff too large (… MB, max 2 MB)` beyond that.

```
[ok] working tree · 2 files +12 -3 · ttl 7d
https://drop.example.com/<id>.html
```

Agent-side CLI (same pipeline): `bun bin/jarate-diff [file|range|-]` from
the repo root — stdin `-` for a diff piped in.

`/diff` needs webdrop credentials: `WEBDROP_SERVER` + `WEBDROP_TOKEN` env,
or `~/.config/webdrop/config.toml` (the same file the `webdrop` CLI reads).
Missing config answers `[!] webdrop not configured (…)`.

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

### /tasks

```
/tasks               # list scheduled tasks (same as /tasks list)
/tasks list
/tasks cancel <id>   # cancel one
```

Owner only. Lists the agent's scheduled prompt tasks — one-shot reminders
(`minutes` or `at`) and recurring cron prompts — as id, channel, schedule,
next fire, countdown and prompt excerpt, or cancels one by id. Tasks are
created by the `task` LLM tool, not by a command.

The `task` tool (agent-facing): `task(prompt="check the build", minutes=120)`
or `task(prompt="...", at="2026-09-10T15:00:00Z")` or
`task(prompt="run the fleet check", cron="0 6 * * *",
tz="Australia/Melbourne")` records a task in `~/.pi/agent/tasks/tasks.json`.
At fire time the prompt is injected as a channel-inbound message into the
SAME session — via a 30s poller while the bridge is alive, or at
`session_start` after a restart or reboot (due tasks are caught up; missed
cron slots are skipped, not replayed; stale delivery claims > 10 min old are
re-delivered, so a fire is lost only if the channel is disabled, not if the
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
- **Mid-run messages are queued, not debounced.** One message = one run: a
  message that lands while a run is in flight waits in the re-wake queue
  (acked `[queued] N in line`); it is delivered as a fresh run when the
  current run ends. Each queued plain message also arms a mid-run interrupt:
  if the current step is still in flight after the 3000 ms grace (env
  `PISCORD_INTERRUPT_STEP_TIMEOUT_MS`), the step is aborted and the message
  takes over as a fresh run. A `. queue` suffix opts out of the interrupt;
  the message waits its turn. See "mid-run interrupt" and "queue control"
  above.

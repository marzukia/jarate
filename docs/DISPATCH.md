# Dispatch (orchestration pattern)

The main agent (monky) is the **orchestrator**. It keeps its own context (KV)
lean by handing self-contained work to `worker` agents and verification to
`reviewer` agents. Everything returns through the Discord webhook bus.

Components (all in this repo):

- `dispatch/pi-bg` — dispatch a one-shot pi run on a role profile
- `dispatch/pi-wait` — in-turn wait for the callback / a human message
- `dispatch/pi-bg-tail` — read a run's live output (`pi-bg-tail <id> [lines] [-f]`)
- `dispatch/pi-bg-kill` — cancel a run via its cgroup (`pi-bg-kill <id> [--dry-run]`)
- `bin/agent-say` — agent-to-agent messaging (post to a peer's channel)

## Roles

| profile | ctx | thinking | job |
|---|---|---|---|
| `worker` | 131k | medium | do the task, verify, short output |
| `reviewer` | 131k | xhigh | adversarial review, ranked findings, `VERDICT: PASS\|FAIL` |

Profiles are separate pi homes: `~/.pi/agent-worker`, `~/.pi/agent-reviewer`
(env `PI_CODING_AGENT_DIR`, set by `pi-bg` automatically).

**Fresh machine** (issues #29/#30): `pi-bg` runs a profile doctor before
every dispatch. A missing or empty role profile is auto-seeded from the
main agent's `~/.pi/agent/{auth,models}.json` + the repo template
`dispatch/profiles/<role>.json` (thinking level, ctx budget; provider/model
inherited from the main agent's `settings.json`). If no provider creds
resolve, `pi-bg` exits 4 with the files to copy — a missing credential is
not misfiled as the empty-completion quirk. Each dispatch also writes a run
record to `~/.pi-dispatch/runs/pi-bg-<id>.json` with `delivery:
"webhook"|"none"`; when no webhook is configured (`$PI_DISPATCH_WEBHOOK`
or `~/.config/pi-dispatch/webhook`), `pi-bg` warns at dispatch:
`no completion callback; poll with pi-wait`. Override the record dir with
`$PI_DISPATCH_RECORD_DIR`.

## Fleet caps (vLLM queue protection)

All agents share one vLLM endpoint (8 concurrent sequences max). Concurrent
pi-bg dispatches = concurrent generation streams = queue depth.

- **monky: max 3** concurrent dispatches (workers + reviewers combined)
- **frank: max 3**

Andryo, 2026-09-10. (A temporary monky cap of 2 followed a queue scare that
turned out to be a 524K-ctx session starving the prefix cache, not worker
count - restored to 3 the same day. Keep fleet sessions compacted well under
~300K: big resident contexts evict prefix blocks for everyone.) Count live
before dispatching:

```bash
ps aux | grep "pi-bg worker\|pi-bg reviewer" | grep -v grep | wc -l
```

Enforced in code since 2026-09-13 (issue #41): `pi-bg` counts this user's
live `pi-bg worker|reviewer` processes before exec'ing the agent and
refuses at the cap with
`[!] at cap (N/M), try again later or pi-bg-kill a ticket` + exit 5.
`PI_BG_MAX_CONCURRENT` sets the cap (default 3; 0 = unlimited, operator
escape hatch). The ps count above stays the manual cross-check.

Per-box override (RCA #57 fix 2, 2026-09-14): when `PI_BG_MAX_CONCURRENT`
is unset, `pi-bg` reads `~/.config/pi-dispatch/max-concurrent` (one integer,
created per box) before falling back to the fleet default of 3. monky's box
pins `2` — the fleet shares one vLLM endpoint and 3 concurrent dispatches
starved the model stream (issue #57). The env var still wins for per-dispatch
overrides, so `PI_BG_MAX_CONCURRENT=0` remains the unlimited escape hatch.

## The flow (default: fire-and-forget)

Dispatch, confirm, end the turn. The callback wakes the orchestrator as a new
turn — no polling, no held turn.

```bash
# 1. dispatch (background; posts a webhook callback on exit)
cd /path/to/workdir
nohup ~/scripts/pi-bg worker "task" > stdout.log 2>&1 & sleep 4; head -1 stdout.log

# 2. reply to the human: "dispatched, I'll report when it lands" — end turn
```

When the callback message arrives (it is a wake — a fresh turn), act on it:
read `stdout.log` / the worktree for detail, report to the human.

**In-turn wait** (opt-in, only when the answer must land in THIS turn and the
task is short, <~240s):

```bash
# 1. baseline: last message id in the channel
BASE=$(curl -s ".../channels/$CH/messages?limit=1" -H "Authorization: Bot $TOKEN" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')

# 2. dispatch
nohup ~/scripts/pi-bg worker "task" > stdout.log 2>&1 & sleep 4; head -1 stdout.log

# 3. wait in-turn (quiet poll, 5s interval)
~/scripts/pi-wait --since "$BASE" --timeout 240
#    exit 0 → callback content printed → act on it
#    exit 2 → a human spoke → drop the wait, answer the human first
#    exit 3 → timeout → report "still running", re-wait or drop to wake mode
```

Double delivery by design: the callback also posts to the channel; the wake
copy gets a one-liner ack, no re-work.

## pi-bg internals

```
pi-bg [worker|reviewer] [--worktree <ref>] [--project <tag>] [pi flags...] "task"
```

- Task = last positional argument. Pass-through `pi` flags allowed (the task
  is always the final arg).
- Non-interactive: runs `pi -p --no-extensions`.
- Empty completion (local-model quirk) → up to 3 attempts, 3s apart.
- **SILENT death (issue #57):** exit 1, no output, and the death came <15 min
  after the last activity (pi's LLM HTTP idle watchdog killed the run
  mid-API-call under shared vLLM load) → the SAME ticket is relaunched ONCE.
  A `<ticket>.retry1` marker is written before the relaunch so a second
  silent death reports a normal `FAIL` (no third launch); the retry is
  logged in the run record. A loud exit 1 (output present) is NOT the
  #57 signature and fails immediately with no retry.
- Exit code = pi's exit code.

### Cgroup escape (automatic, persistent)

An orchestrator restart must not kill in-flight dispatches. systemd kills a
unit's whole cgroup subtree on `stop`; a sibling cgroup under the user slice
survives. `pi-bg` therefore moves **this process** (and all children, including
the later webhook post) into:

```
/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/pi-bg/<run_id>
```

- cgroup v2 delegation available → escape active, cgroup removed on exit (trap).
- `mkdir`/`cgroup.procs` write fails → fallback: run in the caller cgroup
  (escape unavailable, printed to stdout).
- Practical effect: `systemctl --user restart pi.service` is safe while jobs
  are in flight.

### Session isolation (issue #56, 2026-09-14)

A dispatch launched from INSIDE another ticket (nested dispatch) can die when
the launcher's tool call blocks: without session isolation the ticket's pi
child sat in the LAUNCHER's process group, and a harness bash-tool timeout
signals that group (`kill -TERM/-KILL -pgid`). The 2026-09-13 incident: nested
tickets died rc=143 inside `git worktree add`.

`pi-bg` now re-execs itself once under `setsid` (guarded by `$PI_BG_SETSID`):
the wrapper becomes session + process-group leader and the pi child inherits
both, so no signal aimed at the launcher's PGID can reach the ticket. The
cgroup escape above isolates the cgroup axis; setsid isolates the PGID axis.

- **Blessed launch form** (stays; now safe even if the tool call blocks in
  `wait4()` on the ticket until the harness timeout):
  `cd <workdir> && nohup ~/scripts/pi-bg worker "task" > log 2>&1 & sleep 4; head -1 log`
- **Belt**: `pi-bg` prints the ticket id line BEFORE the slow
  `git worktree add` / cgroup escape, so `head -1 log` returns immediately
  and a dead ticket leaves an identifiable first log line.
- **Kill compensation**: `pi-bg-kill` signals the ticket's process group in
  addition to the per-pid cgroup walk, so the whole session dies together and
  no pi child orphans.
- `pi-bg --help` prints the header with this guidance.

### Worktrees (isolated runs)

`pi-bg worker --worktree <ref> "task"` runs the agent in a fresh git worktree
instead of the live checkout — use it when the task edits files and you don't
want it touching the working tree (or when two workers share a repo).

- Worktree: `$PI_BG_WT_DIR/<repo>/<id>` (default `~/.pi-bg-wt/<repo>/<id>`),
  branch `pi-bg/<id>`, created from `<ref>`. Bare `--worktree` = ref `HEAD`
  (the ref is only consumed when more args follow the flag; otherwise the next
  arg is the task).
- Per-run switchboard session id `pi-<user>-<profile>-<id>` (env
  `PI_SESSION_ID`) — each dispatch is its own ledger session.
- The worktree is **kept** after the run. Callback + stdout carry
  `worktree=<path> branch=<branch>`. Inspect with `git -C <path> diff`, then
  commit/merge, and `git worktree remove <path>` when done.
- Not a git repo → exit 3 before the agent starts.

### Project tags (invoice itemisation, 2026-09-18)

`--project <tag>` tags a run for cost rollups. Tag rule:
`[a-z0-9][a-z0-9-]{0,31}`, one per run. Invalid tag, missing value, or a
duplicate `--project` is a usage error (rc 2, one stderr line, no side
effects — the flag is consumed in the fork-free arg-parse zone before the
cap check, so a bad tag never touches the run record or the worktree).
Untagged runs get `"project": null` in the record.

On exit (terminal state or normal completion, before the callback build),
`pi-bg` attributes the run's cost to the record:

- **Tokens:** sum of assistant `usage` blocks in the run's session file
  (the profile's sessions dir, files newer than run start). `total` =
  input + output + cacheRead (cacheWrite excluded — pi-token-cost
  convention).
- **Pricing:** OpenRouter model list (`/api/v1/models`, `PI_BG_PRICING_URL`
  overrides the URL, `PI_BG_PRICING_TIMEOUT` the curl bound, default 10s),
  model `qwen/qwen3.8-27b` (exact, then the pi-token-cost.py fuzzy plain
  fallback). A 24h price cache in
  `$PI_BG_TMPDIR/pi-bg-price-cache.json` (tmpdir ROOT, shared across runs)
  is reused while fresh, so only the first run in 24h pays the fetch.
- **Cost:** input*prompt + output*completion + cacheRead*(cache_read or
  prompt) + cacheWrite*(cache_write or prompt), rounded to 5 dp. Missing
  cache rates bill at the prompt rate.
- **Record fields:** `tokens {input, output, cacheRead, cacheWrite, total}`
  and `cost_usd` + `model` + `price_ts` on success; on any pricing failure
  `cost_usd` stays `null` and `price_error` records why: `offline`
  (`JARATE_TOKEN_COST_PRICING_OFFLINE=1`), `fetch failed`, `parse failed`,
  or `model not found`. No session file at all -> `tokens` null too.
- **Never blocks the callback:** bounded curl + python timeout, every
  failure tolerated. The callback always posts; the cost line degrades.

Callback embed: when a tag is set, the frame gains ONE line —
`│ pj <tag> · $<cost, 2dp>` (or `$-` when cost is null) — appended LAST,
right before the `└` close, on purpose: the ~1.8k callback truncation eats
the tail, never the identity header. The line is clipped to the 40-col
frame budget.

Rollup: `jarate projects` aggregates records by tag across agents (see
JARATE.md).

### Callback protocol

On completion, `pi-bg` posts to the Discord webhook:

- Webhook URL: `$PI_DISPATCH_WEBHOOK` or first line of
  `~/.config/pi-dispatch/webhook`. File absent = no callback (stdout is always
  printed).
- **Embed callback (default):** a single embed with author
  `pi-bg ticket · <run_id>`, title `worker · OK · 12m43s` (or
  `reviewer · PASS/FAIL`, `worker · DIED (no report)`, `worker · EMPTY`) -
  no glyphs in titles. Description is a framed block (box-drawing,
  <= 40 cols per line): `┌ ok · <run_id>` header + `├` meta lines
  (repo/wt/branch, or cwd) + an optional `│ pj <tag> · $<cost|$->` line
  (LAST, only with `--project`; see Project tags) + `└` close. Fields:
  `task` (first 200 chars),
  `result` (first 400 chars), plus `prompt` / `full output` links when
  `webdrop` is available (7d TTL).
- **Status values:** `OK` (rc=0), `FAIL (rc=N)`, `EMPTY` (all attempts
  whitespace). For reviewers, a trailing `VERDICT: PASS|FAIL` in the output
  (last 300 chars) is the real signal and drives the green/red title.
  A second silent death (issue #57, retry1 did not recover) is reported as
  a normal `FAIL (rc=1)` with a `silent death x2` result — the orchestrator
  treats it like any other FAIL (one fix round, then a decision).
- **Legacy plain-text fallback:** if the embed builder fails, a
  `[bg:<profile>:<status>] cwd=... task=...` content post is sent instead.
- Inbound exemption: piscord's `isBgWebhook` exempts its own callbacks
  (webhook with `[bg:` content, or embed author name starting `pi-bg`) from
  triggering a run — no echo loops.

### Webhook delivery audit

Per-run artifacts in `~/.pi-bg-art/` — persistent, survives reboot (`/tmp`
on the hydrogen box is a tmpfs that a reboot wipes; 2026-09-13: a wiped
`/tmp` lost every `out.md` and the watchdog re-flagged ~15 finished tickets
as DEAD). `$PI_BG_TMPDIR` still overrides the dir. For one release,
`pi-bg-watchdog` and `pi-bg-tail` also check the legacy `/tmp` location so
runs started before the upgrade still resolve. Data source for `/jobs`
history (follow-up: the bridge scan still points at `PI_BG_TMPDIR||/tmp`):

- `pi-bg-<id>-raw.out` — live output (tee'd from the first attempt on)
- `pi-bg-<id>-out.md` — final output (non-empty = run completed)
- `pi-bg-<id>-rc` — final exit code (written by the EXIT trap; the
  watchdog's SILENT classification reads it)
- `pi-bg-<id>-retry1` — silent-death relaunch marker (issue #57): written
  before the one retry, removed when the retry produced output, kept when a
  second silent death follows (the watchdog then reports SILENT, not DEAD)
- `pi-bg-<id>-wb-status` — success-path webhook HTTP code + time
  (recorded at post time; the response body stays in `pi-bg-<id>-wb-resp.txt`)
- `pi-bg-<id>-webhook-failed` — dead letter when all 3 post attempts fail
- `pi-bg-<id>-killed` — pi-bg-kill marker (the watchdog skips such tickets)

### tail / kill (in-flight control)

- `pi-bg-tail <id> [lines] [-f]` — last N lines (default 40) of
  `~/.pi-bg-art/pi-bg-<id>-raw.out` (legacy `/tmp` for pre-upgrade runs),
  optional follow. No live output = exit 2.
- `pi-bg-kill <id> [--dry-run]` — resolves the run's escape cgroup
  (`…/user@<uid>.service/pi-bg/<id>/`), dry-run prints the process tree,
  real kill sends SIGTERM to every member AND the ticket's process group
  (issue #56: pi-bg runs under setsid; the wrapper leads the ticket session,
  so `-pgid` covers session processes that escaped the cgroup walk), waits
  `$PI_BG_KILL_WAIT` (10s), then SIGKILL via `cgroup.kill` (per-pid +
  per-group fallback). Posts a `KILLED`
  embed (same webhook URL source as pi-bg; dead letter on post failure).
  Precise by construction: only the run's cgroup subtree dies.

### AGENTS.md drift tripwire (watchdog, alert-only)

`~/.pi/agent/AGENTS.md` is prompt-level law: changes require Andryo's
explicit approval (2026-09-14). The rule is mechanical now — the watchdog
sweep (every 15 min) runs `jarate agents-check` and compares the live file
(`~/.pi/agent/AGENTS.md`, fallback `~/AGENTS.md` — live boxes keep the law
in `~/AGENTS.md`) against the hash manifest `~/.pi/agent/.agents-md-hash`
(`<sha256>  <UTC ts>  <note>`).

- Drift = manifest missing OR hash mismatch. On drift the watchdog posts
  ONE warning per drifted hash: `AGENTS.md drift: <hash8> since <ts> —
  review + re-bless: jarate agents-bless "note"` (dedupe state:
  `~/.pi/agent/.agents-md-drift-warned`, written only after a successful
  post, so a dead webhook retries next sweep).
- ALERT-ONLY: never reverts, never blocks, sweep always exits 0. jarate
  missing/unreadable -> the tripwire skips silently (backward compatible).
- Approved change -> re-bless: `jarate agents-bless "<who/what approved>"`.
  New content, new hash, drift clears; a further unapproved edit warns
  again (different hash).

## pi-wait internals

`pi-wait --since <message-id> [--timeout 300] [--check 5]` polls
`GET /channels/<id>/messages?after=<since>` (5s default interval) and classifies
the first new message:

- message from the webhook author (`~/.config/pi-dispatch/webhook_author`)
  with a `webhook_id` → print `CALLBACK <msgid>` + content, exit 0
- any other non-bot message → print `HUMAN <msgid>: <name>`, exit 2
- deadline reached → print `timeout`, exit 3

Bot token + channel come from `~/.pi/agent/settings.json` (`channels[0]`).
The calling bot's own messages are skipped.

## agent-say

`agent-say <channel-id> "message"` posts to a Discord channel as the calling
user's pi bot. Token: `$PI_BOT_TOKEN` or first discord `botToken` in
`~/.pi/agent/settings.json`. This is how agents talk to each other — a normal
reply only auto-forwards to your own channel. Keep peer messages short and
self-contained (the peer has no context).

## Decision rules

- **Dispatch to worker** when the task is self-contained and context-hungry:
  bulk edits, test runs, research, file generation, anything whose intermediate
  output would bloat the orchestrator's session.
- **Dispatch to reviewer** when the result needs checking: a PR, significant
  code, any claim that needs proof. Reviewer gets the same workdir; verdict is
  PASS/FAIL with ranked findings and file:line cites.
- **FAIL loop:** feed the reviewer's findings back to a worker for ONE fix
  round, then the orchestrator decides (accept / escalate to the human). No
  infinite worker↔reviewer loops.
- **Do it inline** when the task is tiny (a few seconds, <1 screen of output)
  — dispatch has ~20s overhead.
- **Default to fire-and-forget for anything non-trivial:** dispatch, confirm,
  end turn, let the callback wake you. In-turn `pi-wait` is the exception
  (short task, answer must land in this turn). A polling loop in the channel
  reads as "stuck" to the human — Andryo's call, 2026-09-08.

## Responsiveness (hard rule)

The human beats every wait.

- `pi-wait` exits 2 on any human message → end the turn fast, the message is
  already queued.
- Keep waits ≤ 240s and rare — see decision rules. Default = no wait at all.
- One wait at a time per turn (one pair of hands). Multiple workers: dispatch
  all, confirm, end turn — callbacks arrive as separate wakes; answer each as
  it lands.
- Messages that arrive while a run is in flight get a visible position ack:
  `[queued] N in line` (N = slot in that channel's re-wake queue). A trailing
  `. queue` parks a message there without arming the mid-run interrupt; the
  owner can edit or delete a queued message and the queue follows. Details:
  [COMMANDS.md](COMMANDS.md#queue-control-queue-edit-delete).

## KV hygiene

- Callbacks are truncated (~400-char brief) in the channel. For detail, read
  the files / `stdout.log` / the webdrop links directly — never paste big
  worker output into the turn.
- Worker sessions live in `~/.pi/agent-worker/sessions/`, reviewer in
  `~/.pi/agent-reviewer/sessions/`. Resumable: `pi -r` inside that profile
  (`PI_CODING_AGENT_DIR=~/.pi/agent-worker pi -r`).
- Each dispatch is a fresh context: the task prompt must be self-contained
  (no "the thing we discussed").

## Extending to other agents

Per agent: own Discord channel + own incoming webhook on it + own config dir
(`~/.pi/agent-<profile>`). Only the webhook URL/author in
`~/.config/pi-dispatch/` differs; the scripts are shared.

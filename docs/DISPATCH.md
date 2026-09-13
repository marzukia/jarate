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

## The flow (default: fire-and-forget)

Dispatch, confirm, end the turn. The callback wakes the orchestrator as a new
turn — no polling, no held turn.

```bash
# 1. dispatch (background; posts a webhook callback on exit)
cd /path/to/workdir
nohup ~/scripts/pi-bg worker "task" > stdout.log 2>&1 &

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
nohup ~/scripts/pi-bg worker "task" > stdout.log 2>&1 &

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
pi-bg [worker|reviewer] [--worktree <ref>] [pi flags...] "task"
```

- Task = last positional argument. Pass-through `pi` flags allowed (the task
  is always the final arg).
- Non-interactive: runs `pi -p --no-extensions`.
- Empty completion (local-model quirk) → up to 3 attempts, 3s apart.
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

### Callback protocol

On completion, `pi-bg` posts to the Discord webhook:

- Webhook URL: `$PI_DISPATCH_WEBHOOK` or first line of
  `~/.config/pi-dispatch/webhook`. File absent = no callback (stdout is always
  printed).
- **Embed callback (default):** a single embed with author
  `pi-bg ticket · <run_id>`, title `✓ worker · OK · 3m12s` (or
  `✓/✗ reviewer · PASS/FAIL`, `⚠ EMPTY`), code-block meta (status, repo,
  worktree, branch, or cwd), and fields: `task` (first 200 chars),
  `result` (first 400 chars), plus `prompt` / `full output` links when
  `webdrop` is available (7d TTL).
- **Status values:** `OK` (rc=0), `FAIL (rc=N)`, `EMPTY` (all attempts
  whitespace). For reviewers, a trailing `VERDICT: PASS|FAIL` in the output
  (last 300 chars) is the real signal and drives the green/red title.
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
  real kill sends SIGTERM to every member, waits `$PI_BG_KILL_WAIT` (10s),
  then SIGKILL via `cgroup.kill` (per-pid fallback). Posts a `⛔ KILLED`
  embed (same webhook URL source as pi-bg; dead letter on post failure).
  Precise by construction: only the run's cgroup subtree dies.

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

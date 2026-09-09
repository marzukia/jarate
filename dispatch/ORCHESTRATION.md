# Orchestration pattern

Monky (the main agent) is the orchestrator. It keeps its own context (KV) lean by
handing self-contained work to `worker` agents and verification to `reviewer`
agents. Everything returns through the Discord webhook bus.

## Roles

| profile | ctx | thinking | job |
|---|---|---|---|
| `worker` | 131k | medium | do the task, verify, short output |
| `reviewer` | 131k | xhigh | adversarial review, ranked findings, PASS/FAIL verdict |

## The flow (default: fire-and-forget)

Dispatch, confirm, end the turn. The callback wakes you as a new turn —
no polling, no held turn.

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

## Worktrees (isolated runs)

`pi-bg worker --worktree <ref> "task"` runs the agent in a fresh git worktree
instead of the live checkout — use it when the task edits files and you don't
want it touching the working tree (or when two workers share a repo).

- Per-run switchboard session id `pi-<user>-<profile>-<id>` (env `PI_SESSION_ID`,
  interpolated by the profiles' `X-Switchboard-Session` header) — each dispatch
  is its own ledger session, no more collapsed worker entries.
- Worktree: `$PI_BG_WT_DIR/<repo>/<id>` (default `~/.pi-bg-wt/<repo>/<id>`),
  branch `pi-bg/<id>`, created from `<ref>` (omit the ref for HEAD:
  `pi-bg worker --worktree "task"` — the ref is only consumed when more args
  follow the flag).
- The worktree is **kept** after the run. Callback + stdout carry
  `worktree=<path> branch=<branch>`. Inspect with `git -C <path> diff`, then
  commit/merge, and `git worktree remove <path>` when done.
- Not a git repo → exit 3 before the agent starts.

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
- **Do it inline** when the task is tiny (a few seconds, <1 screen of output) —
  dispatch has ~20s overhead.
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

## KV hygiene

- Callbacks are truncated to 1.8k chars in the channel. For detail, read the
  files/`stdout.log` directly — never paste big worker output into the turn.
- Worker sessions live in `~/.pi/agent-worker/sessions/`, reviewer in
  `~/.pi/agent-reviewer/sessions/`. Resumable: `pi -r` inside that profile
  (`PI_CODING_AGENT_DIR=~/.pi/agent-worker pi -r`).
- Each dispatch is a fresh context: the task prompt must be self-contained
  (no "the thing we discussed").

## Extending to other agents

Per agent: own Discord channel + own incoming webhook on it + own config dir
(`~/.pi/agent-<profile>`). Only the webhook URL/author in
`~/.config/pi-dispatch/` differs; the scripts are shared.

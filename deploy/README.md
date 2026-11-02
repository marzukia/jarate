# deploy/ — jarate deployment: single-box timer deploy, fleet-wide rollout, tag discipline

## Tag discipline (issue #314)

Every change that ships to the fleet gets a git tag; the tag is the version. Untagged main is not a deploy target: the fleet rollout refuses anything that is not a tag, and the bridge's startup drift check holds every agent to the pinned tag.

- Cut the tag at the commit that is ready to ship (after PR merge, green CI, review PASS). The first fleet tag is cut by the operator after this change merges; no tag is cut as part of this change.
- Tags are release marks, not commit decoration: a tag points at the exact commit the fleet should run. Rolling the fleet to a new version = cut a tag, run the rollout.
- The tag's SHA is what the rollout pins per agent (`/var/tmp/jarate-pinned/<uid>`); the bridge compares its checkout's git HEAD against that SHA at every pi start (SHA compare only — no LLM in the enforcement path) and pages warden exactly once per process on a mismatch.
- The drift check's `localHead()` verifies the checkout the bridge loads from (the module resolves its checkout via `realpath` from its own module path); under the documented symlinks-into-`~/projects/jarate` deployment that is the same tree the rollout moves, but a box loading the bridge from any other checkout would be checked against the wrong tree.

## The two deploy paths

- **Single-box, timer-driven:** `deploy.sh` (the existing path, untouched by #314) — 30s timer tick, idempotent, health-gated (≤90s), auto-rollback, 3-fail backoff with 1h expiry, pi liveness on every tick (#319). It tracks `origin/main` per box and is the self-healing local deploy.
- **Fleet-wide, operator-run:** `jarate-rollout.sh` — one run = the whole host on the named tag. It is not a timer: it is a vault plan (below).

## Running the fleet rollout (piboy-lane vault plan, one operator tap)

One run moves every agent checkout on the host to the tag, restarts each `pi.service`, verifies the box, and writes the pin. The run is filed as a hall-monitor vault plan on the piboy lane: `POST /vault/plans` with the complete script as `command` (it is a plain shell script — the tag is $1, the hall-monitor base is $2 or `JARATE_HM_URL`) and `required_credential_keys: ["SUDO_PW"]`. The plan executor is the worker account, not root, so the script self-elevates at the top of `main()`: when EUID is not 0 it re-execs itself under sudo, feeding `SUDO_PW` to `sudo -S` on stdin (never echoed, never in argv/ps; args + env preserved, so the `set -euo pipefail` semantics carry over the re-exec) — not root AND `SUDO_PW` unset fails loud with a clear message. One operator tap: the operator approves the plan, and it then runs to completion as root — no further human steps. Root does the cross-user steps; the script itself never asks for a password interactively.

### What one run does (per agent user, in /etc/passwd order)

Deterministic lane set: an agent is a login-shell user (bash/sh/zsh/dash in `/etc/passwd`) with a `~/projects/jarate` checkout AND a resolvable HM agent key (the existing `resolve_key_file` chain — first existing of `~/.config/hall-monitor/agent-key`, `~/.config/hall-monitor/key`, `~/hall-monitor.key`); a host with none fails loud. A checkout without a resolvable key is a dev checkout: a visible, deterministic skip (`skip <user>: no agent key (dev checkout)`, logged, never silent). A resolvable key without a checkout fails loud: a fleet lane missing its checkout is broken. Lapsed lane (the pre-restart check, the key check runs first — a stale marker on a no-key user is the no-key skip, never lapsed): a lane whose live marker (`/var/tmp/jarate-live/<uid>`) mtime is older than `JARATE_ROLLOUT_LAPSED_S` (default 300s) before the restart is LAPSED: a visible, deterministic skip (`skip <user>: lane lapsed (live marker <age>s old pre-restart)`) — no restart, no smoke say, no pin; a MISSING marker is FRESH (roll — operator ruling 2026-11-02: no evidence of liveness is not evidence of lapse; the post-restart 90s gate judges it), and the post-restart 90s gate is unchanged for live lanes. (First rollout, plan 180 / #326: enumeration ran with executor-user visibility and a non-lane dev checkout stopped the run — hence the self-elevation and the key-based lane set. The `pi.service` unit is NOT a usable discriminator: the dev checkout user has one.)

1. **Dirty-tree check** — `git status --porcelain` must be empty; a dirty checkout is never moved (fail loud).
2. **`git fetch --tags`** (as the user: `printf '%s\n' "$SUDO_PW" | sudo -S -u <user> ...`; the printf keeps the password out of `ps`). The tag must exist after the fetch — validated up front in the first agent's repo so a bad tag fails before any box moves.
3. **Plain fast-forward to the tag** (`git merge --ff-only`). A divergent checkout fails loud — no merge, no rebase, ever.
4. **Restart `pi.service`** via the user systemd instance (`sudo -u <user> env XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user restart pi.service`).
5. **Liveness verify:** `/var/tmp/jarate-live/<uid>` mtime must advance after the restart (≤90s wait loop, `JARATE_ROLLOUT_GATE_TIMEOUT_S`; fail loud).
6. **Delivery verify:** one smoke say via hall-monitor — `POST <base>/api/fleet/say` with the user's `X-Agent-Key` (the agent-key file resolved from the first existing of `~/.config/hall-monitor/agent-key`, `~/.config/hall-monitor/key`, `~/hall-monitor.key` — lanes onboarded at different times carry different paths; the key is the `X_AGENT_KEY=` line (value trimmed — onboarding files carry `BASE_URL=` before `X_AGENT_KEY=`), then an `hm_agent_` line, else the first non-comment line); 2xx = delivered, anything else fails the user. The hall-monitor base comes from arg 2 or `JARATE_HM_URL` — no hardcoded default; unset = fail loud.
7. **Pin:** only after steps 1–6 all pass, `/var/tmp/jarate-pinned/<uid>` gets the tag's SHA. That is what the bridge's startup drift check compares against — a failed rollout leaves no pin, so the box stays visibly drifted (and pages warden) until it is rolled.

A per-user failure stops the whole run (fail loud, exit 1); already-rolled users keep their pins, the failed user keeps none. Re-run the plan at the same tag to finish the host (rolled users are already at the tag — the ff is a no-op, and the restart + verifies + pin complete them).

### Env / args

- `$1` — the release tag (required; must exist after `fetch --tags`)
- `$2` / `JARATE_HM_URL` — the hall-monitor base `http://host:port` (required; no default)
- `SUDO_PW` — the vault plan credential (injected as env by the vault)
- `JARATE_LIVE_DIR` — the live marker dir (default `/var/tmp/jarate-live`)
- `JARATE_PINNED_DIR` — the pinned-SHA dir (default `/var/tmp/jarate-pinned`)
- `JARATE_ROLLOUT_GATE_TIMEOUT_S` — the liveness verify timeout (default 90)
- `JARATE_ROLLOUT_LAPSED_S` — the pre-restart lapsed threshold in seconds (default 300; a live marker older than this is a visible lapsed skip — no restart, no smoke say, no pin; a missing marker is fresh, the post-restart 90s gate judges it)

## Tests

- `deploy.test.ts` — the SIGTERM fail-recording / backoff / liveness behavior of `deploy.sh` (end-to-end against a fake HOME + local git origin, plus the sourced-harness ec=143 proof).
- `rollout.test.ts` — the `jarate-rollout.sh` pure helpers (`validate_hm_base`, `resolve_key_file`, `first_key_line`, `classify_lane`, `wait_marker`, `enumerate_agents`), extracted verbatim from the script (an extraction failure exits 90, so a rename in the script is what the tests catch).
- `packages/bridge/channel/version-drift.test.ts` — the startup drift check (pointer missing / match / mismatch / page failure / key-file fallback / env overrides / once-per-process; no real network — the HTTP leg is injected).

<p align="left">
  <img src="assets/jarate-icon.png" height="120" alt="jarate — a jar of piss"/>
</p>

# jarate

The operating system of the monky/frank pi-agent fleet. One repo, one
installer, one checkout per box — the checkout **is** the deployment (no
rsync, machine paths are symlinks).

What it ships:

- **`packages/bridge`** — the Discord bridge for pi (`@jarate/bridge`):
  channels, slash commands, threading, chunking, acks, send-file, agent-to-agent
  exemption.
- **`dispatch/`** — the drained dispatch lane (retired 2026-10-20, drain
  declared 2026-10-23, #279): `jarate-bg` launch stub (exit 10; `signal`
  stays live until the fleet timer lands) + `jarate-bg-watchdog` completion
  sweep + `pi-postcheck.sh` (restart health check, live).
- **`templates/` + `scripts/init-repo.sh`** — newrepo boilerplate (repo
  governance: AGENTS/CONTRIBUTING/CI/hooks).

`marzukia/piscord` (standalone) is legacy upstream, untouched. This repo is
the source of truth.

## Layout

| path | what |
|---|---|
| `packages/bridge/` | `@jarate/bridge` — Discord bridge for pi (TypeScript, bun, strict tsc; 300+ tests) |
| `packages/bridge/skills/` | pi skill (`channel`) that ships with the bridge |
| `dispatch/` | drained dispatch lane (#279): `jarate-bg` launch stub (exit 10), `jarate-bg-watchdog` sweep, `pi-postcheck.sh` |
| `templates/` | newrepo boilerplate (repo governance) |
| `scripts/` | `init-repo.sh` — instantiates `templates/newrepo` into a new repo |
| `install.sh` | idempotent bootstrap installer (`--dry-run`, `--jarate-dir`) |
| `docs/SETUP.md` | **end-to-end setup**: bare box → working pi Discord agent (verified) |
| `docs/DEPLOY.md` | install.sh internals, deploy-after-pull, one-time box migration |
| `docs/DISPATCH.md` | orchestration pattern: roles, worktrees, cgroup escape, callback protocol, fleet caps |
| `docs/COMMANDS.md` | every Discord command with examples |
| `.githooks/` | pre-commit (biome gate) |
| `.github/workflows/ci.yml` | CI: biome + bridge typecheck/tests (context `ci`) |

## Quick start

Bare box → working pi Discord agent in 8 verified steps:
**[docs/SETUP.md](docs/SETUP.md)** (prerequisites → Discord app +
gateway intents → `./install.sh` → `~/.pi/agent/settings.json` +
`models.json` → `pi.service` user unit → first-run journal check →
dispatch webhook → optional auto-deploy timer).

TL;DR (full detail in SETUP.md):

```bash
# 1. deps: node>=20, bun>=1.4, pi
npm config set prefix ~/.local
npm install -g @earendil-works/pi-coding-agent bun

# 2. Discord portal: app + bot token + 4 gateway intents
#    (SERVERS, SERVER MESSAGES, MESSAGE CONTENT, VOICE STATES —
#     see packages/bridge/channel/discord.ts GATEWAY_INTENTS), invite bot

# 3. bootstrap (symlinks jarate-bg + pi-postcheck.sh into the checkout)
git clone https://github.com/marzukia/jarate.git ~/projects/jarate
~/projects/jarate/install.sh

# 4. point pi at the bridge + channel (settings.json "packages" +
#    channels[0].botToken), models.json for the LLM endpoint

# 5. install ~/.config/systemd/user/pi.service (SETUP.md step 5), then:
systemctl --user enable --now pi.service

# 6. verify: journal line "registered 0 slash commands" + message the channel
XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u pi.service --no-pager \
  | grep 'slash commands' | tail -1
```

Reference box: <host-a>, Linux x64 (example: Fedora 42), agent user
`monky`, `node v22.22.2`, `bun 1.4.2`, `pi 0.85.1`. Steps marked `[verified]` in
SETUP.md were run there; `[verify-on-fresh-box]` = reconstructed from box
state.

## Discord commands

`stop` / `/stop`, `/help`, `/btw`, `/status`, `/reset`, `/restart`, `/undo`,
`/redo`, `/verbose`, `/compact`, `/model`, `/jobs`, `/todos`, `/sleep`,
plus `! <cmd>` shell passthrough. All output uses ASCII state tags
(`[ok]` `[!]` `[new]` `[queued]` `[-]`), no emoji.
Full reference: [docs/COMMANDS.md](docs/COMMANDS.md).

## Architecture (one-pager)

```
                 Discord
                    |  gateway MESSAGE_CREATE push (primary)
                    |  + REST polling (backfill: 60s up, 5s if gateway down)
                    v
        +---------------------------+
        |  bridge (pi package)      |  <jarate>/packages/bridge
        |  channels, commands,      |  inbound: plain user messages
        |  chunking, threading,     |  outbound: auto-forward to channel
        |  acks, send-file          |  + commands, typing, acks
        +-------------+-------------+
                      |  loads into
                      v
        +---------------------------+
        |  pi (coding agent)        |  ~/.pi/agent  (settings.json, AGENTS.md)
        |  orchestrator turn loop   |
        +-------------+-------------+
                      |  jarate-bg worker|reviewer [--worktree <ref>] "task"
                      v
        +---------------------------+
        |  role profiles            |  ~/.pi/agent-worker, ~/.pi/agent-reviewer
        |  cgroup escape            |  survives pi.service restart
        |  git worktrees            |  ~/.pi-bg-wt/<repo>/<id>, branch pi-bg/<id>
        |  run artifacts            |  ~/.pi-bg-art/ (persistent, $PI_BG_TMPDIR)
        +-------------+-------------+
                      |  on exit: webhook embed (status/verdict, brief,
                      |             webdrop prompt+output links)
                      v
                 Discord (callback channel) -- wakes the orchestrator as a new turn
```

- **bridge → Discord**: polls inbound messages, injects a `<channel-ctx>`
  block, forwards agent output back (chunked, threaded, ping-suppressed).
  Bot traffic is exempt (no echo loops).
- **jarate-bg dispatch loop (RETIRED 2026-10-20; drained 2026-10-23, #279)**:
  the orchestrator kept its KV lean by handing context-hungry work to
  worker/reviewer profiles; the webhook callback was the wake, in-turn
  `jarate-wait` the opt-in exception. Dispatch now goes to the fleet control
  plane (hall-monitor `POST /fleet/dispatch`).
  Full protocol: [docs/DISPATCH.md](docs/DISPATCH.md).

## Develop

```bash
cd packages/bridge && bun install
bun x tsc --noEmit     # typecheck
bun x bun test         # full bridge suite
bunx biome check .     # from repo root (formatter + linter gate)
```

Contribute: see [CONTRIBUTING.md](CONTRIBUTING.md) (branch `pi-bg/<id>` or
`feature/*`, PR to `main`, reviewer `VERDICT: PASS` + green `ci` before
merge).

## New repos

```bash
./scripts/init-repo.sh <dir> <owner/repo> --push --private \
  --lead "..." --commit-identity "name <email>" --stack "one-liner"
```

Renders `templates/newrepo` (AGENTS.md, CLAUDE.md, CONTRIBUTING.md,
Makefile, pre-commit hooks, CI, PR/issue templates, docs scaffold), `git init -b main` + initial commit. Idempotent: refuses to
clobber without `--force`; `--dry-run` prints the plan. See
`templates/README.md`.

<p align="left">
  <img src="assets/jarate-icon.png" height="120" alt="jarate — a jar of piss"/>
</p>

# jarate

Monorepo for the **pi + piscord agent stack**: one repo, one installer, every
agent box in sync. jarate is the source of truth for the stack —
`marzukia/piscord` is the legacy upstream and stays untouched going forward.

## Quickstart

```bash
git clone <this-repo> && cd jarate
./install.sh --dry-run    # show what would change
./install.sh              # sync everything for the calling user
```

Then restart the agent's pi service if it is running:

```
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service
```

`install.sh` is idempotent, never touches `~/.pi/agent/settings.json`, and
never restarts pi. See [docs/DEPLOY.md](docs/DEPLOY.md) for internals and
per-agent notes (frank cross-user pattern included).

## Layout

| path | what |
|---|---|
| `piscord/` | Discord channel bridge for pi (TypeScript, bun; 168 tests, tsc clean) |
| `dispatch/` | `pi-bg` (dispatch worker/reviewer, cgroup escape, webhooks), `pi-wait` (in-turn wait) |
| `bin/agent-say` | agent-to-agent Discord messaging |
| `pgrag/` | RAG corpus tool for agents (uv + Postgres `rag` db; PEP-723 scripts, memory layer) |
| `templates/` | newrepo boilerplate (repo governance: AGENTS/CONTRIBUTING/CI/hooks) |
| `scripts/` | `init-repo.sh` — instantiates `templates/newrepo` into a new repo |
| `install.sh` | idempotent installer (`--dry-run`, `--piscord-dir`) |
| `docs/DISPATCH.md` | orchestration pattern: roles, worktrees, cgroup escape, callback protocol |
| `docs/COMMANDS.md` | every Discord command with examples |
| `docs/DEPLOY.md` | install.sh internals, per-agent deploy notes |
| `.githooks/` | pre-commit (biome gate) |
| `.github/workflows/ci.yml` | CI: biome + piscord typecheck/tests (context `ci`) |

## Discord commands

`stop` / `/stop`, `/help`, `/btw`, `/status`, `/reset`, `/verbose`,
`/compact`, `/model`, `/jobs`, plus `! <cmd>` shell passthrough.
Full reference: [docs/COMMANDS.md](docs/COMMANDS.md).

## Architecture (one-pager)

```
                 Discord
                    │  REST polling (5s) + gateway (presence)
                    ▼
        ┌──────────────────────────┐
        │  piscord (pi extension)  │  ~/.pi/agent/piscord
        │  channel/ (TypeScript)   │  inbound: plain user messages
        │  commands, chunking,     │  outbound: auto-forward to channel
        │  threading, debouncing   │  + commands, typing, acks, send-file
        └───────────┬──────────────┘
                    │  loads into
                    ▼
        ┌──────────────────────────┐
        │  pi (coding agent)       │  ~/.pi/agent  (settings.json, AGENTS.md)
        │  orchestrator turn loop  │
        └───────────┬──────────────┘
                    │  pi-bg worker|reviewer [--worktree <ref>] "task"
                    ▼
        ┌──────────────────────────┐
        │  role profiles           │  ~/.pi/agent-worker, ~/.pi/agent-reviewer
        │  cgroup escape           │  survives pi.service restart
        └───────────┬──────────────┘
                    │  on exit: webhook embed (status/verdict, task, brief,
                    │               webdrop prompt+output links)
                    ▼
                 Discord (callback channel) ── wakes the orchestrator as a new turn
```

- **pi extension → Discord gateway**: piscord polls inbound messages, injects
  a `<channel-ctx>` block, forwards agent output back (chunked, threaded,
  ping-suppressed). Bot traffic is exempt (no echo loops).
- **pi-bg dispatch loop**: the orchestrator hands context-hungry work to
  worker/reviewer profiles (separate pi homes, 131k ctx). Each run escapes
  pi.service's cgroup, works in an optional git worktree
  (`~/.pi-bg-wt/<repo>/<id>`, branch `pi-bg/<id>`), and posts a webhook
  callback on exit. Callback = the wake; default flow is fire-and-forget.
  Full protocol: [docs/DISPATCH.md](docs/DISPATCH.md).
- **webdrop**: full prompt + full output of every dispatch get a 7d link;
  the channel only gets a brief.

## Develop

```bash
cd piscord && bun install
bun x tsc --noEmit     # typecheck
bun x bun test         # 168 pass
bunx biome check .     # from repo root (formatter + linter)
```

Contribute: see [CONTRIBUTING.md](CONTRIBUTING.md).

## New repos

```bash
./scripts/init-repo.sh <dir> <owner/repo> --push --private \
  --lead "..." --commit-identity "name <email>" --stack "one-liner"
```

Renders `templates/newrepo` (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, MEMORY.md,
Makefile, pre-commit hooks, CI workflow, PR/issue templates, docs scaffold),
does `git init -b main` + initial commit, installs the pre-commit hook.
Idempotent: refuses to clobber without `--force`; `--dry-run` prints the
plan. See `templates/README.md`.

## Verify the install

```bash
./install.sh --dry-run   # every action printed, nothing changed
```

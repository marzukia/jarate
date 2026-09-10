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
- **`dispatch/`** — orchestration: `pi-bg` (one-shot worker/reviewer runs with
  git worktrees, cgroup escape, Discord webhook callbacks) + `pi-wait`
  (in-turn wait).
- **`packages/recall`** — shared RAG on Postgres + pgvector (`bun recall
  ingest|query`). TS port of the old Python pgrag; same db, no migration.
- **`bin/agent-say`** — agent-to-agent Discord messaging.
- **`templates/` + `scripts/init-repo.sh`** — newrepo boilerplate (repo
  governance: AGENTS/CONTRIBUTING/CI/hooks).

`marzukia/piscord` (standalone) is legacy upstream, untouched. This repo is
the source of truth.

## Layout

| path | what |
|---|---|
| `packages/bridge/` | `@jarate/bridge` — Discord bridge for pi (TypeScript, bun, strict tsc; 300+ tests) |
| `packages/bridge/skills/` | pi skill (`channel`) that ships with the bridge |
| `packages/recall/` | `@jarate/recall` — RAG CLI (`bun recall ingest\|query`), `schema.sql` (dim 768, nomic-embed-text) |
| `dispatch/` | `pi-bg` (dispatch worker/reviewer, worktrees, cgroup escape, webhook), `pi-wait` (in-turn wait) |
| `bin/agent-say` | agent-to-agent Discord messaging |
| `templates/` | newrepo boilerplate (repo governance) |
| `scripts/` | `init-repo.sh` — instantiates `templates/newrepo` into a new repo |
| `install.sh` | idempotent bootstrap installer (`--dry-run`, `--jarate-dir`) |
| `docs/DEPLOY.md` | install.sh internals, deploy-after-pull, one-time box migration |
| `docs/DISPATCH.md` | orchestration pattern: roles, worktrees, cgroup escape, callback protocol, fleet caps |
| `docs/COMMANDS.md` | every Discord command with examples |
| `docs/PGRAG-SETUP.md` | RAG DB + embed runbook from zero |
| `.githooks/` | pre-commit (biome gate) |
| `.github/workflows/ci.yml` | CI: biome + bridge typecheck/tests (context `ci`) |

## End-to-end setup (bare Fedora box → working pi Discord agent + RAG)

Reference box: <host-a>, Fedora 42 x64, agent user `monky`,
versions `node v22.22.2`, `bun 1.4.2`, `pi 0.85.1`. Commands marked
`[verified]` were run on that box 2026-09-10; `[verify-on-fresh-box]` =
reconstructed from box state, not exercised on a fresh install.

### 1. Prerequisites

- Fedora (or any cgroup-v2 Linux with systemd user sessions)
- `git`, `python3` (pi-bg embed builder, pi-wait message classification)
- Node ≥ 20 + npm (pi is a node CLI) `[verified: node --version → v22.22.2]`
- bun ≥ 1.4 (bridge deps, recall CLI, biome) `[verified: bun --version → 1.4.2]`
- A Discord bot app + a channel it is invited to (step 3)
- For RAG: PostgreSQL with `pgvector` + an Ollama host running
  `nomic-embed-text` (step 8; optional if you skip RAG)

### 2. Install pi and bun

The reference box has both under an npm prefix of `~/.local`
(`npm config get prefix` → `/home/monky/.local`; `~/.local/bin/pi` is a
symlink into `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/`):

```bash
npm config set prefix ~/.local
npm install -g @earendil-works/pi-coding-agent   # pi  [verify-on-fresh-box]
npm install -g bun                               # bun (box uses the npm bun)  [verify-on-fresh-box]
# ensure ~/.local/bin is on PATH in ~/.bashrc
pi --version   # expect: 0.8x.x  [verified on ref box: 0.85.1]
bun --version
```

### 3. Discord bot + invite

1. [Discord Developer Portal](https://discord.com/developers/applications) →
   New Application → Bot → Reset Token → copy the token (`<BOT_TOKEN>`).
2. Invite it to your server: `https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=512&scope=bot`
   (permissions: view channels, send messages, read message history, attach
   files, embed links). `[verify-on-fresh-box]`
3. Collect the three IDs the config needs:
   - **channel ID**: Discord settings → Advanced → Developer Mode → right-click
     a channel → Copy Channel ID
   - **your user ID**: right-click your avatar → Copy User ID
   - **webhook** (step 10): right-click channel → Edit Channel → Integrations
     → New Webhook → Copy Webhook URL

### 4. Clone + bootstrap

```bash
git clone https://github.com/marzukia/jarate.git ~/projects/jarate
cd ~/projects/jarate
./install.sh --dry-run    # print the plan, change nothing  [verified]
./install.sh              # clone path is [verify-on-fresh-box]; with an existing
                          # checkout it pulls --ff-only + bun install  [verified]
```

`install.sh` (v3, no-rsync) does exactly this and nothing else:

1. ensures a checkout exists (`--jarate-dir DIR`, `--clone-url URL`;
   default `~/projects/jarate`), else `git pull --ff-only`
2. `bun install` in `packages/bridge`
3. symlinks machine paths into the checkout:

   - `~/scripts/pi-bg` → `<jarate>/dispatch/pi-bg`
   - `~/scripts/pi-wait` → `<jarate>/dispatch/pi-wait`
   - `~/bin/agent-say` → `<jarate>/bin/agent-say`
   - `~/projects/recall` → `<jarate>/packages/recall` (only if the dest is
     absent or already this symlink)

Guarantees: never touches `~/.pi/agent/settings.json`, never restarts or
kills pi, never copies repo files. It ends by printing the settings line to
set and a restart reminder. Regression check:
`HOME=/tmp/fake bash install.sh --dry-run` exits 0 `[verified]`.

### 5. `~/.pi/agent/settings.json`

Minimal working shape (ref box values, secrets redacted):

```json
{
  "defaultProvider": "hydrogen",
  "defaultModel": "qwen3.8-27b",
  "packages": ["/home/monky/projects/jarate/packages/bridge"],
  "channels": [
    {
      "id": "discord-monky",
      "name": "MONKY",
      "type": "discord",
      "enabled": true,
      "channel": "<DISCORD_CHANNEL_ID>",
      "botToken": "<BOT_TOKEN>",
      "default": true,
      "ownerUserId": "<YOUR_DISCORD_USER_ID>",
      "forwardToolCalls": false,
      "ack": false
    }
  ]
}
```

- `packages` — the ONLY line install.sh cares about; point it at the checkout
  (the script prints it for you).
- Channel field reference:
  [packages/bridge/README.md](packages/bridge/README.md) (`channel`,
  `botToken`, `ownerUserId` = who may run owner commands, `default`,
  `startupMessage`, `ack`, `forwardToolCalls`, `peerBotIds`).
- Optional, on the ref box: an `mcp` array (Tavily search MCP) and
  `defaultThinkingLevel: "medium"`.

**Model/provider.** pi picks up custom providers from
`~/.pi/agent/models.json` (see pi docs: `docs/models.md`,
`docs/custom-provider.md` inside the pi install). The ref box runs a local
vLLM behind an OpenAI-compatible endpoint:

```json
{
  "providers": {
    "hydrogen": {
      "name": "Hydrogen (llama.cpp)",
      "baseUrl": "http://127.0.0.1:8081/v1",
      "api": "openai-completions",
      "apiKey": "hydrogen-local",
      "models": [
        { "id": "qwen3.8-27b", "name": "Qwen3.8 27B",
          "reasoning": true, "input": ["text", "image"],
          "contextWindow": 262144, "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
      ]
    }
  }
}
```

`defaultProvider`/`defaultModel` in settings.json must match the provider
and model ids above. Hosted providers (OpenRouter, OpenAI, Anthropic) work
the same way — their API key can live in an env file that the unit loads
(step 7, `EnvironmentFile`).

### 6. `pi.service` (systemd user unit)

The ref box unit (`systemctl --user cat pi.service` `[verified]`), redacted
to what a fresh box needs:

```ini
# ~/.config/systemd/user/pi.service
[Unit]
Description=pi coding agent with Discord channel bridge
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=/home/monky
Environment=NODE_OPTIONS=--heapsnapshot-near-heap-limit=1
Environment=PATH=/home/monky/.local/bin:/usr/local/bin:/usr/bin:/bin
# optional: LLM provider API keys (ref box: ~/.hermes/.env, chmod 600)
EnvironmentFile=~/.hermes/.env
WorkingDirectory=/home/monky
# tail keeps stdin open: RPC mode exits on stdin EOF
ExecStart=/bin/bash -c 'tail -f /dev/null | /home/monky/.local/bin/pi -c --mode rpc'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Install and start (as the agent user):

```bash
systemctl --user daemon-reload                      # [verify-on-fresh-box]
systemctl --user enable --now pi.service            # [verify-on-fresh-box]
loginctl enable-linger <agentuser>                  # survive logout; [verify-on-fresh-box]
```

`pi -c --mode rpc` continues the last session in RPC mode; `tail -f
/dev/null` holds stdin open for the lifetime of the unit.

### 7. First restart + verification

The agent itself never restarts `pi.service` — a human (or the operator)
does. After step 5–6, or any bridge change:

```bash
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service
XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u pi.service --no-pager \
  | grep 'slash commands' | tail -1
```

Expected (ref box, `[verified]`): a recent line containing
`registered 6 slash commands`. Then message the channel on Discord — the
bridge should reply.

### 8. RAG setup (`packages/recall`)

Full runbook: [docs/PGRAG-SETUP.md](docs/PGRAG-SETUP.md) (verified
2026-09-09 on the ref fleet). The short version:

1. **DB** (Postgres host, as postgres): role + db `rag` + loopback-only scram
   line in `pg_hba.conf` + `psql -f <jarate>/packages/recall/schema.sql`
   (vector(768), HNSW + GIN indexes, the `search()` fusion function).
2. **Embeddings**: an Ollama host with `ollama pull nomic-embed-text`.
   MUST be 768-dim (schema contract) — verify with a live embeddings call
   before ingesting.
3. **Password**: `~/.pgpass` line `127.0.0.1:5432:rag:<user>:<password>`
   (chmod 600).
4. **CLI** (no venv; `~/projects/recall` is the install.sh symlink):

   ```bash
   cd ~/projects/recall
   bun recall ingest ~/memory ~/projects ~/AGENTS.md   # idempotent, prunes orphans
   bun recall query "your question"
   RAG_PROJECT=<project> bun recall query "filtered"
   ```

   `[verified on ref box]` — `bun recall query "ping"` returns scored rows
   from the live corpus. Env: `RAG_DSN`, `RAG_EMBED_URL`, `RAG_EMBED_MODEL`,
   `RAG_PROJECT` (defaults in the recall README). Put non-defaults in
   `~/.bashrc`, or for the agent in the unit
   (`systemctl --user edit pi.service`, then a human restarts).
5. **Gotchas** (from the runbook): wrong-dim model = full re-embed; embed
   host down = recall down (Postgres untouched).

`install.sh` never touches the database.

### 9. Dispatch setup (`pi-bg` / `pi-wait`)

The symlinks from step 4 are the whole install. Remaining pieces, all
one-time:

1. **Callback webhook.** Create a Discord webhook in the agent's channel
   (step 3.3), then:

   ```bash
   mkdir -p ~/.config/pi-dispatch
   echo "<WEBHOOK_URL>" > ~/.config/pi-dispatch/webhook       # https://discord.com/api/webhooks/<id>/<token>
   echo "<WEBHOOK_ID>"  > ~/.config/pi-dispatch/webhook_author
   chmod 600 ~/.config/pi-dispatch/webhook*
   ```

   `pi-bg` reads `$PI_DISPATCH_WEBHOOK` first, else the file (no file = no
   callback, stdout still prints). `pi-wait` needs `webhook_author` to
   recognize the callback message.
2. **python3** on PATH (embed body builder, pi-wait classification).
3. **webdrop** (optional): if `webdrop` is on PATH, every dispatch also
   gets 7d prompt/output links in the callback embed.

Then dispatch:

```bash
cd <workdir>
nohup ~/scripts/pi-bg worker "self-contained task" > stdout.log 2>&1 &
ps aux | grep "pi-bg worker\|pi-bg reviewer" | grep -v grep | wc -l  # count live
```

Fleet caps (vLLM queue protection — see docs/DISPATCH.md): monky max 2
concurrent dispatches, frank max 3. Reviewer verdicts: `VERDICT:
PASS|FAIL` is the signal. Full protocol, cgroup escape, worktree flow,
pi-wait exit codes: [docs/DISPATCH.md](docs/DISPATCH.md).

### 10. Per-agent conventions (AGENTS.md, memory, skills)

- `~/AGENTS.md` is **per-agent, hand-authored** — it is NOT part of this
  repo and `install.sh` never writes it. It carries the agent's identity,
  environment facts, people, memory conventions, dispatch rules, and
  cardinal rules. The ref box (`/home/monky/AGENTS.md`) is a working
  reference: copy its *structure* (Identity / Environment / People /
  Memory / Dispatch / Rules / Cardinal Rules) and fill in the new agent's
  facts. New *code repos* get their AGENTS.md from
  `templates/newrepo` instead (see below).
- `~/memory/` — one file per session, `YYYY-MM-DD-<short-slug>.md`, with
  `## people / ## decisions / ## follow-ups` sections (convention lives in
  the agent's AGENTS.md).
- `~/.pi/agent/skills/` — optional pi skills, per agent (ref box: webdrop,
  playwriter, ops skills). The bridge itself ships one:
  `packages/bridge/skills/channel`.
- `bin/agent-say <channel-id> "message"` — agent-to-agent messaging; token
  auto-read from `~/.pi/agent/settings.json` (`$PI_BOT_TOKEN` overrides).

### 11. Verification checklist

Each item: command → expected. Run as the agent user.

```bash
pi --version                                              # 0.8x.x  [verified: 0.85.1]
bun --version                                             # 1.4.x   [verified: 1.4.2]
test -L ~/scripts/pi-bg && readlink ~/scripts/pi-bg       # -> <jarate>/dispatch/pi-bg
test -L ~/projects/recall && readlink ~/projects/recall   # -> <jarate>/packages/recall
HOME=/tmp/fake bash install.sh --dry-run; echo $?         # 0, nothing changed
jq -e '.packages[0]' ~/.pi/agent/settings.json            # ends /packages/bridge
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user status pi.service   # active (running)
XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u pi.service --no-pager | grep 'slash commands' | tail -1
                                                          # "registered 6 slash commands"  [verified]
cd ~/projects/recall && bun recall query "ping"           # scored rows (or "no results" on an empty db)  [verified]
ps aux | grep "pi-bg worker\|pi-bg reviewer" | grep -v grep | wc -l   # 0 before dispatching
```

Live Discord check: send a plain message to the channel → agent replies;
send `/help` → command list; send `stop` mid-run → `[-] stopped`.

## Discord commands

`stop` / `/stop`, `/help`, `/btw`, `/status`, `/reset`, `/restart`, `/undo`,
`/redo`, `/verbose`, `/compact`, `/model`, `/jobs`, `/todos`, `/sleep`,
plus `! <cmd>` shell passthrough. All output uses ASCII state tags
(`[ok]` `[!]` `[new]` `[queued]` `[-]`), no emoji.
Full reference: [docs/COMMANDS.md](docs/COMMANDS.md).

## Architecture (one-pager)

```
                 Discord
                    |  REST polling (5s) + gateway (presence)
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
                      |  pi-bg worker|reviewer [--worktree <ref>] "task"
                      v
        +---------------------------+
        |  role profiles            |  ~/.pi/agent-worker, ~/.pi/agent-reviewer
        |  cgroup escape            |  survives pi.service restart
        |  git worktrees            |  ~/.pi-bg-wt/<repo>/<id>, branch pi-bg/<id>
        +-------------+-------------+
                      |  on exit: webhook embed (status/verdict, brief,
                      |             webdrop prompt+output links)
                      v
                 Discord (callback channel) -- wakes the orchestrator as a new turn
```

- **bridge → Discord**: polls inbound messages, injects a `<channel-ctx>`
  block, forwards agent output back (chunked, threaded, ping-suppressed).
  Bot traffic is exempt (no echo loops).
- **pi-bg dispatch loop**: the orchestrator keeps its KV lean by handing
  context-hungry work to worker/reviewer profiles. Default flow is
  fire-and-forget — the webhook callback is the wake. In-turn `pi-wait`
  is the opt-in exception (short task, human beats every wait).
  Full protocol: [docs/DISPATCH.md](docs/DISPATCH.md).
- **recall**: every RAG query goes through the single `search()` SQL
  function (reciprocal-rank fusion of vector + FTS). Ingest is idempotent
  (upsert on sha256, prune on by default).

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
MEMORY.md, Makefile, pre-commit hooks, CI, PR/issue templates, docs
scaffold), `git init -b main` + initial commit. Idempotent: refuses to
clobber without `--force`; `--dry-run` prints the plan. See
`templates/README.md`.

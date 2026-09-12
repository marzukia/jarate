# SETUP — bare box → working pi Discord agent

Verified end-to-end against the reference box (<host-a>, Fedora 42
x64, agent user `monky`, `node v22.22.2`, `bun 1.4.2`, `pi 0.85.1`) and
line-by-line against the code in this repo. Every file, flag, and env var
named here exists. Steps marked `[verified]` were run on the ref box;
`[verify-on-fresh-box]` = reconstructed from ref box state.

```
1  prerequisites
2  Discord application + bot token (intents, invite, IDs)
3  clone + ./install.sh
4  pi setup: settings.json + models.json
5  pi.service (systemd user unit)
6  first-run verification
7  dispatch setup (pi-bg callback webhook)
8  RAG (optional, packages/recall)
9  auto-deploy timer (optional)
```

## 1. Prerequisites

- Linux with cgroup v2 + systemd user sessions (Fedora/Ubuntu fine)
- `git`, `python3` (pi-bg embed builder, pi-wait message classification),
  `jq` (checklist + agent-say), `curl`, `sshpass` (only for the recall
  integration test's admin route)
- Node ≥ 20 + npm (pi is a node CLI)
- bun ≥ 1.4 (bridge deps, recall CLI, biome)
- A Discord application + bot token (step 2)
- An LLM endpoint: local vLLM/llama.cpp behind an OpenAI-compatible API, or
  a hosted provider (step 4)
- For RAG (optional): PostgreSQL with `pgvector` + an Ollama host running
  `nomic-embed-text` (step 8)

Install pi and bun under a `~/.local` npm prefix (ref box layout):

```bash
npm config set prefix ~/.local
npm install -g @earendil-works/pi-coding-agent   # pi  [verify-on-fresh-box]
npm install -g bun                               # bun (npm bun works)  [verify-on-fresh-box]
# ensure ~/.local/bin is on PATH in ~/.bashrc
pi --version   # expect 0.8x.x  [verified: 0.85.1]
bun --version  # expect 1.4.x   [verified: 1.4.2]
```

## 2. Discord application + bot token

1. [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application** → copy the **Application ID** (`<APP_ID>`).
2. **Bot** tab → **Reset Token** → copy the token (`<BOT_TOKEN>`).
3. **Bot** tab → **Privileged Gateway Intents** → enable all four that the
   bridge sets in `packages/bridge/channel/discord.ts`
   (`GATEWAY_INTENTS = 1 | 1<<9 | 1<<12 | 1<<15`):

   - `SERVERS` (GUILDS, bit 0) — guild list + channel resolution
   - `SERVER MESSAGES` (GUILD_MESSAGES, bit 9) — MESSAGE_CREATE/UPDATE/DELETE events
   - `MESSAGE CONTENT` (bit 12) — required to read message text
   - `VOICE STATES` (GUILD_VOICE_STATES, bit 15) — set in the intent mask; keep enabled

   (No other privileged intents are set — e.g. members is not required.)

4. Invite to your server:
   `https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=127760&scope=bot`
   (127760 = view channels + send messages + read history + attach files +
   embed links; a lower value like 512 grants only STREAM and the bot
   cannot see the channel.) `[verify-on-fresh-box]`
5. Collect the IDs the config needs (Discord settings → Advanced →
   Developer Mode):

   - **channel ID** — right-click a channel → Copy Channel ID
     (`<DISCORD_CHANNEL_ID>`)
   - **your user ID** — right-click your avatar → Copy User ID
     (`<YOUR_DISCORD_USER_ID>`)
   - **webhook** (step 7) — right-click channel → Edit Channel →
     Integrations → New Webhook → Copy Webhook URL
     (`<WEBHOOK_URL>` = `https://discord.com/api/webhooks/<id>/<token>`)

## 3. Clone + `./install.sh`

```bash
git clone https://github.com/marzukia/jarate.git ~/projects/jarate
cd ~/projects/jarate
./install.sh --dry-run    # print the plan, change nothing  [verified]
./install.sh              # [verify-on-fresh-box on first run; verified with
                          # an existing checkout: pull --ff-only + bun install]
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

Guarantees (script header): never touches `~/.pi/agent/settings.json`,
never restarts or kills pi, never copies repo files. It ends by printing
the `packages` line to set and a restart reminder. Regression check:
`HOME=/tmp/fake bash install.sh --dry-run` exits 0 `[verified]`.

## 4. pi setup: `~/.pi/agent/`

### 4.1 `settings.json` — bridge package + discord channel

The bridge reads its config from `channels[]` in
`~/.pi/agent/settings.json`. **The bot token lives in `botToken` inside the
channel object** — that is what the bridge (`packages/bridge`) reads.
`$PI_BOT_TOKEN` is an override only for `bin/agent-say` and dispatch
helpers, not for the bridge itself. Field reference:
[packages/bridge/README.md](../packages/bridge/README.md) (`channel`,
`botToken`, `ownerUserId` = who may run owner commands, `default`,
`startupMessage`, `ack`, `forwardToolCalls`, `peerBotIds`).

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
      "forwardToolCalls": true,
      "ack": false
    }
  ]
}
```

`packages` is the line install.sh prints for you — it tells pi to load
`@jarate/bridge` (its `package.json` declares `pi.extensions` +
`pi.skills`).

### 4.2 LLM endpoint — `models.json`

pi picks up custom providers from `~/.pi/agent/models.json` (pi docs:
`docs/models.md`, `docs/custom-provider.md` inside the pi install).
Configurable — nothing in jarate bakes in a model host. Ref box runs a
local vLLM behind an OpenAI-compatible endpoint:

```json
{
  "providers": {
    "hydrogen": {
      "name": "Hydrogen (vLLM)",
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
the same way — put their API key in an env file that the unit loads
(step 5, `EnvironmentFile`).

## 5. `pi.service` (systemd user unit)

Copy-paste unit (ref box unit redacted to what a fresh box needs; adjust
the user home paths):

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
# EnvironmentFile=~/.hermes/.env
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
systemctl --user daemon-reload                          # [verify-on-fresh-box]
systemctl --user enable --now pi.service                # [verify-on-fresh-box]
loginctl enable-linger <agentuser>   # run without an active login; [verify-on-fresh-box]
```

**XDG_RUNTIME_DIR**: `systemctl --user` / `journalctl --user` need
`XDG_RUNTIME_DIR=/run/user/$(id -u)` set when invoked outside the user's
own login session (cron, other users, ssh one-liners). Inside the agent
user's normal session it is already set.

`pi -c --mode rpc` continues the last session in RPC mode; `tail -f
/dev/null` holds stdin open for the lifetime of the unit.

**Unit name:** the bridge's `/restart` does not hardcode `pi.service`
(issue #28). It resolves the unit from `$PI_SERVICE`, else the
`systemdUnit` field in `settings.json` (same cascade as `channels`),
else `pi.service`. On a unit with a different name, add
`"systemdUnit": "<your-unit>.service"` to `~/.pi/agent/settings.json`
(or set `Environment=PI_SERVICE=<unit>` in the unit file).

## 6. First-run verification

The agent never restarts `pi.service` itself — a human (or the deploy
timer, step 9) does. After steps 4–5, or any bridge change:

```bash
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service
XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u pi.service --no-pager \
  | grep 'slash commands' | tail -1
```

Expected (ref box, `[verified]` today): a recent line
`registered 0 slash commands in guild <name>`. The bridge runs text-only
mode since 2026-09-09 — it registers no Discord slash commands; the line
proves the bridge booted the interaction registrar. Then message the
channel on Discord — the bridge should reply.

Full checklist (command → expected), run as the agent user:

```bash
pi --version                                              # 0.8x.x  [verified: 0.85.1]
bun --version                                             # 1.4.x   [verified: 1.4.2]
test -L ~/scripts/pi-bg && readlink ~/scripts/pi-bg       # -> <jarate>/dispatch/pi-bg
test -L ~/projects/recall && readlink ~/projects/recall   # -> <jarate>/packages/recall
HOME=/tmp/fake bash install.sh --dry-run; echo $?         # 0, nothing changed
jq -e '.packages[0]' ~/.pi/agent/settings.json            # ends /packages/bridge
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user status pi.service   # active (running)
cd ~/projects/recall && bun recall query "ping"           # scored rows (or empty-db note)
ps aux | grep "pi-bg worker\|pi-bg reviewer" | grep -v grep | wc -l   # 0 before dispatching
```

Live Discord check: send a plain message to the channel → agent replies;
send `/help` → command list; send `stop` mid-run → `[-] stopped`.

## 7. Dispatch setup (`pi-bg` / `pi-wait`)

The symlinks from step 3 are the whole install. Remaining pieces, all
one-time:

1. **Callback webhook.** `pi-bg` reads `$PI_DISPATCH_WEBHOOK` first, else
   the file below. **No file = no callback, and `pi-bg` says so loudly at
   dispatch time** (`no completion callback; poll with pi-wait`) and marks
   the run record `delivery=none` (issue #30):

   ```bash
   mkdir -p ~/.config/pi-dispatch
   echo "<WEBHOOK_URL>" > ~/.config/pi-dispatch/webhook        # https://discord.com/api/webhooks/<id>/<token>
   echo "<WEBHOOK_ID>"  > ~/.config/pi-dispatch/webhook_author # the webhook id (<id> part)
   chmod 600 ~/.config/pi-dispatch/webhook*
   ```

   `pi-wait` requires `webhook_author` to recognize the callback message
   (exit 2 without it).
2. **Role profiles.** `pi-bg` auto-seeds a missing `~/.pi/agent-worker` /
   `~/.pi/agent-reviewer` from the main agent's `auth.json`/`models.json`
   plus the repo template `dispatch/profiles/<role>.json` (issue #29).
   If no provider creds resolve it fails at dispatch (exit 4) with the
   exact files to copy — never a silent empty run.
3. **python3** on PATH (embed body builder, pi-wait classification).
4. **webdrop** (optional): if `webdrop` is on PATH, every dispatch also
   gets 7d prompt/output links in the callback embed.

Then dispatch:

```bash
cd <workdir>
nohup ~/scripts/pi-bg worker "self-contained task" > stdout.log 2>&1 &
```

Fleet caps, cgroup escape, worktree flow, `pi-wait` exit codes, reviewer
verdict protocol: [DISPATCH.md](DISPATCH.md).

## 8. RAG (optional, `packages/recall`)

Full runbook: [PGRAG-SETUP.md](PGRAG-SETUP.md). Short version:

1. **DB** (Postgres host, as postgres): role + db `rag` + loopback-only
   scram line in `pg_hba.conf` + `psql -f <jarate>/packages/recall/schema.sql`
   (vector(768), HNSW + GIN indexes, the `search()` fusion function).
2. **Embeddings**: an Ollama host with `ollama pull nomic-embed-text`.
   MUST be 768-dim (schema contract) — verify with a live embeddings call
   before ingesting. Point recall at it with `RAG_EMBED_URL`
   (default `http://localhost:11434/v1/embeddings`).
3. **Password**: `~/.pgpass` line
   `127.0.0.1:5432:rag:<user>:<password>` (chmod 600). DSN via `RAG_DSN`
   (default `host=127.0.0.1 dbname=rag user=monky`).
4. **CLI** (no venv; `~/projects/recall` is the install.sh symlink):

   ```bash
   cd ~/projects/recall
   bun recall ingest ~/memory ~/projects ~/AGENTS.md   # idempotent, prunes orphans
   bun recall query "your question"
   RAG_PROJECT=<project> bun recall query "filtered"
   ```

   The integration test's ssh+sudo admin route is env-configured:
   `RECALL_PG_ADMIN_USER` / `RECALL_PG_ADMIN_PASS` / `RECALL_PG_ADMIN_HOST`
   (no committed default password; unset pass = suite skips).
5. **Gotchas**: wrong-dim model = full re-embed; embed host down = recall
   down (Postgres untouched). `install.sh` never touches the database.

## 9. Auto-deploy timer (optional)

`deploy/deploy.sh` — timer-driven, idempotent, health-gated,
auto-rollback. Runs fetch → pull → typecheck → test → restart
pi.service → health gate (≤90s) → on fail: `git reset --hard` to the
previous commit, restart, re-gate once.

The committed units (`deploy/jarate-deploy.service`,
`deploy/jarate-deploy.timer`) carry ref-box paths
(`/home/monky/projects/jarate`); generalize for your box:

```bash
J=~/projects/jarate
sed "s#/home/monky/projects/jarate#$J#g" \
  deploy/jarate-deploy.service > ~/.config/systemd/user/jarate-deploy.service
cp deploy/jarate-deploy.timer ~/.config/systemd/user/jarate-deploy.timer
systemctl --user daemon-reload
systemctl --user enable --now jarate-deploy.timer
```

The service is `Type=oneshot` with a 30s timer (1s accuracy); deploy.sh
sets `PATH` (bun) and `XDG_RUNTIME_DIR` itself, so no Environment keys are
needed. State/lock/logs are gitignored (`.deploy-state`,
`$HOME/.local/share/jarate/logs`). Manual run: `deploy/deploy.sh`
(`FORCE=1` to deploy even when up to date).

## Per-agent conventions (not installed by this repo)

- `~/AGENTS.md` is **per-agent, hand-authored** — `install.sh` never writes
  it. It carries identity, environment facts, people, memory conventions,
  dispatch rules, cardinal rules. The ref box's
  (`/home/monky/AGENTS.md`) is a working reference for the *structure*.
- `~/memory/` — one file per session, `YYYY-MM-DD-<short-slug>.md`, with
  `## people / ## decisions / ## follow-ups` sections.
- `~/.pi/agent/skills/` — optional per-agent pi skills. The bridge ships
  one itself: `packages/bridge/skills/channel`.
- `bin/agent-say <channel-id> "message"` — agent-to-agent messaging; token
  auto-read from `~/.pi/agent/settings.json` (`$PI_BOT_TOKEN` overrides).

## Web search (Tavily, via MCP)

Pi gets `tavily_search` / `tavily_extract` / `tavily_research` / `tavily_crawl` /
`tavily_map` from the remote Tavily MCP server, bridged by the bundled
`extensions/mcp-tools.ts` (a generic MCP-over-streamable-HTTP client; no npm
deps beyond pi's).

1. **Key**: create one at https://app.tavily.com (free dev tier, `tvly-dev-...`),
   or use a shared key handed to you.
2. **Extension**: `cp <jarate-clone>/extensions/mcp-tools.ts ~/.pi/agent/extensions/`
3. **Config**: add to `~/.pi/agent/settings.json` (merge, don't clobber):
   ```json
   { "mcp": [ { "name": "tavily",
       "url": "https://mcp.tavily.com/mcp/?tavilyApiKey=<KEY>" } ] }
   ```
   The key rides in the query string - the MCP server takes no headers.
4. **Restart**: `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service`
5. **Verify**: ask the agent "search tavily for the latest pi coding agent release"
   - a working `tavily_search` call means the bridge registered the tools.

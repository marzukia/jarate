# SETUP — bare box → working pi Discord agent

`jarate setup` is the one-command FTUE: dry-run by default (prints the plan,
zero network, zero writes), `--yes` executes it. Everything the command can
do is automated; the human parts are small and listed in §1.

```
1  what you need from a human
2  run it
3  what it does
4  what it does not do (next steps)
5  verification checklist
6  manual fallback
7  ops notes
```

## 1. What you need from a human

All of this is portal- or brain-work — not derivable from (token, channel),
so no command can do it for you:

1. **Discord application + bot token.**
   [Developer Portal](https://discord.com/developers/applications) → New
   Application → copy the **Application ID**; Bot tab → **Reset Token** →
   copy `<BOT_TOKEN>`.
2. **Privileged Gateway Intents** (Bot tab) — portal-only, no REST endpoint:
   - SERVER MESSAGES (`1<<9`)
   - MESSAGE CONTENT (`1<<12`)
   - VOICE STATES (`1<<15`)

   (The bridge mask is `1 | 1<<9 | 1<<12 | 1<<15`; GUILDS `1<<0` is not
   privileged and needs no toggle.)
3. **Invite the bot to a guild** — OAuth2 click:
   `https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=2228048&scope=bot`
   2228048 = MANAGE_CHANNELS, ADD_REACTIONS, PRIORITY_SPEAKER, STREAM,
   VIEW_CHANNEL, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS, EMBED_LINKS,
   ATTACH_FILES, READ_MESSAGE_HISTORY, MENTION_EVERYONE, **MANAGE_WEBHOOKS
   (`1<<21`)**. `MANAGE_WEBHOOKS` is the bit that lets the bot create its own
   callback webhook; without it, pass `--webhook-url` (create the webhook by
   hand: channel → Integrations → New Webhook). Minimum mask if you trim:
   VIEW_CHANNEL + SEND_MESSAGES + MANAGE_WEBHOOKS = 2099224.
4. **The IDs** (Discord settings → Advanced → Developer Mode):
   - **channel ID** — right-click a *guild text channel* → Copy Channel ID.
     DMs do not work (webhook callbacks need a guild channel).
   - **your user ID** — right-click your avatar → Copy User ID → `--owner`.
5. **LLM endpoint** — an OpenAI-compatible base URL + model id + API key
   (local vLLM/llama.cpp or hosted). The unit template loads optional keys
   from `~/.hermes/.env` (`EnvironmentFile=-%h/.hermes/.env`).
6. **The box** — Linux with cgroup v2 + systemd user sessions; `git`,
   `python3`, `jq`, `curl` on PATH; Node ≥ 20 + bun ≥ 1.4 with
   `~/.local/bin` on PATH, `pi` and `bun` installed:

   ```bash
   npm config set prefix ~/.local
   npm install -g @earendil-works/pi-coding-agent
   npm install -g bun
   ```

   `jarate setup` checks all of this and says exactly what is missing.
7. **`loginctl enable-linger <agentuser>`** — needs root/polkit. The command
   tries it and notes the failure; do it by hand for survival across
   reboots.

## 2. Run it

```bash
git clone https://github.com/marzukia/jarate.git ~/projects/jarate

# dry run: prints the full plan on stderr, writes nothing, no network
bash ~/projects/jarate/bin/jarate setup <BOT_TOKEN> <CHANNEL_ID> \
  --owner <YOUR_USER_ID> \
  --name <agentname> \
  --model-base http://127.0.0.1:8081/v1 --model-id <model> --model-key <key>

# looks right? execute it
bash ~/projects/jarate/bin/jarate setup <BOT_TOKEN> <CHANNEL_ID> \
  --owner <YOUR_USER_ID> \
  --name <agentname> \
  --model-base http://127.0.0.1:8081/v1 --model-id <model> --model-key <key> \
  --yes
```

Options (all optional):

| flag | meaning |
| --- | --- |
| `--yes` | execute (default is dry-run) |
| `--name N` | agent name (default: login name). Used in the unit `Description` and the channel entry `id`/`name` |
| `--jarate-dir D` | checkout location (default `~/projects/jarate`; cloned from `https://github.com/marzukia/jarate.git` if absent) |
| `--owner UID` | operator Discord user id → `ownerUserId` (who may run owner commands) |
| `--webhook-url U` | use an existing `https://discord.com/api/webhooks/<id>/<token>` instead of creating one |
| `--model-base URL` / `--model-id ID` / `--model-key KEY` | LLM provider → `models.json` + `defaultProvider`/`defaultModel` (provider id = `host:port` of the base URL). Omit and the agent boots, but LLM calls fail until you re-run with them |
| `--model-headers JSON` | extra provider headers, e.g. `'{"Authorization":"Bearer x"}'` |
| `--no-units` / `--no-verify` | skip systemd install / skip the 90s boot gate |

Output discipline: one JSON doc on stdout (machine), human progress on
stderr. Exit codes: 0 ok, 1 setup failed, 2 usage.

## 3. What it does (in order)

1. dep check (git, jq, python3, curl; notes bun/pi if missing)
2. `GET /users/@me` — validates the token, records the bot id
3. `GET /channels/<id>` — validates the channel; rejects DMs with a hint
4. clone/checkout `~/projects/jarate` + `./install.sh` (idempotent; symlinks
   `pi-bg`/`pi-wait`/`agent-say`/`recall`, `bun install` in the bridge)
5. merge `~/.pi/agent/settings.json`: bridge `packages` entry, the channel
   entry (replaced **in place** by channel id — re-runs never duplicate),
   `defaultProvider`/`defaultModel` when a model was given. Timestamped
   `.bak` first, file chmod 600
6. merge `~/.pi/agent/models.json`: add/replace the provider, keep others
7. callback webhook: reuse an existing "Jarate" webhook in the channel
   (verified by reading its token), else create one (repo icon as avatar,
   retry without avatar on rejection); writes
   `~/.config/pi-dispatch/webhook` + `webhook_author` (600).
   `--webhook-url` skips the API
8. units from `deploy/` + `dispatch/` templates — `%h` specifiers, so the
   same files work for any user: `pi.service` (name substituted into
   `Description`, jarate path → checkout), `jarate-deploy.{service,timer}`,
   `pi-bg-watchdog.{service,timer}` → `~/.config/systemd/user/`;
   `daemon-reload`, `enable-linger` (note on failure), `enable --now`
9. boot gate (≤90s): `pi.service` active **and** the journal shows
   `[interactions] registered` — the same signal `deploy.sh` trusts. On
   failure it prints the journal tail + the usual suspects (intents, invite
   mask, token)
10. report: JSON doc with bot id, webhook id, units, verified, and the
    remaining manual steps

## 4. What it does not do (next steps)

Per-agent, hand-authored — see the ref box's `~/AGENTS.md` for the
structure:

- `~/AGENTS.md` identity (who you are, people, rules)
- `~/memory/` conventions (one file per session,
  `## people / ## decisions / ## follow-ups`)

Optional, runbooks in this repo:

- **RAG** — [PGRAG-SETUP.md](PGRAG-SETUP.md): Postgres + pgvector, Ollama
  `nomic-embed-text` (768-dim), `bun recall ingest/query`
- **Web search (Tavily)** — `cp extensions/mcp-tools.ts
  ~/.pi/agent/extensions/` + a `tavilyApiKey` in settings.json `mcp[]`
  (key in the query string; restart after)
- **Peers** — [NEW-AGENT.md](NEW-AGENT.md) §8: invite bots to each other's
  guilds + `peerBotIds` in settings.json; `bin/agent-say` for messaging
- **Fleet ops** — [DISPATCH.md](DISPATCH.md): caps, worktrees, `pi-wait`

## 5. Verification checklist

Run as the agent user (`XDG_RUNTIME_DIR=/run/user/$(id -u)` when outside
your own session):

```bash
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user status pi.service   # active (running)
XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u pi.service --no-pager \
  | grep 'interactions' | tail -1    # registered ... in guild <name>
test -L ~/scripts/pi-bg && readlink ~/scripts/pi-bg   # -> <jarate>/dispatch/pi-bg
jq -e '.packages[]' ~/.pi/agent/settings.json         # ends /packages/bridge
```

Then on Discord: message the channel → the agent replies; `/help` → command
list. `stop` mid-run → `[-] stopped`.

## 6. Manual fallback

Only if `bin/jarate` itself is broken. With a checkout:

```bash
git clone https://github.com/marzukia/jarate.git ~/projects/jarate
cd ~/projects/jarate
./install.sh --dry-run && ./install.sh
```

1. **settings.json** (`~/.pi/agent/settings.json`, 600) — merge, don't
   clobber; field reference in
   [packages/bridge/README.md](../packages/bridge/README.md):

   ```json
   {
     "defaultProvider": "<host:port>",
     "defaultModel": "<model>",
     "packages": ["<jarate-checkout>/packages/bridge (absolute path)"],
     "channels": [{
       "id": "discord-<name>", "name": "<NAME>", "type": "discord",
       "enabled": true, "channel": "<CHANNEL_ID>",
       "botToken": "<BOT_TOKEN>", "default": true,
       "ownerUserId": "<YOUR_USER_ID>",
       "forwardToolCalls": true, "ack": false
     }]
   }
   ```

2. **models.json** (`~/.pi/agent/models.json`) — same shape as what
   `jarate setup` writes (provider with `baseUrl`, `api:
   openai-completions`, `apiKey`, one model with `contextWindow`).

3. **Units** — the templates are user-agnostic (`%h`):

   ```bash
   U=~/.config/systemd/user
   mkdir -p "$U"
   sed "s#__AGENT_NAME__#$(id -un)#g" deploy/pi.service > "$U/pi.service"
   sed "s#%h/projects/jarate#$PWD#g" deploy/jarate-deploy.service > "$U/jarate-deploy.service"
   cp deploy/jarate-deploy.timer dispatch/pi-bg-watchdog.service \
      dispatch/pi-bg-watchdog.timer "$U"/
   systemctl --user daemon-reload
   loginctl enable-linger "$(id -un)"     # needs root
   systemctl --user enable --now pi.service jarate-deploy.timer pi-bg-watchdog.timer
   ```

   Note the sed for `jarate-deploy.service`: the template carries
   `%h/projects/jarate` as its default checkout; point it at yours if it
   differs.

4. **Webhook** — same files as §3.7, by hand.

5. Verify with the §5 checklist.

## 7. Ops notes

- **XDG_RUNTIME_DIR**: `systemctl --user` / `journalctl --user` need
  `XDG_RUNTIME_DIR=/run/user/$(id -u)` when invoked outside the user's own
  login session (ssh one-liners, other users). Inside a normal session it
  is already set.
- **Unit name**: the bridge's `/restart` resolves the unit from `$PI_SERVICE`,
  else `systemdUnit` in settings.json, else `pi.service`. Rename the unit →
  set one of the first two.
- **Optional env files** in systemd units must be dash-prefixed:
  `EnvironmentFile=-%h/.hermes/.env`. A missing file *without* the dash is
  fatal — the unit never starts.
- **Restart policy**: the agent never restarts `pi.service` itself. After
  any bridge change: `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user
  restart pi.service`, then the §5 grep. The `jarate-deploy` timer does this
  automatically for repo changes (idempotent, health-gated, auto-rollback).
- **`pi -c --mode rpc`** continues the last session in RPC mode; the unit's
  `tail -f /dev/null` holds stdin open (RPC mode exits on stdin EOF).
- `bin/jarate setup` is safe to re-run: everything is idempotent (channel
  entry replaced by id, packages de-duplicated, webhook reused, units
  rewritten from templates).

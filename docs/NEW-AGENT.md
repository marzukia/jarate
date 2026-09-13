# NEW-AGENT.md - onboarding a new pi agent on hydrogen

Runbook for adding a new Discord agent to the fleet (pi + jarate bridge +
switchboard). Proven end-to-end with **jimmy** (2026-09-13). ~45 minutes of
actual work; most of it is waiting on npm.

## 0. Prerequisites (ask the operator)

- [ ] A Discord bot token for the new agent (developer portal).
- [ ] A Discord channel for the agent (id, e.g. `<channel-id-3>`).
- [ ] A pi-bg callback webhook for that channel.
- [ ] Switchboard key params: ctx budget (tokens), concurrency cap (1-8),
      priority (P0 senior, P1 new).
- [ ] Who may talk to it: by default EVERYONE in the channel (no whitelist
      feature in the bridge). Owner commands gated by `ownerUserId`.

Bot guild access (gotcha): for agent-say to work BOTH ways, the new bot must
be in every peer's server AND every peer bot must be in the new bot's
server. The operator invites the bots; tokens alone do not grant server
membership.

## 1. Unix user

```bash
# as root (sudo):
useradd -m -s /bin/bash <name>
echo <name>:<password> | chpasswd
loginctl enable-linger <name>   # user units start at boot
```

Fleet convention: password `[REDACTED-2026-09-13]` (same as the andryo sudo chain).
Note the uid - XDG_RUNTIME_DIR=/run/user/<uid> is needed for every
`systemctl --user` call as another user.

## 2. Switchboard key

```sql
-- psql -h 127.0.0.1 -U switchboard -d switchboard
INSERT INTO api_keys (key, name, concurrency_cap, ctx_budget_tokens,
                      enabled, created_ms, updated_ms)
VALUES ('sbk_<name>_<16 hex>', '<name>', <cap>, <budget>, true,
        EXTRACT(EPOCH FROM now())::bigint * 1000,
        EXTRACT(EPOCH FROM now())::bigint * 1000);
```

Budget = ctx window in tokens (262144 = 262K, 405504 = 396K).
`concurrency_cap` is enforced (402/503 on breach) - the header
`X-Switchboard-Context` and the key budget must agree or you get surprise
rejections.

## 3. Toolchain (as the new user)

```bash
sudo -u <name> bash -lc '
  npm install --prefix /home/<name>/.local -g bun @earendil-works/pi-coding-agent'
# verify: /home/<name>/.local/bin/pi --version (match the fleet version)
```

node is system-wide (/usr/bin/node) - no per-user step.

## 4. Per-user config files

| file | contents |
|---|---|
| `~/.config/marzukia-pat` | Andryo's PAT (copy from an existing agent, chmod 600) - GitHub for now |
| `~/.config/pi-dispatch/webhook` | the pi-bg callback webhook, first line, chmod 600 |
| `~/.config/webdrop/config.toml` | copy from an existing agent |
| `~/.hermes/.env` | copy from an existing agent (OPENROUTER key; credits may be $0 - the LLM does NOT use it, only image gen) |
| `~/.pi/agent/settings.json` | see below |
| `~/.pi/agent/models.json` | see below |
| `~/.pi/agent/AGENTS.md` | identity + roster + rules (copy an existing one, rewrite identity/roster) |
| `~/.config/systemd/user/pi.service` | see below |
| `~/.pi/agent-worker/settings.json` | **THE TRAP** - see step 6 |
| `~/.pi/agent-reviewer/settings.json` | **THE TRAP** - see step 6 |

### settings.json (channel block)

```json
{
  "defaultProvider": "hydrogen",
  "defaultModel": "qwen3.8-27b",
  "packages": ["/home/<name>/projects/jarate/packages/bridge"],
  "channels": [{
    "id": "<name>",
    "name": "<NAME>",
    "type": "discord",
    "enabled": true,
    "channel": "<channel-id>",
    "botToken": "<bot-token>",
    "default": true,
    "ownerUserId": "<user-id-1>",
    "forwardToolCalls": false,
    "ack": false,
    "bufferFileOnly": false,
    "startupMessage": "<name> (pi) online - 262K ctx, switchboard/hydrogen",
    "peerBotIds": ["<every other agent's bot user id>"]
  }],
  "mcp": [{ "name": "tavily", "url": "<shared tavily mcp url from an existing agent>" }],
  "defaultThinkingLevel": "medium",
  "httpIdleTimeoutMs": 0
}
```

### models.json (switchboard provider)

```json
{ "providers": { "hydrogen": {
  "name": "Hydrogen (switchboard)",
  "baseUrl": "http://127.0.0.1:8081/v1",
  "api": "openai-completions",
  "apiKey": "sbk_<name>_<hex>",
  "headers": {
    "X-Switchboard-Session": "pi-<name>",
    "X-Switchboard-Agent": "<name>",
    "X-Switchboard-Context": "<budget>",
    "X-Switchboard-Project": "<name>",
    "X-Switchboard-Priority": "P1"
  },
  "models": [{ "id": "qwen3.8-27b", "name": "Qwen3.8 27B",
    "reasoning": true, "input": ["text", "image"],
    "contextWindow": <budget>, "maxTokens": 16384,
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
    "compat": { "thinkingFormat": "qwen-chat-template" } }]
}}}
```

Copy the model block verbatim from an existing agent's models.json.

### pi.service

```ini
[Unit]
Description=pi coding agent (<NAME>) with Discord channel bridge
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=/home/<name>
Environment=PATH=/home/<name>/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--heapsnapshot-near-heap-limit=1
EnvironmentFile=/home/<name>/.hermes/.env
WorkingDirectory=/home/<name>
ExecStart=/bin/bash -c 'tail -f /dev/null | /home/<name>/.local/bin/pi -c --mode rpc'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Gotcha: `EnvironmentFile=~/.hermes/.env` is SILENTLY IGNORED by systemd
(path must be absolute). `tail -f /dev/null |` keeps stdin open - RPC mode
exits on stdin EOF. `pi -c` = continue latest session (persistence).

## 5. jarate checkout + bootstrap

```bash
sudo -u <name> bash -lc '
  mkdir -p ~/projects && cd ~/projects
  git clone https://x-access-token:$(cat ~/.config/marzukia-pat)@github.com/marzukia/jarate.git
  cd jarate && ./install.sh'
```

install.sh (idempotent): `bun install` in the bridge, symlinks
`~/scripts/pi-bg`, `~/scripts/pi-wait`, `~/bin/agent-say`,
`~/projects/recall` into the checkout. The checkout IS the deployment -
`git pull --ff-only` is the update procedure. Only bridge changes need a
pi.service restart.

## 6. Role profiles - THE TRAP (bites every new agent)

pi-bg runs workers/reviewers under `PI_CODING_AGENT_DIR=~/.pi/agent-<role>`.
On a fresh home it SEEDS that dir from the main profile - **auth.json and
models.json only, NOT settings.json**. Without settings.json, pi falls back
to its built-in OpenRouter default and the worker 402s on the (often $0)
OpenRouter balance. Symptom: "worker died on a 402, thinking it's on
OpenRouter" while the main agent's LLM is fine (different key, different
path).

Fix (do it BEFORE the first pi-bg dispatch):

```bash
# for role in worker reviewer:
cat > ~/.pi/agent-<role>/settings.json <<EOF
{ "defaultProvider": "hydrogen", "defaultModel": "qwen3.8-27b",
  "defaultThinkingLevel": "<medium for worker, xhigh for reviewer>",
  "reserveTokens": 13107, "keepRecentTokens": 20000 }
EOF
```

models.json in the role dir is already seeded from main (same switchboard
key) - leave it. The repo's `dispatch/profiles/<role>.json` files are seed
TEMPLATES (thinking + reserve tokens only, no provider) - that is why the
seed misses the provider.

## 7. Start + verify

```bash
sudo -u <name> bash -lc 'XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user daemon-reload
  && XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user enable --now pi.service'
# journal: expect "[presence] READY as <BotName>"
XDG_RUNTIME_DIR=/run/user/<uid> journalctl --user -u pi.service -n 25
```

Verification checklist (all must pass before declaring done):
1. startup message appears in the channel.
2. LLM path: `SELECT status, count(*) FROM llm_requests WHERE agent='<name>' GROUP BY 1`
   -> only 200s, rows accumulating.
3. agent-say round trip from an existing agent into the new channel.
4. agent-say the OTHER way (needs the bot-guild invites from step 0).
5. One real pi-bg worker smoke run (`smoke test: reply OK`, 2-5s) - confirms
   webhook + role profile + artifacts.

## 8. Update every existing agent

For each existing agent (monky, frank, jimmy, ...):
- AGENTS.md roster: add the new agent (channel, bot id, user, uid, key,
  priority, onboard date).
- `~/.pi/agent/settings.json` channel block: add the new bot's user id to
  `peerBotIds` (otherwise agent-say from the new agent is silently dropped
  by the other-bot filter).
- Detached restart so the running agent survives:
  `(sleep 5; XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user restart pi.service) &`

## 9. webdrop CLI (optional, for file sharing)

```bash
sudo -u <name> bash -lc '
  uv python install 3.14   # uv downloads are "manual" on this box
  uv tool install --from /opt/stacks/webdrop webdrop --python 3.14'
# config already copied in step 4; verify: ~/.local/bin/webdrop --help
```

Skills: copy an existing agent's `~/.pi/agent/skills/` (machine-level docs:
webdrop, traefik-ops, erpnext, hydrogen-desktop, pi-token-cost,
github-invites, bootstrap-project).

## 10. Post-onboard notes

- Dispatch cap per agent: 3 (monky/frank), 2 (jimmy) - Andryo sets per agent.
- Fresh agents get latest bridge commands by pulling main + restarting their
  pi.service (new commands like /tasks, /diff only exist after the merge).
- /tmp on hydrogen is a 32G tmpfs: it wipes on reboot. pi-bg artifacts now
  live in ~/.pi-bg-art (PR #35); anything else you park in /tmp is volatile.
- OOM history: 13 Sep 2026, 11:24-11:49 kernel OOM slide wedged the box
  until a power reset (61 kills). Size new heavy units with memory caps.

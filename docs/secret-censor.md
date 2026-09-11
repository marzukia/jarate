# Secret egress censor

Owner ask (verbatim): "brainstorm and create a solution to censor all passwords
in keys in discord, you leak everything".

## The leak surface

The bridge (`packages/bridge`) posts agent output to Discord **verbatim**.
Agent turns echo whatever the LLM saw or produced:

- command output (`git log`, `env`, `cat` of configs)
- error payloads (stack traces, API errors with query strings)
- live-tick status lines (built from in-flight tool output)
- dispatch callbacks posted over webhooks (same channel text path)

Already observed in the wild: GitHub PATs (three of them, sitting in git
remote URLs under `~/projects`), the sudo/sshpass password (embedded in
`~/scripts/pi-token-cost.py`, echoed in any command run containing it),
provider API keys (Tavily, in the MCP URL in `~/.pi/agent/settings.json`),
the Discord bot token, and database DSNs. Anything that lands in context can
land in a reply.

## The choke point

Every outbound string that reaches the Discord API funnels through
`packages/bridge/channel/discord.ts`. The six text-bearing send functions:

| function | transport | text field |
|---|---|---|
| `sendDiscordMessage` | REST POST (bot) **or** webhook POST | `content` |
| `editDiscordMessage` | REST PATCH | `content` |
| `sendDiscordMessageWithFiles` | multipart POST | `payload_json.content` |
| `sendFilesToDiscord` | multipart POST | `payload_json` filenames |
| `respondToInteraction` | REST POST (slash callback) | `data.content` |
| `editInteractionMessage` | REST PATCH (deferred edit) | `content` |

Everything else is text-free (reactions, typing indicator) or inbound
(poll/gateway). `index.ts` has no direct `fetch` of its own — it only calls
the six functions above, so censoring inside them covers normal posts,
edits, tick placeholders, acks, and error payloads alike.

Design rule: one private helper, `egressText(text)`, wraps `censor(text)`
and **all six** functions call it before building their body. A test asserts
at source level that every text-bearing send function references
`egressText`, so a new egress path that forgets it fails CI.

Not covered by the bridge (separate processes, noted for later):
- `pi-bg` dispatch callback — posts directly to the pi-dispatch webhook
  (`~/.config/pi-dispatch/webhook`). The webhook URL itself is a credential
  and is in the registry; the callback body is agent output and can leak
  values too. Mitigation: keep the callback truncated + registry covers the
  known literals. A pi-bg-side censor is follow-up work.
- `agent-say` — posts the caller's message to a peer channel via webhook;
  same class of gap, same mitigation.

## Redaction strategy

`censor(text)` = two passes, in order:

### (a) REGISTRY — exact literals, longest first

Per-agent secret file: `~/.pi/agent/secrets.txt`
(override: `$JARATE_SECRETS_FILE`). One exact literal per line; `#` starts a
comment; blank lines skipped. Each line gets a stable index `N` (1-based,
file order). Matched text is replaced by `[REDACTED:secret#N]`.

Longest-first ordering matters: a short secret that is a substring of a
longer one (e.g. the password inside a `sshpass -p` command string) must not
eat the longer match. The registry catches the non-patternable ones —
actual passwords, webhook URLs, anything that does not match a known
prefix.

Missing file = empty registry = patterns only. Never an error: a fresh
agent box must still run with pattern-only redaction.

### (b) PATTERN — built-in classes, fixed order

| class | pattern (abridged) | tag |
|---|---|---|
| github | `ghp_/gho_/ghu_/ghs_/ghr_` + 16 alnum, `github_pat_` | `[REDACTED:github]` |
| gitlab | `glpat-` | `[REDACTED:gitlab]` |
| anthropic | `sk-ant-` | `[REDACTED:anthropic]` |
| openai | `sk-or-`, generic `sk-` + 20 alnum | `[REDACTED:openai]` |
| aws | `AKIA[0-9A-Z]{16}` | `[REDACTED:aws]` |
| google | `AIza[0-9A-Za-z_-]{35}` | `[REDACTED:google]` |
| slack | `xox[baprs]-` | `[REDACTED:slack]` |
| bearer | `Bearer <token>` | `Bearer [REDACTED:bearer]` |
| dsn | `postgres/redis/mysql/mongodb://user:pass@` (also `://:pass@`) | `scheme://[REDACTED:dsn]@` |
| sshpass | `sshpass -p <arg>` | `sshpass -p [REDACTED:sshpass]` |
| kv | `password/passwd/secret/token/api_key = v` anywhere; `key: v` when v is quoted or ≥6 chars | `key: [REDACTED:kv]` |

Replacements are **fixed strings** — the raw value never appears in the
output, and it is why the censor is idempotent (see below).

## Behavior

- **Never the raw value.** Only the class tag is emitted.
- **WARN on fire.** When a match occurs, the censor logs
  `[censor] registry secret#3 fp=phis…su (replaced 1x)` — fingerprint is
  first-4 + last-4 for registry entries (≤8 chars: just the length), class
  name only for patterns. Leaks stay debuggable without re-leaking. Each
  unique fingerprint is logged **once per process** so the live-tick edit
  loop does not spam.
- **Idempotent.** `censor(censor(x)) === censor(x)`: every replacement is a
  constant string that matches no later rule, so a second pass is a no-op.
  This is what makes tick-line re-censoring on every edit safe.
- **Pass-through.** Prose containing the *word* "password" (no
  `=`/`:`-separated value) is untouched, as are tick placeholders like
  `┣ working…`.

## Rollout

1. **monky first** (this host): `~/.pi/agent/secrets.txt` populated with the
   live credentials found on this box (sudo password, three GitHub
   PATs/RO tokens, Tavily key, Discord bot token, pi-dispatch webhook URL,
   vLLM placeholder key), `chmod 600`.
2. **frank second**: same file under `/home/frank/.pi/agent/secrets.txt`.
   Add secrets: append one literal per line, no quotes, `#` comments ok.
   No bridge restart needed — the registry is re-read when the file's
   mtime changes.
3. Config path is the default above; `$JARATE_SECRETS_FILE` overrides per
   environment (tests use a temp file, so the real registry never leaks
   into test output).
4. Bridge restart picks up the new code (`pi.service`).

## Test plan

`censor.test.ts` (~20 tests): one per pattern class, registry literal +
longest-first, registry missing-file, DSN, sshpass, code-block kv,
plain-word pass-through, idempotence, WARN-fingerprint shape (no raw value).
`discord.test.ts` choke-point test: source-level assert that all six
text-bearing send functions route through `egressText`.

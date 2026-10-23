# Secret egress censor

Owner ask (verbatim): "brainstorm and create a solution to censor all passwords
in keys in discord, you leak everything".

This doc covers **both** redaction engines: the egress **censor**
(`censor()` in `channel/censor.ts`, every string posted to Discord) and the
log **sanitizer** (`sanitizeSensitiveText()` in `channel/sanitize.ts`, every
error/log line the bridge writes). The two engines share ONE secret-pattern
table — see [Two engines, one table](#two-engines-one-table).

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

Out-of-bridge egress (outside the bridge process, not wrapped by
`egressText`):

- Peer-agent messages: agent-to-agent traffic flows through hall-monitor
  fleet comms (`POST /fleet/say`), an out-of-repo egress the censor does
  not wrap.

Known open (residual gaps, not covered by any process today):

- **webdrop artifacts** — jarate-bg uploads the FULL prompt + output files
  to webdrop; only the link lands in Discord. The files are readable by
  anyone with the URL. Acceptable while the TTL is 7d + random slugs;
  censoring them needs a webdrop-side hook.
- The registry protects only what the censor runs through: any NEW
  out-of-bridge process that posts raw text to Discord leaks until it is
  routed through `censor()` with the same registry.
  The guarantee scope is: **every Discord egress in this repo routes
  through `censor()`** — asserted for the bridge at source level (the
  chokepoint test) and structurally for jarate-bg (posts only the censored
  strings).

## Two engines, one table

Secret redaction runs in two places, and both consume the single shared
table in `packages/bridge/channel/secret-patterns.ts`:

| engine | module | where it runs | marker style |
|---|---|---|---|
| **egress** | `censor.ts` — `censor()` | every string posted to Discord (via `egressText`, see below) | `[REDACTED:<class>]` |
| **log** | `sanitize.ts` — `sanitizeSensitiveText()` / `sanitizeUnknownValue()` | log lines: poll/send error payloads, `console.error` sites in the channel code, error/stack recursion | `[REDACTED_*]` |

The audit that found the split (issue #254) showed the two engines had
kept private copies of the same leak surface and diverged: a real 36-char
`ghp_` PAT was redacted on egress but **not** in logs, while `AKIA`,
`glpat-`, `xox*`, `sbk_`, `github_pat_` and DSN were absent from logs
entirely. The table makes the split explicit data instead of two drifting
copies: every entry names exactly one engine (`scope: "log" | "egress"`),
its application `order`, the exact pattern (source + flags — the length
specifiers live here and only here), and the replacement. A pattern that
applies to both engines appears as **two entries** (one per scope), each
with its own spec where the engines differ. `secret-patterns.test.ts`
pins every entry (id, scope, order, source, flags, sub) plus the
divergences below, so neither engine can silently drift.

### The log-vs-egress split (per-pattern)

| family | log spec (sanitize) | egress spec (censor) |
|---|---|---|
| github | `gh[pousr]_` + 20+ alnum → `[REDACTED_GITHUB_TOKEN]` | `gh[pousr]_` + **exactly 36** alnum, or `github_pat_` + 22..255 word chars → `[REDACTED:github]` |
| openai `sk-` | 16+ alnum → `[REDACTED_OPENAI_KEY]` | `sk-or-` + 8+ or 20+ alnum → `[REDACTED:openai]`; `sk-ant-` + 8+ → `[REDACTED:anthropic]` |
| google `AIza` | 20+ → `[REDACTED_GOOGLE_KEY]` | **exactly 35** → `[REDACTED:google]` |
| bearer | case-insensitive, 10+ → `Bearer [REDACTED]` | case-sensitive, 8+ → `Bearer [REDACTED:bearer]` |
| discord bot token | `xxx.yyy.zzz` (20+ / 6 / 25+ word chars) → `[REDACTED_DISCORD_TOKEN]` | — (the live bot token is also in the registry) |
| key-value | query string `?key=v`, quoted `key: "v"`, bare `key=v`; keys: token/api_key/key/secret/password/authorization → `…[REDACTED]` | `key=v` (any value); `key: v` only when v is quoted (4+) or an unquoted 8+ run; keys: password/passwd/secret/token/api_key → `key=[REDACTED:kv]` |
| switchboard `sbk_` | — | 8+ (incl. markdown-escaped `sbk\_…`) → `[REDACTED:switchboard]` |
| gitlab `glpat-` | — | 8+ → `[REDACTED:gitlab]` |
| aws `AKIA` | — | exactly 16 → `[REDACTED:aws]` |
| slack `xox[baprs]-` | — | 10+ → `[REDACTED:slack]` |
| DSN `scheme://user:pass@` | — | `scheme://[REDACTED:dsn]@` (postgres/redis/mysql/mongodb/amqps) |
| `sshpass -p` | — | `sshpass -p [REDACTED:sshpass]` |

Why the specs differ: egress ships to Discord, so a false positive is a
visible mangled line — egress patterns pin the **exact token shape**
(36-alnum `ghp_`, exactly-35 `AIza`). Logs are read by the operator only;
over-redacting a log line costs nothing, so log patterns use **open
ranges** (20+, 16+) and add log-only shapes (Discord token, query-string
secrets). The split is today's behavior, preserved verbatim — if you want
a pattern in the other engine, add an entry for that scope (one line)
and extend the pin test.

Not a secret pattern: **path redaction** (`redactPaths: true` on
`sanitizeSensitiveText`) stays in `sanitize.ts` — it is flag-gated and
redacts home-directory paths, not credentials.

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

### (b) PATTERN — shared table, scope "egress", fixed order

The classes come from the shared table (`secret-patterns.ts`, scope
"egress", applied in ascending `order`; see
[Two engines, one table](#two-engines-one-table) for the full split).
Egress classes, in application order:

| class | pattern (abridged) | tag |
|---|---|---|
| github | `ghp_/gho_/ghu_/ghs_/ghr_` + exactly 36 alnum, `github_pat_` + 22..255 word chars | `[REDACTED:github]` |
| switchboard | `sbk_<name>_<16 hex>` house key (sbk_ + 8+ word chars) | `[REDACTED:switchboard]` |
| gitlab | `glpat-` | `[REDACTED:gitlab]` |
| anthropic | `sk-ant-` | `[REDACTED:anthropic]` |
| openai | `sk-or-`, generic `sk-` + 20 alnum | `[REDACTED:openai]` |
| aws | `AKIA[0-9A-Z]{16}` | `[REDACTED:aws]` |
| google | `AIza[0-9A-Za-z_-]{35}` | `[REDACTED:google]` |
| slack | `xox[baprs]-` | `[REDACTED:slack]` |
| bearer | `Bearer <token>` | `Bearer [REDACTED:bearer]` |
| dsn | `postgres/redis/mysql/mongodb://user:pass@` (also `://:pass@`) | `scheme://[REDACTED:dsn]@` |
| sshpass | `sshpass -p <arg>` | `sshpass -p [REDACTED:sshpass]` |
| kv | `password/passwd/secret/token/api_key = v` anywhere; `key: v` when v is quoted (>=4) or an unquoted run of >=8 chars | `key: [REDACTED:kv]` |

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
  `=`/`:`-separated value) is untouched, as are tick frames like
  `┌ working · 3 calls · 10s`.

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
`sanitize.test.ts`: log-engine behavior (bearer/openai/discord-token/query
kv/quoted kv/bare kv/path redaction/error recursion).
`secret-patterns.test.ts` (issue #254): pins the shared table — every entry
present with its scope + order + exact pattern source (length specifiers)
+ flags + replacement, no extra entries, per-entry boundary samples
(fires at threshold, quiet below), the preserved log/egress divergences
end to end, and source-level asserts that both engines consume the table.
A dropped pattern, a re-scoped entry, or a shortened specifier ({36} →
{30,}) fails this file.
`discord.test.ts` choke-point test: source-level assert that all text-
and filename-bearing send functions in `discord.ts` (exported or not) that
POST/PATCH a `content` body or a `payload_json` multipart call
`egressText`, plus a runtime test that a registry-literal filename is
redacted in the API-facing `payload_json`.

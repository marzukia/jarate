# Secret censor (log + egress)

Owner ask (verbatim): "brainstorm and create a solution to censor all passwords
in keys in discord, you leak everything".

Two redaction engines, one shared pattern table (issue #254):

- **egress** — `censor()` (`packages/bridge/channel/censor.ts`) redacts every
  string the bridge posts to Discord.
- **log** — `sanitizeSensitiveText()` / `sanitizeUnknownValue()`
  (`packages/bridge/channel/sanitize.ts`) redact what the bridge writes to
  its own logs (TUI / journal): error payloads, capped tool output, status
  lines.

Both engines consume the same table —
`packages/bridge/channel/secret-patterns.ts` — filtered by a per-pattern
scope (`both` / `log` / `egress`), so the two cannot silently diverge.
See "Shared pattern table" below.

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

The same content also lands in the bridge's own logs: poll/send errors,
stack traces, and capped tool output are written to the TUI and the journal.
A log leak is less visible (local file) but puts the same credential in a
place humans grep — which is why the log engine exists at all.

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

Log side: there is no single funnel — every log site wraps its own value.
Two entry points cover it: `sanitizeSensitiveText(line)` for strings (error
messages, and the capped-tool-output path in `index.ts`, which also passes
`redactPaths: true`) and `sanitizeUnknownValue(e)` for errors/objects/
arrays (recursive, depth-limited, cycle-safe). Both take the shared table's
log scope; a new log site that forgets them leaks into the journal.

Not in the bridge process, but censored via the **jarate-censor CLI**
(`bin/jarate-censor`, bun): `stdin -> censor() -> stdout`, same registry
(`~/.pi/agent/secrets.txt` / `$JARATE_SECRETS_FILE`), never fails the
caller (any error = pass through). Wired in where the out-of-bridge
egress lives:

- `dispatch/jarate-bg` — the webhook callback embed's `task` and `result`
  fields (truncated task text + raw worker output, the primary leak
  surface) and the legacy plain-text fallback body are all run through
  `jarate-censor` before the POST.
- Peer-agent messages: `bin/agent-say` is gone (gut #228) — agent-to-agent
  traffic now flows through hall-monitor fleet comms (`POST /fleet/say`),
  an out-of-repo egress the censor does not wrap.

Known open (residual gaps, not covered by any process today):

- **webdrop artifacts** — jarate-bg uploads the FULL prompt + output files
  to webdrop; only the link lands in Discord. The files are readable by
  anyone with the URL. Acceptable while the TTL is 7d + random slugs;
  censoring them needs a webdrop-side hook.
- The registry protects only what the censor runs through: any NEW
  out-of-bridge process that posts raw text to Discord leaks until it is
  wired the same one-line way (`printf '%s' "$msg" | bun <jarate>/bin/jarate-censor`).
  The guarantee scope is: **every Discord egress in this repo routes
  through `censor()`** — asserted for the bridge at source level (the
  chokepoint test) and structurally for jarate-bg (posts only the censored
  strings).

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

### (b) PATTERN — egress scope of the shared table

The 13 egress rules come from `secret-patterns.ts` (scope `both` +
`egress`); the table owns the regexes, replacements, and application
order. The list below is the egress projection of that table (the log
engine's projection is in "Shared pattern table"):

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

## Shared pattern table (issue #254)

`packages/bridge/channel/secret-patterns.ts` is the single source of truth
for both engines. Before #254, the log engine and the egress censor each
carried their own pattern list and had drifted silently (different ghp_
lengths, different token classes, different orders).

Every entry declares:

- `name` — stable name; for egress rules it doubles as the WARN class tag
  (`[censor] class=<name>`). The two key-value rules share the name `kv`
  (one class, two shapes: the `=` form and the `:` form).
- `scope` — `both` (each engine applies its own side), `log`, or `egress`.
- `log` / `egress` sides — each side carries its own `re`, `sub`, and
  `order` (lower runs first), so per-engine shape overrides are data, not
  code.
- `paths` — log-only: applied only when the caller passes
  `redactPaths: true` (paths are not secrets; they leak usernames +
  layout).

Why the shapes differ per engine: egress text is user-visible, so egress
shapes are strict — a `ghp_` run redacts at exactly 36 chars on egress (a
real PAT shape; a 35-char run is user content, issue #54). Log text is not
user-visible, so the log side is looser (`{20,}` catches partials too: a
partial redaction in a log beats a live secret).

Application order is per-side data. Log: Bearer runs before the `sk-` class
(a Bearer value can carry an sk- key — `Bearer sk-…` must redact as one
Bearer match, not be split by the sk- rule). Egress: the kv rules run last
(loosest first would shadow the specific token classes).

The full split:

| name | scope | log shape → replacement | egress shape → replacement |
|---|---|---|---|
| github | both | `gh[pousr]_` + `{20,}` alnum → `[REDACTED_GITHUB_TOKEN]` | `gh[pousr]_` + exactly 36 alnum, or `github_pat_` + 22..255 word chars → `[REDACTED:github]` |
| switchboard | egress | — | `sbk_` + 8+ word chars (escaped form tolerated) → `[REDACTED:switchboard]` |
| gitlab | egress | — | `glpat-` → `[REDACTED:gitlab]` |
| anthropic | egress | — | `sk-ant-` → `[REDACTED:anthropic]` |
| openai | both | `sk-` + `{16,}` alnum → `[REDACTED_OPENAI_KEY]` | `sk-or-`, or `sk-` + `{20,}` alnum → `[REDACTED:openai]` |
| aws | egress | — | `AKIA[0-9A-Z]{16}` → `[REDACTED:aws]` |
| google | both | `AIza` + `{20,}` → `[REDACTED_GOOGLE_KEY]` | `AIza` + exactly 35 → `[REDACTED:google]` |
| slack | egress | — | `xox[baprs]-` → `[REDACTED:slack]` |
| bearer | both | `Bearer ` + 10+ char run (case-insensitive) → `Bearer [REDACTED]` | `Bearer ` + 8+ char run → `Bearer [REDACTED:bearer]` |
| discord | log | `<20+>.<6>.<25+>` dot parts → `[REDACTED_DISCORD_TOKEN]` | — |
| dsn | egress | — | `scheme://user:pass@` (also `://:pass@`) → `scheme://[REDACTED:dsn]@` |
| sshpass | egress | — | `sshpass -p <arg>` (skips marker fragments) → `sshpass -p [REDACTED:sshpass]` |
| kv-query | log | `?token=` / `&api_key=` + run → `$1[REDACTED]` | — |
| kv-quoted | log | `token: "v"` / `secret="v"` → `$1[REDACTED]$3` | — |
| kv-bare | log | `token=v` / `secret: v` (value stops at whitespace/comma/semicolon) → `$1[REDACTED]` | — |
| kv (eq) | egress | — | `password/passwd/secret/token/api_key = v` anywhere (quoted, or unquoted not starting `[`) → `key=[REDACTED:kv]` |
| kv (colon) | egress | — | `key: v` when v is quoted (>=4) or an unquoted run of >=8 chars → `key: [REDACTED:kv]` |
| path-unix | log (paths) | `/Users/<n>/…`, `/home/<n>/…` → `[REDACTED_PATH]` | — |
| path-win | log (paths) | `C:\…` → `[REDACTED_PATH]` | — |

Pinned by `secret-patterns.test.ts`: dropping a pattern, reordering an
entry, shortening a length specifier (`{36}` → `{35}`), or flipping a
scope all fail CI.

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
- **Log side has no registry pass.** The registry protects egress (the
  user-visible surface); `sanitizeSensitiveText` / `sanitizeUnknownValue`
  apply the log-scope patterns only, and there is no WARN on the log side
  — a redacted log line is a local file, not a message.

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
`secret-patterns.test.ts` (pin tests, issue #254): the shared table equals a
pinned copy exactly (names, order, scopes, regex source + flags,
replacements), each engine's derived rule list IS the table (no private
copies, checked by RegExp identity), function replacements are probed, and
the log-vs-egress split behaves as documented (a 36-char `ghp_` run is
redacted by both engines; a 35-char one is log-only; `github_pat_` is
egress-only; the Discord token shape is log-only).
`sanitize.test.ts`: one per log class, the three kv shapes, the path
opt-in, and `sanitizeUnknownValue` recursion (errors, arrays, objects,
cycles, depth limit).
`discord.test.ts` choke-point test: source-level assert that all text-
and filename-bearing send functions in `discord.ts` (exported or not) that
POST/PATCH a `content` body or a `payload_json` multipart call
`egressText`, plus a runtime test that a registry-literal filename is
redacted in the API-facing `payload_json`. `censor.test.ts` covers the
`jarate-censor` CLI end-to-end (bun, same registry).

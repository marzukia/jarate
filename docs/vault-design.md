# Vault — generic credential vault with approval levels

Design doc for the generic inbuilt vault (issue: JARATE OPEC). Generalizes
the existing PAT vault (`docs/PAT-VAULT.md`) to multiple credential kinds
and three approval levels. Additive: `pat-*` keeps working unchanged.

## 1. How the PAT vault works today (as-implemented, 81facb1c)

### Processes

```
agent shell:  jarate pat-run <id> -- <cmd>
     │  bin/jarate (bash, thin dispatch; N4 tool-path: 1 pre-joined arg)
     ▼
   bin/jarate-pat (bun wrapper — the ONLY process that sees the token
     besides the bridge and the one child it spawns)
     │  unix socket, one JSON line per op ($XDG_RUNTIME_DIR/jarate/pat.sock,
     │  0700 dir, 0600 socket)
     ▼
   bridge  packages/bridge/channel/pat-vault.ts (in pi process, per channel)
```

Ops over the socket: `request` → `{ok,id,state,ttl}`; `run` →
`{ok, token, kind}` (socket mode) or `{ok, file:true}` (file mode);
`done {id, rc}` → `{ok}`; `status` → state doc. `handlePatComponent`
receives Discord button taps (`pat:approve|deny:<id>`) from
`buildInteractionHandler` (index.ts).

### Storage (per agent box, agent uid)

| path | perms | content |
|---|---|---|
| `~/.config/marzukia-pat` | 0600 | classic PAT, scope `default`, one line |
| `~/.config/marzukia-pats/<owner>/<repo>:<perm>` | 0600 each | fine-grained PATs, one line |
| `~/.tmp/pat-vault.json` (bridge cwd `$HOME` → `ctx.cwd/.tmp`) | 0600, atomic write (`.tmp-<pid>` + rename) | persisted state: requests, approval stamps, seen-interaction set. **No token values.** |
| `~/.jarate/pat-audit.log` | 0600, append | audit lines (kv-style, one per event) |
| `$XDG_RUNTIME_DIR/jarate/pat.sock` | dir 0700, sock 0600 | request/status/run transport |
| `$XDG_RUNTIME_DIR/jarate-pat/pat-<id>` | 0600, mkstemp+rename | file-mode published token (transient) |

Token shape on every handoff: `gh[pousr]_[A-Za-z0-9]{36}` or
`github_pat_[A-Za-z0-9_]{22,255}`.

### Approval flow

1. `pat-request <scope> <reason>` → bridge validates scope (must be a known
   store file), reason 3–200 chars, 1 pending/agent, budget 5 approvals/hour
   per agent (rolling), then posts a Discord message with `[Approve][Deny]`
   buttons. Record state `pending`, no TTL by default (#203: pending is
   BLOCKING until tap or revoke; `JARATE_PAT_TTL_MS` opts an explicit
   window in).
2. Owner tap (only owner — `isOwnerUser`; other taps get an ephemeral reply
   + `non-owner-tap` audit, state untouched) → `approved`, claim window 60 s.
3. `pat-run <id> -- <cmd>` → bridge **reads the token file at handoff**
   (socket mode; rotation-aware), flips state to `handed-off` **before**
   flushing the token line, sends token over the socket. Wrapper validates
   shape, puts the token in the child **env only** (`GH_TOKEN` +
   `GIT_CONFIG_*` header + `GIT_TERMINAL_PROMPT=0`), never argv. Child runs
   with a 900 s cap (SIGKILL process group, rc 124). Wrapper sends
   `done {id, rc}`; bridge records it and drops the censor secret after a
   10 s grace.
4. File mode (`JARATE_PAT_TRANSPORT=file`): bridge publishes the token to a
   0600 file at approve (mkstemp + rename); wrapper reads, shape-checks,
   unlinks.

### What "single use" means mechanically

The state flip `approved → handed-off` happens in `patRunBegin` **before the
token line is written to the socket** (`handed-off` is terminal). A second
`run` on the same id gets `state: already used`. The underlying store file is
never touched — the *request id* is single-use, not the token. One tap = one
token = one command.

### Security properties (invariants 1–8 of docs/PAT-VAULT.md)

1. Only the bridge reads a PAT file (at handoff/approve).
2. Only the owner's tap mutates a request; other taps audited, state untouched.
3. One tap = one token = one command; id single-use.
4. Token in at most 3 places at once: bridge memory, wrapper, one child env.
   Never argv, never a file (socket mode), never LLM context.
5. Every secret lifetime is timer-owned by the bridge (pending TTL
   opt-in via env, claim 60 s, censor grace 10 s, boot sweep).
6. Budget enforced where the token is (bridge), not in the CLI.
7. Restart-safe: state persists; file dir swept at boot; timers re-armed.
8. Egress censor: token registered as a runtime secret for its lifetime;
   everything posted through the bridge is redacted.

## 2. The vault

### 2.1 Credential kinds

| kind | name grammar | value shape check | child env |
|---|---|---|---|
| `github-pat` | `default` or `<owner>/<repo>:<perm>` (today's scope grammar) | `gh[pousr]_`+36 alnum or `github_pat_`+22–255 | `<envvar>` (default `GH_TOKEN`) + git header + `GIT_TERMINAL_PROMPT=0` |
| `api-key` | 1–128 of `[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*` | 1–4096 chars, no whitespace | `<envvar>` (required) + `GIT_TERMINAL_PROMPT=0` |
| `password` | same | 1–4096 chars, no newline | `<envvar>` (required) + `GIT_TERMINAL_PROMPT=0` |

`envvar` = `[A-Za-z_][A-Za-z0-9_]{0,63}`. For `github-pat` it defaults to
`GH_TOKEN` (keeps today's exact env contract).

### 2.2 Approval levels

| level | lifetime after approve | reuse | terminal events |
|---|---|---|---|
| `one-shot` | 60 s claim window — identical to today's PAT semantics | exactly 1 command | run → `consumed`; claim miss → `expired`; revoke → `revoked` |
| `time-boxed` (default) | `--hours N` (whole minutes, 1m–72h) or `--minutes N`; **omitted level → 30 m** (#205), from approval time | unlimited inside the window | window end → `expired` (timer + lazy check); revoke → `revoked` |
| `permanent` | until explicitly revoked | unlimited | revoke (owner tap or requesting agent CLI) → `revoked` |

Common to all: no `pending` TTL by default (BLOCKING until tap or revoke;
`JARATE_VAULT_TTL_MS` opts an explicit window in — #203), owner
Approve/Deny/Revoke gate, 1 pending per agent, budget 5 approvals/hour
per agent, JSON-lines audit.

### 2.3 State machine

```
                 ┌────────┐  owner deny    ┌────────┐
       request ─▶pending ─────────────────▶ denied  │
                 │        │ TTL (opt-in)   └────────┘
                 │        ▼
                 │     ┌─────────┐
                 │     │ expired │
                 │     └─────────┘
                 │  owner approve
                 ▼
            ┌───────────┐
            │  active   │  (level decides the clock)
            └───────────┘
  one-shot:     vrun ─────────────────▶ consumed   (value file deleted)
                claim 60s ────────────▶ expired
                revoke (owner | agent)▶ revoked
  time-boxed:   vrun ─▶ active  (repeated; each use audited with rc)
                expiresAt ────────────▶ expired    (value file deleted)
                revoke ───────────────▶ revoked    (value file deleted)
  permanent:    vrun ─▶ active
                revoke ───────────────▶ revoked    (value file deleted)
```

Terminal: `denied`, `expired`, `consumed`, `revoked`. Non-terminal:
`pending`, `active`.

Every transition is audit-logged with `ts` + `actor`
(`agent:<name>` self-attested on socket lines, `discord:<uid>` for taps,
`system` for timers/recovery).

### 2.4 Storage layout

```
~/.jarate/vault/                0700    (JARATE_VAULT_DIR)
  state.json                    0600    records; NO values; atomic (mkstemp+rename)
  audit.log                     0600    JSON lines, append; NO values
  known/                        0700    operator-provided values (vault never deletes)
    github-pat/default                      0600, one line
    github-pat/<owner>/<repo>:<perm>
    api-key/<name>
    password/<name>
  secrets/                      0700    vault-owned BYO values
    <id>.secret                 0600    one line; deleted on
                                        consumed/expired/denied/revoked
$XDG_RUNTIME_DIR/jarate/vault.sock       0700 dir, 0600 socket (JARATE_VAULT_SOCKET_DIR)
$XDG_RUNTIME_DIR/jarate-vault/vault-<id> 0600, mkstemp+rename (file mode; JSON doc,
                                         bridge owns deletion; JARATE_VAULT_FILE_DIR)
```

- **No secret in any filename.** Known files are named by kind + operator
  name; BYO files are named by uuid (`vault_<uuid>`).
- All writes are atomic (temp in same dir + rename) or append-only 0600.
- **Legacy compatibility:** for `github-pat` the known lookup falls back to
  today's store (`~/.config/marzukia-pat` = `default`,
  `~/.config/marzukia-pats/<scope>`), so a box onboarded for the PAT vault
  works with the vault with zero re-onboarding. `vault/github-pat/...` wins
  if both exist.
- **Value sources:** `known` (value in the operator store, read fresh at
  every handoff — rotation-aware, invariant 1 preserved) or `stored`
  (BYO: agent passes the value on the request line via `--from-env VAR`;
  bridge writes `secrets/<id>.secret` at request time; the value then lives
  at rest in a 0600 file — a new exposure surface vs "never in a file",
  see threat model).

### 2.5 CLI surface

All commands print ONE JSON doc on stdout (`ok` + `error` discipline, rc
0 ok | 1 vault error | 2 usage). No command ever prints a value.

```
jarate vault-request <kind> <name> <level>
                     [--label <text>] [--hours <n>] [--envvar <VAR>]
                     [--from-env <VAR>] <reason...>
jarate vault-run <id> -- <cmd> [args...]
jarate vault-status [id]
jarate vault-revoke <id>
jarate vault-audit [n]
```

- `vault-request` → posts `[Approve][Deny]`; reply
  `{ok, id, state:"pending", ttl}`. Known mode requires the value file to
  exist at request time (reject + known list, like today). BYO mode
  (`--from-env VAR`) reads the value from the agent's env; it crosses the
  socket on the request line and never appears in any output.
- `vault-run` → same contract as `pat-run` (child rc passthrough, 124 on
  cap, `done` accounting). Child env: `<envvar>=value`; for `github-pat`
  also `GH_TOKEN` + git header (today's exact contract).
- `vault-status` → by id: full record (state, kind, name, label, level,
  envvar, timestamps, expires, use_count, last_rc — no value). By agent:
  non-terminal records + budget headroom.
- `vault-revoke` → **agent self-revoke**: the calling agent must be the
  requesting agent. Works on `pending` (cancel) and `active` (early end).
  Owner revoke is the `[Revoke]` button on the approved message.
- `vault-audit` → prints the last `n` (default 20, cap 500) JSON lines of
  the local audit file as `{ok, count, lines:[...]}`. Read-only, local read
  (0600, same uid) — no socket needed; values can never be in there.

Tool path (N4, same as pat): `bin/jarate` forwards a single pre-joined arg
to `request-raw` / `run-raw`, which re-split with the `shellWords` parser.

### 2.6 Audit log (JSON lines)

Events: `request`, `approve`, `deny`, `revoke`, `use` (rc), `handoff`
(source known|stored, envvar — never the value), `expire`
(kind ttl|claim|window), `consumed`, `recovered-*`, `sweep`, `post-fail`,
`non-owner-tap`, `vault-error`, `scope-reject`, `pending-reject`,
`budget-reject`. Each line:
`{"ts":iso,"event":...,"id":...,"actor":...,...}`.

### 2.7 Threat model

| threat | mitigation |
|---|---|
| Secret in argv (`ps` visible) | value in child **env only**; wrapper never puts it in argv; file/sock 0600 |
| Secret on disk readable by others | 0700 dirs, 0600 files, mkstemp+rename (never 0644 even transiently); agent uid only, no setuid |
| Secret in LLM context | agents see ids + status JSON only; value crosses exactly one socket, in the request line (BYO) or run reply (known) |
| Secret in channel history | egress censor: value registered as runtime secret for its whole lifetime (BYO: request→terminal+grace; known: each handoff→done+grace) |
| Secret in state/audit files | values live only in `known/` + `secrets/`; state.json, audit.log, status docs carry kind/name/envvar, never the value |
| Non-owner approves/revokes | owner gate on every tap (`isOwnerUser`); non-owner taps audited, state untouched |
| CLI bypasses limits | budget/pending/level rules enforced bridge-side (where the value is), not in the wrapper |
| Bridge restart mid-lifecycle | state.json + re-arm at load; lazy expiry check on every run; boot sweep of the file dir |
| Double tap / redelivery | seen-set dedupe (persisted, 10-min freshness) + state gate |
| Stale button copy forwarded | message + channel id match before any state change |
| Run never reports `done` | connection close / read timeout settles rc=-1, drops censor |
| Command overruns | 900 s cap, SIGKILL process group, rc 124 |
| **NEW vs PAT:** stored BYO value at rest in `secrets/` | 0600 in 0700, same uid; deleted on every terminal state; audit never carries it; rotation = new request (old value file deleted) |

**Known limitations (accepted):**
- `--from-env` value is in the agent's env at request time — the agent must
  already have it (that is the point). It is not written to argv or files by
  the wrapper.
- A local reader of the audit/state files (agent uid) can see who requested
  what kind of which name, when, and with which rc — not the value.
- `known/` files are operator-managed; the vault never deletes them
  (rotation semantics preserved from the PAT vault).

### 2.8 Properties preserved from the PAT flow (must-haves)

1. **Never-echo** — no value in argv, stdout, status, state, audit, or LLM
   context; env-only child injection.
2. **Single-use enforcement (one-shot)** — state flip before token flush;
   second run → `state: already used`.
3. **Owner-approval gate** — only owner taps approve/deny/revoke;
   non-owner taps audited, state untouched.
4. Timer-owned lifetimes + boot sweep + lazy expiry (restart-safe).
5. Budget + pending caps bridge-side.
6. Egress censor for the whole value lifetime.
7. 0600/0700 + atomic writes + no secret in filenames.
8. `github-pat` one-shot reproduces today's exact wire + env contract
   (GH_TOKEN, git header, GIT_TERMINAL_PROMPT, 900 s cap, rc 124,
   done accounting, claim 60 s, pending TTL opt-in, budget 5/hour,
   1 pending).

### 2.9 What changes vs the PAT flow

- Values can be **stored** in the vault (`secrets/<id>.secret`, BYO) for
  time-boxed/permanent reuse — the PAT vault only ever referenced
  operator store files.
- **Multi-use** credentials (time-boxed/permanent): each use is an audit
  `use` event; the credential stays `active`.
- **Revoke** is first-class (owner button + agent self-revoke); the PAT
  vault had no revoke (deny only, pre-approve).
- Audit is JSON lines with explicit `actor` + `ts` (today: kv-style, no
  actor for timers).
- File-mode published file carries a small JSON doc `{value, kind, envvar,
  git_header}` (metadata is not secret) instead of a bare token line; the
  **bridge** owns deletion (multi-use reads).
- `pat-*` is untouched in this change; it can be re-implemented on the vault
  (`kind=github-pat level=one-shot`) in a follow-up, then deprecated.

## 3. Implementation map

| file | role |
|---|---|
| `packages/bridge/channel/vault.ts` | bridge side: state machine, socket server, taps, storage, audit |
| `packages/bridge/channel/vault.test.ts` | bridge tests (fake Discord, fake clock, real sockets in mkdtemp) |
| `bin/jarate-vault` | bun wrapper (only process that sees the value besides bridge + child) |
| `bin/jarate-vault.test.ts` | wrapper tests (fake vault server, child env/cmdline capture) |
| `bin/jarate` | bash dispatch for `vault-*` (N4 tool path) |
| `packages/bridge/channel/jarate.ts` | pi tool: `vault-*` in the command enum + `vault-run` timeout |
| `packages/bridge/channel/index.ts` | wiring: start/stop per channel, component handler ref |
| `install.sh` | link `~/bin/jarate-vault` (idempotent, --dry-run clean) |
| `docs/VAULT.md` | runbook |

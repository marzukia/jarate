# Vault — runbook

Generic credential vault for agent work. Generalizes the PAT vault:
github PATs, API keys, passwords. The agent asks, the owner taps Approve,
the command runs under the value, and the value is gone (or expires on a
clock, for reusable credentials).

```
agent: jarate vault-request <kind> <name> <level> [--envvar V] [--from-env E] <reason...>
  -> bridge posts a message with [Approve] [Deny] to the agent channel
owner: taps Approve
agent: jarate vault-run <id> -- <cmd> [args...]
  -> value injected into ONE child process env, rc passed through
```

Design: `docs/vault-design.md`. Bridge side:
`packages/bridge/channel/vault.ts`. CLI: `bin/jarate` (thin dispatch) +
`bin/jarate-vault` (bun wrapper; the only process that ever sees the value
besides the one child it spawns).

**Relationship to the PAT vault: additive.** `pat-*` commands, the
`~/.config/marzukia-pat*` store, and `pat-audit.log` are untouched. The
PAT vault's store files double as the vault's `github-pat` known store
(legacy fallback, zero re-onboarding) — see below.

## Kinds and levels

| kind | shape check | default envvar | extra child env |
|---|---|---|---|
| `github-pat` | `gh[pousr]_`+36 alnum or `github_pat_`+22-255 | `GH_TOKEN` | `GIT_TERMINAL_PROMPT=0`, git env-config `Authorization: Bearer <value>` |
| `api-key` | no spaces, 1-4096 chars | (required: `--envvar`) | — |
| `password` | no newlines, 1-4096 chars (spaces ok, exact bytes preserved) | (required: `--envvar`) | — |

| level | semantics | terminal |
|---|---|---|
| `one-shot` | current PAT semantics: one approve = one run | after the run (`consumed`) |
| `time-boxed` | reusable for N hours (`--hours 1..72`), then the bridge timer expires it | `expired` at the deadline |
| `permanent` | until the owner taps Revoke | `revoked` |

## Value sources

**Known** (default). The bridge reads the value file **at handoff**
(rotation-aware; next run uses the new value).

| kind | lookup order |
|---|---|
| `github-pat` | `~/.jarate/vault/known/github-pat/<name>` -> `~/.config/marzukia-pats/<name>` -> `~/.config/marzukia-pat` (name `default`) |
| `api-key` / `password` | `~/.jarate/vault/known/<kind>/<name>` |

- `name`: for `github-pat` the legacy scope grammar (`default` or
  `<owner>/<repo>:<perm>`); for other kinds any 1-200 char path-safe
  name.
- File content: exact value, no trailing-newline requirement (read as-is;
  edge spaces preserved).
- All known files: 0600, in 0700 dirs. A request with an unknown name is
  rejected before any Discord post, with the known list in the error.

**Stored (BYO)**. `--from-env E`: the wrapper reads `$E` from the agent's
env at request time and sends the value on the wire exactly once (the
handoff line). The bridge stores it as `~/.jarate/vault/secrets/<id>.secret`
(0600) and deletes it at the credential's terminal state. The value never
appears in state, audit, status, or the button message.

## Commands

All print ONE JSON doc on stdout (`ok` + `error` discipline, same as the
rest of `jarate`). **No `vault-*` command ever prints the value.**

### `jarate vault-request <kind> <name> <level> [flags] <reason...>`

```
$ jarate vault-request github-pat marzukia/jarate:write one-shot "open PR for #41"
{"ok":true,"id":"vault_...","state":"pending","expires":"..."}

$ jarate vault-request api-key stripe time-boxed --hours 4 --envvar STRIPE_KEY "batch window"
$ jarate vault-request password db one-shot --envvar DB_PW --from-env DB_PW "rotate creds"
```

- `reason`: remaining args joined with spaces, 3-200 chars.
- rc 0 ok | rc 1 vault error (doc says why) | rc 2 usage.
- Constraints enforced by the bridge: 1 pending per agent (TTL 5 min),
  5 approvals/hour per agent (rolling).
- `time-boxed` without `--hours` -> usage error.

### `jarate vault-run <request-id> -- <cmd> [args...]`

```
$ jarate vault-run vault_x -- stripe customers list
<child stdout/stderr pass through verbatim>
$ echo $?   # the child's exit code
```

- The child gets `<envvar>=value` in env (never argv — `ps` cannot see
  it); `github-pat` additionally gets `GH_TOKEN` + the git env-config
  header. `GIT_TERMINAL_PROMPT=0` always.
- `one-shot`: the id is single-use — one approve = one run. Re-running
  gets `state: already used`.
- `time-boxed` / `permanent`: any number of runs inside the window,
  including concurrent ones; every handoff is counted as a use.
- Command cap: `JARATE_VAULT_RUN_TIMEOUT_S` seconds (default 900). On cap
  the child process group is SIGKILL'd, the wrapper exits **124 with no
  JSON doc** (partial child output still passes through). rc 124 is a
  command timeout, not a vault error.
- Vault errors (command never ran) are rc 1 + JSON doc: `state: pending
  (awaiting approval)`, `state: expired at ...`, `state: denied`,
  `state: revoked`, `state: already used`, `unknown id`,
  `known: no value file for ...`.

### `jarate vault-status [request-id]`

Read-only. No id = this agent's non-terminal credentials + budget
headroom. With id = the full record. The value is never in the output.

### `jarate vault-revoke <request-id>`

Self-service by the requesting agent (button tap on an active credential
works too — owner tap). Terminal for the credential: stored value
deleted, censor dropped, button message edited.

### `jarate vault-audit [n]`

Prints the last `n` (default 20) JSON lines of the local audit file.
The value is never in the audit.

## Quoting semantics (tool path)

Same N4 contract as `pat-run`:

- **Bash path**: everything after `--` arrives as real argv — lossless.
- **Tool path**: the whole tail arrives as ONE word; `bin/jarate` hands it
  to `jarate-vault run-raw`, which parses it with `shellWords` (splits on
  unquoted whitespace; single quotes verbatim; double quotes honor `\"`
  and `\\`; backslash outside quotes escapes the next char; **no
  expansion**). The parsed tokens must start with `--`; 1-200 args, each
  <= 4096 chars.

`vault-request` single-word tails go through `request-raw` the same way.

## Files on the box

| path | what |
|---|---|
| `$XDG_RUNTIME_DIR/jarate/vault.sock` | vault socket (0700 dir, 0600 socket). Override: `JARATE_VAULT_SOCKET_DIR`. |
| `$XDG_RUNTIME_DIR/jarate-vault/vault-<id>` | published value doc (file transport only; 0600, swept at boot, deleted at terminal). Override: `JARATE_VAULT_FILE_DIR`. |
| `~/.jarate/vault/` (0700) | vault state root. Override: `JARATE_VAULT_DIR`. |
| `~/.jarate/vault/state.json` (0600) | persisted state (credentials, approvals, budget stamps). No values. |
| `~/.jarate/vault/audit.log` (0600) | audit trail, JSON lines. No values. |
| `~/.jarate/vault/known/<kind>/<name>` (0600) | known value store. |
| `~/.jarate/vault/secrets/<id>.secret` (0600) | BYO stored values. Deleted at terminal. |
| `~/.config/marzukia-pat*` | legacy PAT store; used as `github-pat` known fallback (read-only). Override: `JARATE_VAULT_LEGACY_PATS_DIR` / `JARATE_VAULT_LEGACY_PAT_FILE`. |

Bridge-side tuning env (set on `pi.service`, not per-call):
`JARATE_VAULT_TTL_MS` (default 300000), `JARATE_VAULT_CLAIM_MS` (60000),
`JARATE_VAULT_MAX_PENDING` (1), `JARATE_VAULT_BUDGET_PER_HOUR` (5),
`JARATE_VAULT_CENSOR_GRACE_MS` (10000), `JARATE_VAULT_HOUR_MS`
(budget window; 3600000), `JARATE_VAULT_SEEN_CAP` (500),
`JARATE_VAULT_TRANSPORT` (`socket` default | `file`).

### Transport fallback

Default is **socket mode**: the bridge reads the value at handoff and
sends it over the unix socket to the wrapper (one line, 0600 dir, same
user). **File mode** (`JARATE_VAULT_TRANSPORT=file`): the bridge
publishes a JSON doc `{value, kind, envvar, git_header}` to
`$XDG_RUNTIME_DIR/jarate-vault/vault-<id>` (mkstemp + atomic rename,
0600); the wrapper reads it at run time; the bridge deletes it at
terminal. Switch it when socket delivery is suspect; both modes enforce
the same state machine, shape checks, and done accounting.

## Audit log

`~/.jarate/vault/audit.log`, one JSON line per event: `request`,
`approve` (with owner id), `deny`, `use` (with source + envvar, at
handoff), `done` (with rc), `abandon` (child never reported), `revoke`,
`revoke-reject`, `expire`, `recovered-expired`, `sweep`, `post-fail`,
`vault-error`, `non-owner-tap`, `no-owner`, `budget-reject`,
`pending-reject`, `scope-reject`. Inspect:
`jarate vault-audit 20` or `tail -20 ~/.jarate/vault/audit.log | jq .`.

## Failure modes

| symptom | cause / behavior | fix |
|---|---|---|
| `vault unavailable: no socket at ... (pi.service down?)` rc 1 | bridge not running | start pi.service; retry (request is idempotent — nothing was posted) |
| `pending: vault_x expires ...` rc 1 | another request is pending for this agent | wait for TTL (5 min) or let the owner deny it |
| `budget: 5 approvals in last hour; next slot ...` rc 1 | rolling budget cap | wait for the hour to roll |
| `known: no value file for <kind>/<name> (known: ...)` rc 1 | no store file for that name | create the file, retry |
| `state: already used` rc 1 | one-shot id was run | re-request a fresh id |
| `state: expired at ...` rc 1 | time-boxed window closed | re-request |
| `state: revoked` rc 1 | owner revoked it | re-request (and ask why) |
| `value: shape invalid for <kind>` rc 1 | from-env value failed the kind shape check | fix the source env var |
| exit 124, no JSON, partial output | command hit the 900s cap | make the command faster / split it; re-request if one-shot |
| `file missing: <path>` rc 1 (file mode) | bridge restarted between publish and read (boot sweep) | retry inside the claim window; else re-request |
| double tap / stale button message | dedupe by component id + state check | ephemeral `already handled`; nothing consumed |
| non-owner taps | deliverable ephemeral `[!] only the owner...` | owner taps later within TTL |

Every tap gets visible feedback; a tap never crashes the bridge
(`handleVaultComponent` never rejects; the dispatch line carries a
`.catch` backstop).

## Onboarding a new agent box

1. Deploy the agent (pi + bridge) — `docs/NEW-AGENT.md`.
2. `github-pat` values work out of the box via the legacy store
   (`~/.config/marzukia-pat`, `~/.config/marzukia-pats/`) — no
   re-onboarding needed. New kinds go under `~/.jarate/vault/known/<kind>/<name>`
   (0600). All per-user: the vault runs as the agent's uid, the socket
   lives in that user's `$XDG_RUNTIME_DIR`.
3. `install.sh` (links `~/bin/jarate-vault` next to `~/bin/jarate`).
4. Restart the bridge via the normal self-update flow (the vault starts
   with the channel connect; do not restart `pi.service` from within a
   task).
5. Smoke test: `jarate vault-request github-pat default one-shot "smoke
   test"` -> approve -> `jarate vault-run <id> -- echo ok` ->
   `jarate vault-status <id>` shows `use_count: 1`.

## Invariants (what the design guarantees)

1. Only the bridge reads a value file (at handoff, approved credential
   only); only the wrapper + one child see the value in memory.
2. Only the owner's tap mutates a request; every other tap is
   ephemeral-replied + audit-logged, state untouched.
3. One approve = one value handoff. `one-shot` ids are single-use by
   construction; `time-boxed`/`permanent` reuse the same value file until
   terminal.
4. The value is in at most 3 places at once: bridge memory (transient),
   the bun wrapper, one child's env. Never in argv, never in
   state.json/audit/status/button message, never in the LLM context
   (agents only see ids + status JSON).
5. Exact bytes: BYO values round-trip verbatim (no trim, no newline
   mangling) — passwords with leading/trailing spaces survive.
6. Every secret lifetime is timer-owned by the bridge (TTL 5 min, claim
   60s, time-box deadline, censor grace 10s, startup sweep). Early
   cleanup by the agent is optional, never the guarantee.
7. Budget is enforced where the value is (bridge), not where the agent
   can bypass it (CLI).
8. Restart-safe: state, approvals, and the sweep survive bridge restarts;
   pending credentials survive (a restart does not consume a one-shot);
   anything in the file dir at boot is stale and swept.
9. Egress censor: the value is registered as a runtime secret for its
   handoff lifetime; anything it appears in (child stdout echoed by the
   agent later, a reason string typo) is redacted at post time.
10. Additive: `pat-*` semantics are byte-for-byte unchanged; the PAT
    store is read-only input to the vault.

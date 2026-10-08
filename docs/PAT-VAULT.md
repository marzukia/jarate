# PAT vault — runbook

One-time GitHub PATs for agent work. The agent asks, the owner taps
Approve, one command runs under the token, the token is gone.

```
agent: jarate pat-request <scope> <reason...>
  -> bridge posts a message with [Approve] [Deny] to the agent channel
owner: taps Approve (60s claim window opens)
agent: jarate pat-run <id> -- <cmd> [args...]
  -> token injected into ONE child process env, rc passed through
  -> done line settles the record; the token leaves memory
```

Design: `~/reports/pat-vault-design-v4.md` (v4). Bridge side:
`packages/bridge/channel/pat-vault.ts`. CLI: `bin/jarate` (thin dispatch)
+ `bin/jarate-pat` (bun wrapper; the only process that ever sees the
token besides the one child it spawns).

## Token store (per agent box)

| location | content |
|---|---|
| `~/.config/marzukia-pat` (0600) | classic PAT, scope `default` |
| `~/.config/marzukia-pats/<owner>/<repo>:<perm>` (0600, one file each) | fine-grained PATs, e.g. `marzukia/jarate:write` |

- Scope grammar (validated at request time, bridge-side):
  `default` or `<owner>/<repo>:<perm>` where perm is `read` or `write`,
  owner 1-39 chars, repo 1-100 chars (`[A-Za-z0-9_.-]`).
- File content: exactly one line, token only.
- Tokens are read **at approve** (both transports — a dead file blocks
  the tap with a visible in-channel error) and **at handoff** (socket
  mode, rotation-aware) — NOT at request time. Operator rotation takes
  effect with no bridge restart; the next run uses the new token.
- Known scopes = `default` + recursive listing of the pats dir. A request
  with an unknown scope is rejected before any Discord post.

### Creating a fine-grained PAT (web UI, operator-only)

Fine-grained tokens are web-only on GitHub — no API create.

1. GitHub -> Settings -> Developer settings -> Fine-grained tokens ->
   Generate new token.
2. Repository access: only the named repo (match the scope, e.g.
   `marzukia/jarate`).
3. Permissions: Contents Read and write, Pull requests Read and write,
   Metadata Read. Nothing else.
4. Expiry: 90 days or less (shorter is better).
5. Drop the token into the store file:
   `~/.config/marzukia-pats/marzukia/jarate:write`, `chmod 600`.
6. Verify: `jarate pat-status` shows nothing about scopes; just request
   and approve once to confirm handoff works.

Token shape is validated on every handoff:
`gh[pousr]_` + 36 alnum (classic) or `github_pat_` + 22-255
`[A-Za-z0-9_]` (fine-grained).

### Dropping / rotating

- Rotate: overwrite the file, `chmod 600`. Takes effect at the next
  handoff. The old token stays live on GitHub until its expiry — revoke
  it in the web UI if the box was not trusted.
- Drop: delete the file. The scope disappears from the known list at the
  next request; a pending request's approve tap is blocked with a
  non-ephemeral channel followup naming the file + the exact next
  command (restore it, then re-tap — or re-request), and approved
  requests fail at run time with the executable
  `scope: token file missing: <path> — ...` error (the request stays
  `approved`; restore the file and re-run inside the claim window).

## Commands

All three print ONE JSON doc on stdout (`ok` + `error` discipline, same
as the rest of `jarate`). **No `pat-*` command ever prints the token.**

### `jarate pat-request <scope> <reason...>`

```
$ jarate pat-request marzukia/jarate:write "open PR for dispatch refactor"
{ "ok":true,"id":"pat_5b0e...","state":"pending","ttl":null }
```

- `ttl`: expiry timestamp, or `null` when no TTL is configured (the
  default, #203 — pending blocks until the owner taps).

- `reason`: remaining args joined with spaces, 3-200 chars.
- rc 0 ok | rc 1 vault error (doc says why) | rc 2 usage.
- Constraints enforced by the bridge: 1 pending per agent (pending
  blocks until tap; TTL opt-in via `JARATE_PAT_TTL_MS`),
  5 approvals/hour per agent (rolling).

### `jarate pat-run <request-id> -- <cmd> [args...]`

```
$ jarate pat-run pat_5b0e... -- gh pr create --fill
<child stdout/stderr pass through verbatim>
$ echo $?   # the child's exit code
```

- The child gets `GH_TOKEN`, `GIT_TERMINAL_PROMPT=0`, and git's
  env-config header (`GIT_CONFIG_COUNT/KEY_0/VALUE_0` =
  `Authorization: Bearer <token>`) — the token lives in env, never in
  argv, so `ps` cannot see it.
- Command cap: `JARATE_PAT_RUN_TIMEOUT_S` seconds (default 900; a clone
  can take 10 min). On cap the child process group is SIGKILL'd, the
  wrapper exits **124 with no JSON doc** (partial child output still
  passes through). rc 124 is a command timeout, not a vault error.
- Vault errors (command never ran) are rc 1 + JSON doc:
  `state: pending (awaiting approval)`, `state: expired at ...`,
  `state: already used`, `unknown id`,
  `scope: token file missing: <path> — restore the file, then re-run:
  `jarate pat-run <id> -- <cmd>`; ...` (also `token file empty` /
  `token shape invalid` variants),
  `file missing: <path>` (file mode). The error carries the exact next
  command — copy it.
- The id is single-use: one approve = one run. Re-running the same id
  gets `state: already used`.

### `jarate pat-status [request-id]`

Read-only. No id = this agent's non-terminal requests + budget headroom.
With id = the full record. The token is never in the output.

```
$ jarate pat-status
{"ok":true,"pending":[{"id":"pat_5b0e...","state":"approved","scope":"marzukia/jarate:write","claim_deadline":"..."}],"budget":{"approvals_last_hour":2,"cap":5}}
```

## Quoting semantics (tool path)

`bin/jarate` dispatches `pat-run` two ways (N4):

- **Bash path** (workers, orchestrator shell): everything after `--`
  arrives as real argv — lossless, no shell.
  `jarate pat-run pat_x -- git commit -m "fix: x"` — your own shell
  parses the quotes first, exactly as usual.
- **Tool path** (LLM via the `jarate` pi tool): the whole tail arrives as
  ONE word (`pat_x -- git commit -m "fix: x"`). `bin/jarate` sees a
  single-arg tail, takes the first token as the id, and hands the rest to
  `jarate-pat run-raw`, which parses it with a shell-words parser
  (`shellWords`): splits on unquoted whitespace; single quotes preserve
  literally; double quotes honor `\"` and `\\`; a backslash outside
  quotes escapes the next char; **no expansion** — `$var`, backticks and
  globs stay literal.

What you type is what the child receives, minus quote-stripping and
backslash escapes. `git commit -m "fix: x y"` -> one argv element
`fix: x y`. `-m 'cost is $5'` -> literal `cost is $5` (the bash path
would have expanded `$5` in your own shell first — inherent path
difference, not a bug). Unterminated quote or trailing backslash -> rc 2
usage.

The parsed tokens must start with an unquoted `--`; 1-200 command args,
each <= 4096 chars.

## Files on the box

| path | what |
|---|---|
| `$XDG_RUNTIME_DIR/jarate/pat.sock` | vault socket (0700 dir). Override: `JARATE_PAT_DIR`. |
| `$XDG_RUNTIME_DIR/jarate-pat/pat-<id>` | published token file (file mode only; 0600, swept at boot, deleted after read). Override: `JARATE_PAT_FILE_DIR`. |
| `~/.config/marzukia-pats/` | token store (above). Override: `JARATE_PAT_PATS_DIR`. |
| `~/.jarate/pat-audit.log` | audit trail, JSON lines. Override: `JARATE_PAT_AUDIT_FILE`. |
| `~/.tmp/pat-vault.json` | persisted state (requests + approvals + budget stamps). Bridge cwd is `$HOME`. |

Bridge-side tuning env (set on `pi.service`, not per-call):
`JARATE_PAT_TTL_MS` (default 0 = no TTL, pending blocks until tap), `JARATE_PAT_CLAIM_MS` (60000),
`JARATE_PAT_MAX_PENDING` (1), `JARATE_PAT_BUDGET_PER_HOUR` (5),
`JARATE_PAT_CENSOR_GRACE_MS` (10000), `JARATE_PAT_TRANSPORT`
(`socket` default | `file`).

### Transport fallback

Default is **socket mode**: the bridge reads the token file at handoff
and sends the token over the unix socket to the wrapper (one line, 0600
dir, same user). **File mode** (`JARATE_PAT_TRANSPORT=file`): the bridge
publishes the token to `$XDG_RUNTIME_DIR/jarate-pat/pat-<id>` (mkstemp +
atomic rename, 0600) at approve; the wrapper reads + unlinks it.
Switch it when socket delivery is suspect (e.g. debugging); both modes
enforce the same state machine, shape checks, and done accounting.

## Audit log

`~/.jarate/pat-audit.log`, one JSON line per event: `request`,
`approve`, `deny`, `expire-ttl`, `expire-claim`, `handoff` (with
`transport` + token `kind`, never the value), `done` (with `rc`),
`recovered-*`, `sweep`, `post-fail`, `vault-error`, `non-owner-tap`.
Inspect: `tail -20 ~/.jarate/pat-audit.log | jq .`.

## Failure modes

| symptom | cause / behavior | fix |
|---|---|---|
| `vault unavailable: no socket at ... (pi.service down?)` rc 1 | bridge not running | start pi.service; retry (request is idempotent — nothing was posted) |
| `pending: pat_x ...` rc 1 | another request is pending for this agent | let the owner tap (deny) to clear it — or wait out the TTL if one is set |
| `budget: 5 approvals in last hour; next slot ...` rc 1 | rolling budget cap | wait for the hour to roll |
| `scope: unknown '...' (known: ...)` rc 1 | no token file for that scope | create the file (above), retry |
| `state: already used` rc 1 | the id was run | re-request a fresh id |
| `scope: token file missing: <path> — ...` rc 1 (request stays approved) | store file missing/empty/bad-shape between approve and run | copy the exact next command from the error doc: fix + re-run this id, or re-request past the 60s claim window |
| approve tap: non-ephemeral `[!] approve blocked: token file ... for <scope>` in the channel (no state change) | store file missing/empty/bad-shape at tap time (both transports) | restore/fix the file, then re-tap — or re-request (the followup names the exact command) |
| exit 124, no JSON, partial output | command hit the 900s cap | make the command faster / split it; re-request |
| `file missing: <path>` rc 1 (file mode) | bridge restarted between publish and read (boot sweep) | retry inside the claim window (re-approve republishes); else re-request |
| double tap / stale copy of the button message | dedupe by `d.id` + state check | ephemeral `already handled` / `not found or already handled`; nothing consumed |
| non-owner taps | deliverable ephemeral `[!] only the owner...` | owner taps later (pending does not expire by default) |
| vault request-only (run lines get `vault unavailable`) | socket dir not writable / EADDRINUSE twice | fix dir perms, restart bridge |

Every tap gets visible feedback: a message edit on success/deny/expire,
an ephemeral followup on gate failures, and — a dead token file at
approve time — a NON-ephemeral channel followup naming scope + file +
the exact next command (the request stays pending; re-tap after the
fix). A tap never crashes the bridge (`handlePatComponent` never
rejects; an error followup is an outcome, not a rejection; the
dispatch line carries a `.catch` backstop).

## Onboarding a new agent box

1. Deploy the agent (pi + bridge) — `docs/NEW-AGENT.md`.
2. Create the token store under that agent's user:
   `~/.config/marzukia-pat` (classic, scope `default`) and/or
   `~/.config/marzukia-pats/<owner>/<repo>:<perm>` files, all 0600.
   These are per-user: the vault runs as the agent's uid, and the
   socket lives in that user's `$XDG_RUNTIME_DIR` — no cross-user
   access, no setuid, no group-readable token.
3. `install.sh` (links `~/bin/jarate-pat` next to `~/bin/jarate`).
4. Restart the bridge via the normal self-update flow (the vault starts
   with the channel connect; do not restart `pi.service` from within a
   task).
5. Smoke test: `jarate pat-request default "smoke test"` -> approve ->
   `jarate pat-run <id> -- echo ok` -> `jarate pat-status <id>` shows
   `run_rc: 0`.

## Invariants (what the design guarantees)

1. Only the bridge reads a PAT file (at handoff/approve, approved scope
   only).
2. Only the owner's tap mutates a request; every other tap is
   replied + audit-logged, state untouched (gate failures get an
   ephemeral reply; a dead token file at approve time gets a
   non-ephemeral followup naming the file + next command).
3. One tap = one token = one command; the id is single-use.
4. The token is in at most 3 places at once: bridge memory, the bun
   wrapper, one child's env. Never in argv, never in a file (socket
   mode), never in the LLM context (agents only see ids + status JSON).
5. Every secret lifetime is timer-owned by the bridge (pending TTL
   opt-in, claim 60s, censor grace 10s, startup sweep). Early cleanup by
   the agent is optional, never the guarantee.
6. Budget is enforced where the token is (bridge), not where the agent
   can bypass it (CLI).
7. Restart-safe: state, approvals, and the sweep survive bridge
   restarts; anything in the file dir at boot is stale and swept.
8. Egress censor: the token value is registered as a runtime secret for
   its whole lifetime; anything it appears in (child stdout/stderr
   echoed by the agent later, a reason string typo) is redacted at post
   time.

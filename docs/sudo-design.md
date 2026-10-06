# Sudo through the vault - pipe-first, zero-inference

Design doc for operator grants (sudo) routed through the vault (issue
#149). Builds on the generic vault (`docs/vault-design.md`) and the proven
sshpass/sudo hop already in `bin/jarate` (issue #121). Additive: raw
`vault-request` / `vault-run` keep today's exact semantics, and `pat-*`
stays byte-for-byte unchanged.

Phasing status at time of writing: PR 1 of the issue's plan (#148 one flag
grammar + #147 hop derivation) is already merged (66ae6ee1, PR #154).
This doc designs PR 2 (core) and PR 3 (surface), and records the operator
decisions from the issue thread (Andryo, 2026-10-05).

## 1. Motivation: what inference costs

Inference = a place where the agent must guess, remember, or interpret.
Every decision in this doc is judged by one test: *can an agent perform
the correct next action by copying a command from machine output, with
zero interpretation?*

| Inference point seen live (2026-10-05 session) | source |
|---|---|
| is this callback real or a nested run? | run-id env leak (twice) |
| which flag form works on which path? | #148 (fixed in PR #154) |
| is the run done? when to poll? | no blocking wait on the run path |
| where is the password? which file? | `~/.config/sudo-pass` vs vault known store |
| who is the hop user on this box? | #147 (fixed in PR #154) |
| do I still hold the grant? | agent tracks id + expiry in its own head |

The run-id env leak is the worst case: the agent must carry the request id
in its own context between `vault-request` and `vault-run`, and a stale id
leaked from a nested run reads as a plausible id. The fix is to remove the
id from the agent's world for the sudo path entirely.

## 2. Current gap

What exists today:

- Generic vault (`docs/vault-design.md`): `vault-request` -> owner tap ->
  `vault-run`; kinds `github-pat` / `api-key` / `password`; levels
  one-shot / time-boxed (`--hours 1..72`) / permanent. The known store
  `~/.jarate/vault/known/<kind>/<name>` is re-read at every handoff
  (rotation-aware). Bridge side: `packages/bridge/channel/vault.ts`.
- Proven sudo hop (issue #121): `sshpass -e` + password over ssh stdin
  exactly once + remote 0600 mktemp file + `sudo -S < file`. The password
  sits in neither local argv nor remote argv. `bin/jarate:383`
  (`run_remote_probe`).
- Ad-hoc password source: `$JARATE_SUDO_PASS` or `~/.config/sudo-pass`
  (`bin/jarate:385`). Outside the vault: no approval gate, no budget, no
  JSON audit, no egress-censor registration for the value.
- Hop target derivation (issue #147, merged): the unique local user with
  uid > 900 + home + login shell + sudo-group membership
  (`bin/jarate:107`, `hop_target`); zero or multiple candidates get the
  exact `JARATE_SSH_HOST=<user>@127.0.0.1` override in the error
  (`bin/jarate:158,160`).

Gaps that `jarate sudo` closes:

1. **Two steps, id in the agent's head.** `vault-run` on a pending id
   returns `state: pending (awaiting approval)` (`vault.ts:1197`). The
   agent must remember the id and re-run to poll; each re-run gets the
   same error back until the tap lands. Zero-inference wants one command
   that blocks on the tap.
2. **No blocking wait.** The run path replies immediately
   (`bin/jarate-vault:404-410`, 15 s reply timeout at `:52`); the tap can
   arrive minutes later.
3. **Hour-only granularity.** `--hours 1..72` (`vault.ts:945`); a 10-minute
   grant is the sudo default and there is no way to express it.
4. **Password outside the vault.** No gate, no per-agent budget, no
   structured audit, no censor registration.
5. **Grant state in the agent's head.** "Do I still hold the grant?" is
   answered from the agent's memory of ids and expiries, not from a query.

## 3. Doctrine (five rules, issue #149 s1)

1. **One doc out.** Every non-child outcome: exactly one JSON doc on
   stdout (`ok` + `error`), fixed rc semantics (0 child ok / 1
   vault-or-usage error / 2 usage / 124 command cap). A successful child
   run prints the child's bytes verbatim (it is the pipe), no doc.
2. **Executable errors.** Every `error` string carries the exact next
   command. The agent copies; it does not think. (Generalises the #144
   rc=4 pattern to doctrine.)
3. **One flag grammar.** `--flag value` and `--flag=value` both accepted,
   normalised internally. The tool path splits the args string with the
   same `shellWords` parser the vault command tail uses
   (`bin/shell-words.ts`). Merged in PR #154.
4. **One secret store.** `~/.jarate/vault/known/<kind>/<name>` (0600,
   rotation-aware at handoff). `~/.config/sudo-pass` is migrated by
   install.sh (audited); the compat read is removed next minor.
5. **Secrets cross pipes, never argv.** stdin/env/socket only. Egress
   censor + audit invariants unchanged.

## 4. The command: `jarate sudo`

```
jarate sudo [--ttl=10m] [--wait=5m] "<reason>" -- <cmd...>
```

One command, whole lifecycle. The agent never sees a request id; the
command blocks on the vault socket until the owner taps (or the wait
deadline passes); the child runs under the password; rc and bytes
pass through.

### 4.1 Sequence

```
agent:    jarate sudo --ttl=10m "stop qemu-nf-hr-r1" -- systemctl stop qemu-nf-hr-r1
   |   bin/jarate (bash, thin dispatch; tool path: one pre-joined arg, #148)
   v
   bin/jarate-vault (bun; the only process that sees the value
   |   besides the bridge and the one child it spawns)
   |   unix socket, one line: op "vsudo"
   |   {kind:"password", name:"sudo", ttl_ms, wait_ms, reason, cmd,
   |    timeout_s, agent}
   v
   bridge (packages/bridge/channel/vault.ts, in pi process, per channel)
   |   1. validate: known file exists, pending cap, budget
   |   2. ATTACH if this agent already has a live sudo credential:
   |        active + inside window  -> handoff now (no button, no budget)
   |        pending + inside wait   -> attach waiter to the live button
   |   3. else mint id (vault_...), state pending, ttlDeadline = now+wait_ms
   |      post [Approve][Deny] (kind=password name=sudo, time-boxed)
   |      register waiter on (id, socket), HOLD the reply
   |   ~ owner tap / deny / deadline / revoke ~
   |   4a. approve: re-read known file NOW (rotation-aware), flip
   |       active, arm window timer (ttl_ms), flush value line over the
   |       SAME socket
   |   4b. deny / deadline / revoke: flush error doc + exact re-run
   v
   wrapper: value -> SSHPASS env of ONE child (never argv)
   child:   SSHPASS="$pw" sshpass -e ssh $HOP_TARGET \
             "read -r pw; pwf=$(mktemp); chmod 600 \"$pwf\";
              printf '%s\n' \"$pw\" > \"$pwf\";
              sudo -S < \"$pwf\" -u <user|root> bash -c '<cmd>';
              rc=$?; rm -f \"$pwf\"; exit $rc" <<<"$pw"
   |   (the bin/jarate:383 shape, #121; <user> = hop user by default,
   |    -u passes through for cross-user)
   v
   wrapper sends vdone {id, rc}; bridge records use+done; the window keeps
   running for reuse until expiry (timer-owned, invariant 6)
```

### 4.2 TTL grammar

- One flag `--ttl` (m|h, `[1-9][0-9]*m|h`, range 1m..72h) replaces
  `--hours`. `--hours=N` stays as sugar for the deprecation window and
  maps to `ttlMs = N*3600_000`.
- Internal unit is `ttlMs` on the credential record (`vault.ts:94`
  `hours` field), computed at approve (`vault.ts:1788`); the bridge timer
  owns expiry (invariant 6 unchanged; lazy check at `vault.ts:1183`).
- Omitted `--ttl` defaults to **10m** (confirmed, Q3). Never permanent by
  default: sudo grants are always time-boxed, never one-shot (a tap per
  command is the friction this exists to remove), never permanent.
- Reuse inside the window: a second `jarate sudo` while `active`
  hands off directly; each handoff is an audit `use` with rc. No new
  button, no budget spend (the budget counts approvals).

### 4.3 Wait (per-request pending deadline, Q2)

- `--wait` (m|h, 1m..60m, default 5m = `JARATE_VAULT_TTL_MS`,
  `vault.ts:2011`). The wait value IS the pending deadline: the button's
  expiry, not a guess. Confirmed per-request by Andryo (2026-10-05); the
  5m default stands as the fallback.
- Blocking wait mechanics: the bridge already keeps the vrun socket
  connection open through the done-wait (`vault.ts:1559-1598`); the same
  mechanism holds the reply while state is `pending`. A waiter registry
  `id -> {socket, reply, deadline}` is woken by the approve tap
  (`vault.ts:1734` region), the deny tap, `settleTtl` (`vault.ts:664`),
  and revoke. The wrapper extends its reply timeout to `wait_ms + margin`
  (today 15 s, `bin/jarate-vault:52`).
- No polling anywhere: the bridge pushes the settle over the socket.

### 4.4 Cross-user and local root

- The hop to the operator account (`hop_target`, `bin/jarate:107`) is THE
  canonical root path; local root and cross-user are the same command
  (docker, firewall, uosserver: one shape).
- `-u` passes through to sudo:
  `jarate sudo --ttl=10m "x" -- -u monky XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user ...`
  No second command, no mental model.
- Hop-derivation failures already carry the exact override command
  (`bin/jarate:158,160`); `jarate sudo` inherits that doc shape.

### 4.5 rc and output contract

| outcome | rc | stdout |
|---|---|---|
| child ran | child's rc | child bytes verbatim (pipeable: `jarate sudo ... -- journalctl -n 50 \| jq`) |
| child hit the 900 s cap | 124 | partial child bytes, no doc (existing convention) |
| vault error (deny / wait-expire / window-expire / revoke / bridge down / no known file / budget / pending cap) | 1 | one JSON doc `{ok:false, error}` with the exact next command |
| usage (bad `--ttl`/`--wait` grammar, missing `--`, ...) | 2 | one JSON doc |

The re-run command in an error doc is the SAME `jarate sudo` invocation
(the bridge reconstructs it from the `vsudo` line it received). That is
what makes re-run idempotent (s5).

## 5. Zero-inference contract

- **No id out.** `jarate sudo` never prints an id. Raw `vault-*` ids stay
  for multi-run orchestration (api-keys, fine-grained PATs); for sudo the
  id exists in the state machine and the agent never sees it.
- **Explicit state query.** New `jarate sudo-status` (read-only, over the
  existing `vstatus` agent filter, `vault.ts:1401`): this agent's sudo
  grant or `none`; for `active` it carries `expires`, the remaining
  window, and the exact re-run command. "Do I still hold the grant?" is
  answered by a query, not by memory.
- **Executable errors.** Every `error` carries the exact next command
  (doctrine rule 2), including the `JARATE_SSH_HOST=<user>@127.0.0.1`
  hop override on derivation failure.
- **Blocking wait, no polling.** One command blocks on the socket until
  the tap or the deadline. The agent never polls, never retries blind.
- **Re-run idempotence.** The exact same command, re-run:
  - pending (same agent, inside wait) -> reattach to the live button, not
    a pending-reject;
  - active (same agent, inside window) -> reuse, no new button;
  - terminal state -> fresh request, as today.
  An executable error never tells the agent to do something it already
  did.
- **One flag grammar, one quoting grammar.** `--ttl=10m` == `--ttl 10m`;
  the tool path re-splits with `shellWords` (incl. the
  `YYYY-MM-DD HH:MM:SS` two-word re-join the CLI already expects).

## 6. Pipe-first mechanics (secrets cross pipes, never argv)

Value path (known store, `known/password/sudo`):

```
~/.jarate/vault/known/password/sudo        0600, operator-managed
  -> bridge memory        re-read at handoff (rotation-aware, invariant 1)
  -> socket line          0700 dir, 0600 socket, same uid (file mode: 0600 doc)
  -> wrapper memory       bin/jarate-vault (the only second process)
  -> child env            SSHPASS (never argv, local or remote)
  -> sshpass -e           reads SSHPASS from env (env, not argv)
  -> ssh stdin            password rides exactly once (herestring)
  -> remote              mktemp 0600 file, sudo -S < file, rm  (#121, bin/jarate:383)
```

- **ps sweep:** the value is absent from local `/proc/*/cmdline` AND from
  remote argv (test: run the hop with a canary value, sweep both sides).
- **Censor:** the value is registered as a runtime secret for the handoff
  lifetime (invariant 9); child stdout quoted back to the channel is
  redacted at post time.
- **Single-use vs time-boxed:** time-boxed (s4.2). The request id is
  reusable inside the window; the window is the grant.
- **The child IS the hop pipeline.** The bridge's 900 s cap
  (`JARATE_VAULT_RUN_TIMEOUT_S`, SIGKILL process group, rc 124) wraps it
  exactly as today (`bin/jarate-vault:482`).
- **Spawn failure:** value handed off, child never runs -> rc 1 doc
  (`spawn failed: ...`, existing at `bin/jarate-vault:252-259`); the
  window stays `active`, so the same re-run reuses the grant without a
  new tap.
- Egress censor + audit invariants unchanged; `pat-*` byte-for-byte
  (additive rule).

## 7. Store migration (one-time, install.sh; PR 3)

- `~/.config/sudo-pass` (0600) -> `~/.jarate/vault/known/password/sudo`
  (0600), content verbatim (existing `readKnownValue` semantics,
  `vault.ts:357`). Audit event `migrate` (box, src, dst). Old file
  removed. One channel notice per box. Idempotent: already-migrated is a
  no-op; `--dry-run` stays clean (install.sh rule; link section at
  `install.sh:180`).
- Rotation = replace the file; the handoff re-reads (existing
  rotation-awareness, no change).
- **Agent unix passwords DEPRECATED** (Q1, Andryo 2026-10-05): onboarding
  stops `chpasswd` for agent accounts (`docs/NEW-AGENT.md:27`) and locks
  them (`passwd -l <name>`); the operator password through the vault is
  the only credential path for root + cross-user. Scope: NEW-AGENT.md
  runbook line + install.sh migration note (PR 3).

## 8. Audit trail

New / extended JSON lines (`vault.ts:214` `audit`; the value is never in
the audit):

| event | when | fields |
|---|---|---|
| `sudo` | vsudo request posted | id, agent, ttl_ms, wait_ms, reason |
| `sudo-reattach` | same-agent re-run during pending/active | id, state at attach |
| `wait-expire` | wait deadline with no tap | id |
| `migrate` | install.sh store migration (once per box) | src, dst |
| (existing) `approve` / `deny` / `use` / `done` / `expire` / `revoke` / `budget-reject` / `pending-reject` | unchanged | id, actor, rc |

One grant, full trail: `sudo` -> `approve` (actor `discord:<uid>`) ->
`use` (handoff, source `known`) -> `done` (rc) -> [reuse: `use` + `done`]
-> `expire` (window, actor `system`). Query side: `jarate sudo-status` +
`jarate vault-audit`. No agent-side bookkeeping.

## 9. Failure modes

| symptom | cause / behavior | fix (carried in the doc) |
|---|---|---|
| `vault unavailable: no socket at ... (pi.service down?)` rc 1 | bridge not running | start pi.service; re-run (pending survives in state.json; reattach) |
| `state: denied` rc 1 | owner tapped Deny | re-run after asking why |
| `wait: no approval before <deadline>` rc 1 | wait deadline passed | re-run (same command; fresh button) |
| `state: expired at <deadline>` rc 1 | window closed (mid-window re-run) | re-run |
| `state: revoked` rc 1 | owner Revoke tap | re-run (and ask why) |
| `pending: <id> expires <ts>` rc 1 | another request of this agent is pending (a different kind) | wait for its TTL or let the owner deny; re-run: same command |
| `budget: 5 approvals in last hour; next slot <ts>` rc 1 | rolling budget (counts approvals; reuse and reattach do not spend) | wait for the hour to roll |
| exit 124, no JSON, partial output | 900 s cap | make the command faster or split it; grant window untouched |
| child rc != 0, no JSON | the command failed (ssh/sudo/systemd inside the hop) | child stderr passes through verbatim (existing `[jarate:probe]` lines); grant window untouched; fix and re-run |
| `known: no value file for password/sudo (known: ...)` rc 1 | not onboarded / not migrated | run install.sh (migrates) or create the file; re-run |
| `value: shape invalid (password)` rc 1 | known file malformed (empty / newline) | fix the file; re-run |
| zero / multiple hop candidates rc 1 | operator derivation ambiguous | doc names candidates + exact `JARATE_SSH_HOST=<user>@127.0.0.1 jarate sudo ...` (`bin/jarate:158,160`) |
| bridge restart mid-wait | socket drops; pending survives | re-run reattaches to the live button |
| double tap / stale button | seen-set dedupe + state gate (existing) | ephemeral `already handled`; nothing consumed |
| non-owner tap | owner gate (existing) | ephemeral `[!] only the owner...`; owner taps later inside the wait window |

Every tap gets visible feedback; a tap never crashes the bridge
(`handleVaultComponent` never rejects; the dispatch line carries a
`.catch` backstop).

## 10. Test list (issue s6; the workers land all of these)

- sudo: approve -> child rc + verbatim stdout; `| jq` pipe form; deny /
  wait-expire / window-expire-mid-window / revoke-mid-window / 900 s cap
  -> doc + exact re-run command; value absent from local AND remote argv
  (ps sweep); remote `sudo -u` passthrough.
- ttl: 1m..72h grammar edges; `--hours` sugar; expiry timer owned by the
  bridge; default 10m.
- wait: per-request `--wait=30m` deadline; 5m default; block -> tap ->
  unblock (no polling); reattach on re-run during pending; bridge
  restart mid-wait -> re-run reattaches.
- reuse: second `jarate sudo` inside the window -> no new button, no
  budget spend, `use_count` increments, each use audited with rc.
- hop: 1-candidate box resolves (hydrogen); 0- and 2-candidate docs carry
  the override command; env override wins. (Merged in PR #154; regression
  coverage.)
- flags: tool-path `shellWords` split (incl. the two-word date re-join);
  `=` form parity. (Merged in PR #154; regression coverage.)
- status: `sudo-status` active / none shapes; re-run command present in
  the active doc.
- migration: idempotent install.sh; `migrate` audit line; old file gone;
  `--dry-run` clean.

## 11. Phasing (each PR: worker -> reviewer -> owner approval -> merge, per the gate)

1. **PR 1 (fixes): MERGED** (66ae6ee1, PR #154). #148 tool-path
   `shellWords` + #147 hop derivation.
2. **PR 2 (core)**: `--ttl` grammar (m|h, 1m..72h) + `ttlMs` in the state
   machine (minutes unit) + per-request `--wait` pending deadline +
   blocking wait on the run path (`vsudo` op, waiter registry, reattach)
   + `sudo-status` query.
3. **PR 3 (surface)**: `jarate sudo` command + install.sh store migration
   + NEW-AGENT.md runbook line + agent-unix-password deprecation. #145 PR
   B (daemonize) remains orthogonal, unchanged.

## 12. Open for the operator

Issue s8 resolved (Andryo, 2026-10-05): Q1 agent unix passwords
deprecated (PR 3); Q2 per-request `--wait`, 5m default fallback (PR 2);
Q3 default `--ttl` = 10m. Spec correction s3: operator = the unique local
user with uid > 900 + home + login shell + **sudo-group membership**
(`wheel` / `sudo`), not the pi.service check (the `uosserver`
counter-example) - already implemented in `hop_target`
(`bin/jarate:107`).

Remaining:

1. `--wait` range cap: 60m proposed. Beyond that, the pending button is
   longer than any sane attention window; confirm the cap.
2. Reattach on re-run during pending (same agent): proposed. A different
   pending kind for the same agent still `pending-rejects` (1
   pending/agent cap, `vault.ts:1054`). Confirm.
3. Known-store name: fixed `password/sudo` per box (all agents on a box
   share the operator password; vault state is per agent channel, the
   store is per box). Confirm.
4. Hop-only root path: no local `sudo -S` shortcut for boxes where sshd
   is not on 127.0.0.1 (hydrogen has sshd; fleet standard). Confirm.

## Implementation map (anchors at e6f097c1)

| file | role |
|---|---|
| `packages/bridge/channel/vault.ts` | state machine + socket server. PR 2: `ttlMs` on the record (`:94`, `:945`, `:1788`); per-request `--wait` deadline (`:2011` default, `:664` `settleTtl`); `vsudo` op + waiter registry (server loop `:1544-1559`; `vaultRunBegin` pending path `:1196`; approve tap `:1782`); reattach (pending scan `:1054`); `sudo-status` over `vstatus` agent filter (`:1401`); new audit events (`:214`). |
| `bin/jarate-vault` | bun wrapper (the only process that sees the value besides bridge + child). PR 2/3: `sudo` + `sudo-status` subcommands (request+run session; `cmdRun` `:397`; reply timeout `:52` extended by wait_ms); SSHPASS as the password-kind envvar for the sudo child; re-run command in error docs. |
| `bin/jarate` | bash dispatch. PR 3: `sudo` / `sudo-status` forwarding (run-raw dispatch pattern `:1708` (pat), `:1762` (vault)); hop target + password source for the child pipeline (`:107`, `:385`); the `run_remote_probe` shape (`:383`) becomes the sudo child. |
| `install.sh` | PR 3: sudo-pass -> known-store migration (idempotent, `--dry-run` clean; link section `:180`). |
| `docs/NEW-AGENT.md` | PR 3: sudo-pass convention note (`:31-33`) -> vault known store; `chpasswd` deprecation (`:27`). |
| `packages/bridge/channel/vault.test.ts` | bridge tests: vsudo approve / deny / wait-expire / reattach / reuse / restart (fake Discord, fake clock, real sockets in mkdtemp - existing harness). |
| `bin/jarate-vault.test.ts` | wrapper tests: fake vault server, child env/cmdline capture (existing harness); ps-sweep test for the value. |

## Unchanged (deliberately)

Button model, owner-only taps, budget (approvals, not runs), censor,
audit shape, socket/file transport, the ten invariants (`docs/VAULT.md`),
and `pat-*` byte-for-byte (additive rule). Raw `vault-request` /
`vault-run` stays for multi-run orchestration (api-keys, fine-grained
PATs); `jarate sudo` is the pipe form over the same state machine - the
id exists, the agent never sees it.

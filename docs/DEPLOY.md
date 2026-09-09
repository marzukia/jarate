# Deploy

How the jarate stack lands on an agent box, and per-agent notes.

## Quickstart

```bash
git clone <jarate> && cd jarate
./install.sh --dry-run    # show what would change
./install.sh              # do it
```

After installing, restart the agent's pi service if it is running:

```
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service
```

(`install.sh` never restarts pi itself.)

## What install.sh does

`install.sh` is idempotent. Flags: `--dry-run`, `--piscord-dir DIR`, `-h`.

1. **piscord sync** — `rsync -a --delete` from `piscord/` to `$PISCORD_DIR`
   (default `~/.pi/agent/piscord`), excluding `.git` and `node_modules` at the
   destination. Then `bun install` **only if `package.json` changed**
   (sha256 compare; skipped silently otherwise).
2. **dispatch scripts** — copy `dispatch/pi-bg`, `dispatch/pi-wait` to
   `~/scripts/` (a pre-existing symlink is replaced, not modified).
3. **agent-say** — copy `bin/agent-say` to `~/bin/agent-say` (same symlink
   handling).
4. **git hooks** — in the source checkout,
   `git config core.hooksPath .githooks` (idempotent; no-op if the source is
   not a git checkout).

Guarantees:

- **Never touches `~/.pi/agent/settings.json`** — it lives outside the sync
  dir.
- **Never restarts or kills pi processes** — prints a restart reminder.
- **`--dry-run` prints every action** and changes nothing (including the git
  config step).

Verify a sync:

```bash
cd piscord && bun install
bun x tsc --noEmit
bun x bun test    # 168 pass
```

## Per-agent notes (marzuki-hydrogen)

### monky

- Bridge: `~/.pi/agent/piscord` (plain dir, rsynced — no `.git`).
- Default `./install.sh` is exactly right.
- Dispatch config: `~/.config/pi-dispatch/webhook` (incoming webhook URL),
  `~/.config/pi-dispatch/webhook_author` (webhook author id, used by
  `pi-wait`).

### frank (cross-user pattern)

frank's bridge is a **git checkout** at `/home/frank/git/piscord`; keep its
`.git`, and do NOT restart his pi.service. Run install.sh as frank:

```bash
sshpass -p 'phishasu' ssh andryo@127.0.0.1 \
  "echo 'phishasu' | sudo -S -u frank XDG_RUNTIME_DIR=/run/user/1002 \
   bash -c 'cd /path/to/jarate && ./install.sh --piscord-dir /home/frank/git/piscord'"
```

Notes:

- `--piscord-dir` points rsync at the checkout; `--delete` still applies but
  `.git`/`node_modules` are excluded, so frank's local git state survives.
- `XDG_RUNTIME_DIR=/run/user/1002` is required for `systemctl --user` when
  invoking via sudo.
- monky has no key/passwordless-sudo path to frank yet — this sshpass hop
  (as `andryo`, password `phishasu`) is the working cross-user path.
- Do the work under a user that can read the checkout; the checkout must be
  world/group-readable by frank.

## Adding a new agent

1. New pi home + Discord bot + private channel.
2. `settings.json` with the discord channel entry (botToken, channel id,
   ownerUserId, `default: true`).
3. Incoming webhook on the channel → `~/.config/pi-dispatch/webhook`;
   webhook author id → `~/.config/pi-dispatch/webhook_author`.
4. Role profiles `~/.pi/agent-worker` / `~/.pi/agent-reviewer` (same AGENTS
   profile docs, own session dirs).
5. `./install.sh` as that user.

See [DISPATCH.md](DISPATCH.md#extending-to-other-agents) for the
orchestration side.

## Repo rules

- `main` is protected (branch rule `protect-main`: non-fast-forward only).
  All changes land by PR; see [CONTRIBUTING.md](../CONTRIBUTING.md).
- `marzukia/piscord` is the legacy upstream; **jarate is the source of truth**
  going forward. Do not edit it directly — change `piscord/` here and merge.

# Deploy

The jarate checkout **is** the deployment. No rsync, no copies of repo files —
machine paths are symlinks into the checkout (bootstrap `install.sh` v3,
2026-09-10: "no more rsync biz").

## Quickstart

```bash
./install.sh                 # bootstrap in ~/projects/jarate
./install.sh --jarate-dir D  # bootstrap a specific checkout
./install.sh --dry-run       # show what would change
```

Per-agent finish (once, manual):

```json
// ~/.pi/agent/settings.json
"packages": ["<jarate>/packages/bridge"]
```

```bash
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service
```

## What install.sh does

Idempotent. Flags: `--jarate-dir DIR`, `--clone-url URL`, `--dry-run`, `-h`.

1. **checkout** — clones if missing; `fetch` + `pull --ff-only` otherwise
   (skips pull when the tree is dirty).
2. **bridge deps** — `bun install` in `packages/bridge` (node_modules is
   gitignored, machine-local).
3. **pointer links** — symlinks, never copies:
   - dispatch family (issue #151): each of `jarate-bg`, `jarate-wait`,
     `jarate-bg-tail`, `jarate-bg-kill`, `jarate-bg-watchdog`, the
     `pi-wait` deprecation shim, and `pi-postcheck.sh` is linked into BOTH
     `~/.local/bin` and `~/scripts` -> `<jarate>/dispatch/<name>`. Post-install verify fails
     the run (non-dry) if any of the 7 is missing or shadowed by a stale
     non-symlink in the unit PATH.
   - `~/scripts/jarate` -> `<jarate>/bin/jarate`
   - stale `~/projects/recall` symlink cleanup: a dangling link pointing at
     the removed `packages/recall` is removed (RAG/recall removed 2026-10-17
     (fleet order); the rag Postgres data is kept but unused); a live dir or
     foreign link is left untouched

Guarantees:

- **Never touches `~/.pi/agent/settings.json`** (prints the line to set).
- **Never restarts or kills pi processes** (prints a reminder).
- **No rsync, no file copies** of repo content.
- Machine-local state (`node_modules/`, `.venv/`, `__pycache__/`) lives in
  the checkout and is gitignored.

## Deploying an update

```bash
cd <jarate> && git pull --ff-only
# done. jarate-bg/jarate-wait are symlinks - they update instantly.
# Only bridge (channel/) changes need a pi.service restart.
```

## RAG / recall

RAG/recall removed 2026-10-17 (fleet order); the rag Postgres data is kept
but unused. `install.sh` never touches the database.

## Migrating a box off the old rsync layout (one-time)

The old layout rsynced `packages/bridge/` -> `~/.pi/agent/piscord` and a
real RAG dir into `~/projects/`. The RAG side is settled by the 2026-10-17
removal: the old RAG dir is plain junk — `rm -rf` it (the rag Postgres data
is kept but unused). To migrate the bridge side of an agent:

```bash
cd <jarate> && git pull --ff-only
# 1. bootstrap (makes the symlinks, bun install)
./install.sh --jarate-dir <jarate>
# 2. repoint settings.json packages -> <jarate>/packages/bridge
# 3. ONE restart:
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service
# 4. verified on the new tree -> sweep the old copies
rm -rf ~/.pi/agent/piscord        # old bridge rsync dest (monky)
rm -rf ~/git/piscord              # old standalone checkout (frank)
```

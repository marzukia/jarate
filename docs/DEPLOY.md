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
   - `~/scripts/pi-bg` -> `<jarate>/dispatch/pi-bg`
   - `~/scripts/pi-wait` -> `<jarate>/dispatch/pi-wait`
   - `~/bin/agent-say` -> `<jarate>/bin/agent-say`
   - `~/projects/recall` -> `<jarate>/packages/recall` (only if the dest is
     absent or already this symlink; replaces the old `pgrag` symlink)

Guarantees:

- **Never touches `~/.pi/agent/settings.json`** (prints the line to set).
- **Never restarts or kills pi processes** (prints a reminder).
- **No rsync, no file copies** of repo content.
- Machine-local state (`node_modules/`, `.venv/`, `__pycache__/`) lives in
  the checkout and is gitignored.

## Deploying an update

```bash
cd <jarate> && git pull --ff-only
# done. pi-bg/pi-wait/agent-say/recall are symlinks - they update instantly.
# Only bridge (channel/) changes need a pi.service restart.
```

## recall (packages/recall)

Source of truth: `packages/recall/` in this repo (TypeScript port of the
Python pgrag, 2026-09-10; full git history of monkytheluffy/pgrag lives
under `packages/memory/` in the old refs). The box copy `~/projects/recall`
is a **symlink** into the checkout; it **replaces the old `~/projects/pgrag`
symlink** (orchestrator migrates the box link).

No venv: deps install with the workspace `bun install`. Smoke test:

```bash
cd <jarate>/packages/recall && bun recall query "ping"
```

The db `rag` data is unchanged — no data migration; only the CLI moved from
`uv run` to `bun recall`. Fresh DB setup (role, embed host, first ingest,
env): see PGRAG-SETUP.md. `install.sh` never touches the database.

## Migrating a box off the old rsync layout (one-time)

The old layout rsynced `packages/bridge/` -> `~/.pi/agent/piscord` and
`pgrag/` -> `~/projects/pgrag` (real dir). To migrate an agent:

```bash
cd <jarate> && git pull --ff-only
# 1. move machine-local pgrag state into the checkout
mv ~/projects/pgrag/.venv <jarate>/packages/recall/.venv   # if present
rm -rf ~/projects/pgrag                                     # old rsync dest
# 2. bootstrap (makes the symlinks, bun install)
./install.sh --jarate-dir <jarate>
# 3. repoint settings.json packages -> <jarate>/packages/bridge
# 4. ONE restart:
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service
# 5. verified on the new tree -> sweep the old copies
rm -rf ~/.pi/agent/piscord        # old bridge rsync dest (monky)
rm -rf ~/git/piscord              # old standalone checkout (frank)
```

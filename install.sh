#!/usr/bin/env bash
# jarate installer — idempotent.
#
# Syncs the pi agent stack onto the calling user's box:
#   1. piscord/  -> $PISCORD_DIR (default ~/.pi/agent/piscord)
#      rsync --delete, preserves .git and node_modules at the destination.
#      Runs `bun install` there only if package.json changed.
#   2. dispatch/pi-bg, dispatch/pi-wait -> ~/scripts/
#   3. bin/agent-say -> ~/bin/agent-say
#   4. pgrag/  -> ~/projects/pgrag
#      rsync --delete, keeps .git/__pycache__/.venv at the destination;
#      --delete is skipped if the destination is a git repo with uncommitted
#      changes.
#   5. git config core.hooksPath .githooks (source checkout only, idempotent)
#
# Usage:
#   ./install.sh [--dry-run] [--piscord-dir DIR] [--pgrag-dir DIR]
#
# Guarantees:
#   - never touches ~/.pi/agent/settings.json (it lives outside $PISCORD_DIR)
#   - never restarts or kills pi processes; prints a restart reminder
#
# Frank variant (bridge is a git checkout, keep its .git, don't restart):
#   ./install.sh --piscord-dir /home/frank/git/piscord

set -euo pipefail

DRY=0
PISCORD_DIR="${HOME}/.pi/agent/piscord"
PGRAG_DIR="${HOME}/projects/pgrag"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --piscord-dir) PISCORD_DIR="${2:?--piscord-dir needs a path}"; shift ;;
    --pgrag-dir) PGRAG_DIR="${2:?--pgrag-dir needs a path}"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,22p'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run() {
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

[ -d "$SRC/piscord" ] || { echo "install.sh: $SRC/piscord missing (run from the jarate checkout)" >&2; exit 1; }
command -v rsync >/dev/null || { echo "install.sh: rsync not found" >&2; exit 1; }

echo "== jarate install (dry-run=$DRY, user=$(id -un))"

# --- 1. piscord sync ------------------------------------------------------
pkg_hash() { sha256sum "$1" | cut -d' ' -f1; }
src_pkg="$SRC/piscord/package.json"
pre_pkg=""
[ -f "$PISCORD_DIR/package.json" ] && pre_pkg="$(pkg_hash "$PISCORD_DIR/package.json")"
post_pkg_hash="$(pkg_hash "$src_pkg")"

if [ "$DRY" = 1 ]; then
  echo "[dry-run] rsync -a --delete --exclude .git --exclude node_modules $SRC/piscord/ $PISCORD_DIR/"
else
  mkdir -p "$PISCORD_DIR"
  rsync -a --delete --exclude .git --exclude node_modules "$SRC/piscord/" "$PISCORD_DIR/"
fi
echo "  piscord: $SRC/piscord/ -> $PISCORD_DIR"

if [ "$pre_pkg" != "$post_pkg_hash" ]; then
  if command -v bun >/dev/null; then
    run bun install --cwd "$PISCORD_DIR"
    echo "  bun install: ran (package.json changed)"
  else
    echo "  WARN: package.json changed but bun not found; skipping bun install"
  fi
else
  echo "  bun install: skipped (package.json unchanged)"
fi

# --- 2. dispatch scripts ---------------------------------------------------
run mkdir -p "$HOME/scripts"
for s in pi-bg pi-wait; do
  dest="$HOME/scripts/$s"
  if [ -L "$dest" ]; then
    # replace a symlink (e.g. pointing at a pi-dispatch checkout) without
    # modifying the link target
    if [ "$DRY" = 1 ]; then
      echo "[dry-run] rm symlink $dest"
    else
      rm "$dest"
    fi
  fi
  run cp -f "$SRC/dispatch/$s" "$dest"
  run chmod +x "$dest"
  echo "  dispatch: $s -> $dest"
done

# --- 3. bin/agent-say ------------------------------------------------------
run mkdir -p "$HOME/bin"
if [ -L "$HOME/bin/agent-say" ]; then
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] rm symlink $HOME/bin/agent-say"
  else
    rm "$HOME/bin/agent-say"
  fi
fi
run cp -f "$SRC/bin/agent-say" "$HOME/bin/agent-say"
run chmod +x "$HOME/bin/agent-say"
echo "  bin: agent-say -> $HOME/bin/agent-say"

# --- 4. pgrag sync ---------------------------------------------------------
# Protect a destination git repo with uncommitted changes: never run
# rsync --delete there (same protect-discipline as settings.json).
if [ "$DRY" = 1 ]; then
  echo "[dry-run] rsync -a --delete --exclude .git --exclude __pycache__ --exclude .venv $SRC/pgrag/ $PGRAG_DIR/"
else
  mkdir -p "$PGRAG_DIR"
  if git -C "$PGRAG_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     && [ -n "$(git -C "$PGRAG_DIR" status --porcelain)" ]; then
    echo "  pgrag: $PGRAG_DIR is a git repo with uncommitted changes; syncing WITHOUT --delete"
    rsync -a --exclude .git --exclude __pycache__ --exclude .venv "$SRC/pgrag/" "$PGRAG_DIR/"
  else
    rsync -a --delete --exclude .git --exclude __pycache__ --exclude .venv "$SRC/pgrag/" "$PGRAG_DIR/"
  fi
fi
echo "  pgrag: $SRC/pgrag/ -> $PGRAG_DIR"

# --- 5. git hooks (jarate checkout only, idempotent) ------------------------
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  run git -C "$SRC" config core.hooksPath .githooks
echo "  git: core.hooksPath -> .githooks (in $SRC)"
fi

# --- summary ---------------------------------------------------------------
echo
echo "== done (settings.json untouched, no pi processes touched)"
echo "REMINDER: restart pi.service to pick up the new piscord, if it is running on this box."
echo "  XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service"

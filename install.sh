#!/usr/bin/env bash
# jarate bootstrap — NO-RSYNC (v3, 2026-09-10, Andryo: "no more rsync biz").
#
# The jarate checkout IS the deployment. This script:
#   1. ensures a checkout exists (--jarate-dir, or clones into it)
#   2. git pull --ff-only on an existing checkout
#   3. bun install in packages/bridge (deps only; node_modules is gitignored,
#      machine-local)
#   4. makes machine paths POINTERS (symlinks) into the checkout:
#        ~/scripts/pi-bg     -> <jarate>/dispatch/pi-bg
#        ~/scripts/pi-wait   -> <jarate>/dispatch/pi-wait
#        ~/scripts/pi-bg-tail -> <jarate>/dispatch/pi-bg-tail
#        ~/scripts/pi-bg-kill -> <jarate>/dispatch/pi-bg-kill
#        ~/scripts/jarate    -> <jarate>/bin/jarate
#        ~/bin/agent-say     -> <jarate>/bin/agent-say
#        ~/bin/jarate-diff   -> <jarate>/bin/jarate-diff
#        ~/bin/jarate        -> <jarate>/bin/jarate
#        ~/projects/recall   -> <jarate>/packages/recall   (only if the dest
#                               is absent or already this symlink)
#
# Deploy after a git pull = nothing. Code is live at the checkout; restart pi
# only to pick up bridge (channel/) changes.
#
# Usage:
#   ./install.sh [--jarate-dir DIR] [--clone-url URL] [--dry-run]
#
#   --jarate-dir DIR   existing checkout (default ~/projects/jarate)
#   --clone-url URL    used only if the checkout is missing
#                      (default https://github.com/marzukia/jarate.git)
#
# Guarantees:
#   - never touches ~/.pi/agent/settings.json (prints the line to set)
#   - never restarts or kills pi processes; prints a restart reminder
#   - never rsyncs or copies repo files; only symlinks + package installs
#   - machine-local state (node_modules, .venv, __pycache__, sessions) lives
#     in the checkout and is gitignored
#
# Per-agent finish (manual, once):
#   settings.json "packages": ["<jarate>/packages/bridge"]
#   then: XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service

set -euo pipefail

DRY=0
JARATE_DIR="${HOME}/projects/jarate"
CLONE_URL="https://github.com/marzukia/jarate.git"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --jarate-dir) JARATE_DIR="${2:?--jarate-dir needs a path}"; shift ;;
    --clone-url) CLONE_URL="${2:?--clone-url needs a url}"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,25p'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

run() {
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

link_into() { # $1 = dest path, $2 = target
  local dest="$1" target="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ]; then
    local cur; cur="$(readlink "$dest")"
    if [ "$cur" = "$target" ]; then
      echo "  link: $dest -> $target (unchanged)"
      return
    fi
    echo "  link: replacing $dest ($cur) -> $target"
    run rm -f "$dest"
  elif [ -e "$dest" ]; then
    echo "  link: $dest exists and is not a symlink; leaving it (handle manually)"
    return
  fi
  run ln -s "$target" "$dest"
  echo "  link: $dest -> $target"
}

echo "== jarate bootstrap (dry-run=$DRY, user=$(id -un))"

# --- 1. checkout -----------------------------------------------------------
if [ ! -d "$JARATE_DIR/.git" ]; then
  echo "  clone: $CLONE_URL -> $JARATE_DIR"
  run git clone "$CLONE_URL" "$JARATE_DIR"
else
  echo "  checkout: $JARATE_DIR"
  run git -C "$JARATE_DIR" fetch origin
  if [ -n "$(git -C "$JARATE_DIR" status --porcelain)" ]; then
    echo "  [!] checkout has uncommitted changes; skipping pull"
  else
    run git -C "$JARATE_DIR" pull --ff-only origin main
  fi
fi

# --- 2. bridge deps ----------------------------------------------------------
if command -v bun >/dev/null; then
  run bun install --cwd "$JARATE_DIR/packages/bridge"
  echo "  bun install: packages/bridge"
else
  echo "  WARN: bun not found; skipping packages/bridge install"
fi

# --- 3. pointer links --------------------------------------------------------
link_into "$HOME/scripts/pi-bg"      "$JARATE_DIR/dispatch/pi-bg"
link_into "$HOME/scripts/pi-wait"    "$JARATE_DIR/dispatch/pi-wait"
link_into "$HOME/scripts/pi-bg-tail" "$JARATE_DIR/dispatch/pi-bg-tail"
link_into "$HOME/scripts/pi-bg-kill" "$JARATE_DIR/dispatch/pi-bg-kill"
link_into "$HOME/scripts/jarate"     "$JARATE_DIR/bin/jarate"
link_into "$HOME/bin/agent-say"      "$JARATE_DIR/bin/agent-say"
link_into "$HOME/bin/jarate-diff"    "$JARATE_DIR/bin/jarate-diff"
link_into "$HOME/bin/jarate"         "$JARATE_DIR/bin/jarate"

# recall: only adopt if the dest is absent or already our symlink (a live
# deployed dir with .venv/.git is migrated manually, see DEPLOY.md)
RECALL_DEST="$HOME/projects/recall"
if [ ! -e "$RECALL_DEST" ] || { [ -L "$RECALL_DEST" ] && [ "$(readlink "$RECALL_DEST")" = "$JARATE_DIR/packages/recall" ]; }; then
  link_into "$RECALL_DEST" "$JARATE_DIR/packages/recall"
else
  echo "  recall: $RECALL_DEST exists (not this symlink); left untouched"
fi

# --- 4. finish ---------------------------------------------------------------
echo
echo "== done (settings.json untouched, no pi processes touched)"
echo "SET THIS IN ~/.pi/agent/settings.json:"
echo "  \"packages\": [\"$JARATE_DIR/packages/bridge\"]"
echo "THEN restart pi to pick up the new bridge:"
echo "  XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service"

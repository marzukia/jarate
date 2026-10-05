#!/usr/bin/env bash
# jarate bootstrap — NO-RSYNC (v3, 2026-09-10, operator: "no more rsync biz").
#
# The jarate checkout IS the deployment. This script:
#   1. ensures a checkout exists (--jarate-dir, or clones into it)
#   2. git pull --ff-only on an existing checkout
#   3. bun install in packages/bridge (deps only; node_modules is gitignored,
#      machine-local)
#   4. makes machine paths POINTERS (symlinks) into the checkout:
#        dispatch family (issue #151) — 5 jarate-* entrypoints + 5 pi-*
#        deprecation shims, each linked into BOTH ~/.local/bin and ~/scripts:
#        {~/.local/bin,~/scripts}/jarate-bg      -> <jarate>/dispatch/jarate-bg
#        {~/.local/bin,~/scripts}/jarate-wait    -> <jarate>/dispatch/jarate-wait
#        {~/.local/bin,~/scripts}/jarate-bg-tail -> <jarate>/dispatch/jarate-bg-tail
#        {~/.local/bin,~/scripts}/jarate-bg-kill -> <jarate>/dispatch/jarate-bg-kill
#        {~/.local/bin,~/scripts}/jarate-bg-watchdog -> <jarate>/dispatch/jarate-bg-watchdog
#        {~/.local/bin,~/scripts}/pi-bg          -> <jarate>/dispatch/pi-bg (shim)
#        {~/.local/bin,~/scripts}/pi-wait        -> <jarate>/dispatch/pi-wait (shim)
#        {~/.local/bin,~/scripts}/pi-bg-tail     -> <jarate>/dispatch/pi-bg-tail (shim)
#        {~/.local/bin,~/scripts}/pi-bg-kill     -> <jarate>/dispatch/pi-bg-kill (shim)
#        {~/.local/bin,~/scripts}/pi-bg-watchdog -> <jarate>/dispatch/pi-bg-watchdog (shim)
#        ~/scripts/jarate    -> <jarate>/bin/jarate
#        ~/bin/agent-say     -> <jarate>/bin/agent-say
#        ~/bin/jarate-diff   -> <jarate>/bin/jarate-diff
#        ~/bin/jarate        -> <jarate>/bin/jarate
#        ~/bin/jarate-pat    -> <jarate>/bin/jarate-pat   (PAT vault client)
#        ~/bin/jarate-vault  -> <jarate>/bin/jarate-vault (generic credential vault client)
#        ~/projects/recall   -> <jarate>/packages/recall   (only if the dest
#                               is absent or already this symlink)
#   5. seeds ~/.config/agent-fleet/peers.json (agent-say peer-name
#      resolution) from dispatch/peers.json (local, gitignored) or
#      dispatch/peers.example.json (placeholders) + this agent's own channel.
#      One-time write: an existing file is never clobbered.
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
#     (+ the one-time peers.json seed, which never clobbers)
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

# Canonicalize once (PR #155 review LOW-1): the 3a ownership check compares
# readlink -f(resolved) against $JARATE_DIR, so a symlinked --jarate-dir
# must be resolved here or every tool reports "stale symlink". GNU readlink
# -f tolerates a non-existent leaf (the clone case below).
JARATE_DIR="$(readlink -f "$JARATE_DIR")"

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

link_owned() { # $1 = dest path, $2 = target — issue #150: install.sh OWNS this
  # name. Whatever is there (a stale symlink to an old checkout, a
  # pi-dispatch-era file copy) is re-pointed, one auditable line per
  # change; a fresh create prints a plain link line. Idempotent: a
  # symlink already at the target is left alone ("unchanged").
  local dest="$1" target="$2" state="new"
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ]; then
    local cur; cur="$(readlink "$dest")"
    if [ "$cur" = "$target" ]; then
      echo "  link: $dest -> $target (unchanged)"
      return
    fi
    state="stale symlink ($cur)"
    run rm -f "$dest"
  elif [ -e "$dest" ]; then
    state="stale file"
    run rm -f "$dest"
  fi
  run ln -s "$target" "$dest"
  if [ "$state" = "new" ]; then
    echo "  link: $dest -> $target"
  else
    echo "  link: re-pointed $dest ($state) -> $target"
  fi
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
# Dispatch family (issue #150 + #151): 5 jarate-* entrypoints + 5 pi-*
# deprecation shims, linked into BOTH ~/.local/bin and ~/scripts. install.sh
# OWNS these names: stale entries (pi-dispatch-era files, symlinks to old
# checkouts) are re-pointed, one auditable line per change.
for tool in jarate-bg jarate-wait jarate-bg-tail jarate-bg-kill jarate-bg-watchdog \
            pi-bg pi-wait pi-bg-tail pi-bg-kill pi-bg-watchdog; do
  link_owned "$HOME/.local/bin/$tool" "$JARATE_DIR/dispatch/$tool"
  link_owned "$HOME/scripts/$tool"    "$JARATE_DIR/dispatch/$tool"
done
link_into "$HOME/scripts/jarate"     "$JARATE_DIR/bin/jarate"
link_into "$HOME/bin/agent-say"      "$JARATE_DIR/bin/agent-say"
link_into "$HOME/bin/jarate-diff"    "$JARATE_DIR/bin/jarate-diff"
link_into "$HOME/bin/jarate"         "$JARATE_DIR/bin/jarate"
link_into "$HOME/bin/jarate-pat"     "$JARATE_DIR/bin/jarate-pat"
link_into "$HOME/bin/jarate-vault"   "$JARATE_DIR/bin/jarate-vault"

# --- 3a. PATH verify (issue #71, #151) -------------------------------------
# Assert every family member resolves in the unit's PATH AND is jarate-owned
# (a symlink into this checkout). A missing tool, or a stale non-symlink
# shadowing the name (e.g. an old pi-bg script in ~/.local/bin from before
# the #151 rename), must never be a silent success: the callback is the only
# wake mechanism, and if the wrapper is unreachable by name the agent can
# never dispatch a job. Hard fail outside dry-run.
UNIT_PATH="$HOME/.local/bin:$HOME/bin:$HOME/scripts:/usr/local/bin:/usr/bin:/bin"
PATH_FAIL=0
FAMILY_TOOLS="jarate-bg jarate-wait jarate-bg-tail jarate-bg-kill jarate-bg-watchdog pi-bg pi-wait pi-bg-tail pi-bg-kill pi-bg-watchdog"
for tool in $FAMILY_TOOLS agent-say jarate jarate-pat jarate-diff jarate-vault; do
  resolved="$(env -i PATH="$UNIT_PATH" command -v "$tool" 2>/dev/null || true)"
  if [ -z "$resolved" ]; then
    echo "  [!] PATH: $tool not found in unit PATH ($UNIT_PATH)" >&2
    PATH_FAIL=1
    continue
  fi
  if [ -L "$resolved" ]; then
    real="$(readlink -f "$resolved")"
    case "$real" in
      "$JARATE_DIR"/dispatch/*|"$JARATE_DIR"/bin/*) ;;
      *) echo "  [!] PATH: $tool is a stale symlink: $resolved -> $real (want $JARATE_DIR)" >&2; PATH_FAIL=1; continue ;;
    esac
    # content marker (issue #150): the resolved copy must byte-match the
    # checkout, so a shadow that survived the re-point fails install
    # loudly instead of at dispatch time.
    case "$tool" in
      jarate-bg|jarate-wait|jarate-bg-tail|jarate-bg-kill|jarate-bg-watchdog|\
      pi-bg|pi-wait|pi-bg-tail|pi-bg-kill|pi-bg-watchdog) ;;
      *) continue ;;
    esac
    sum_installed="$(sha256sum "$resolved" 2>/dev/null | cut -d' ' -f1 || true)"
    sum_repo="$(sha256sum "$JARATE_DIR/dispatch/$tool" 2>/dev/null | cut -d' ' -f1 || true)"
    if [ -n "$sum_repo" ] && [ "$sum_installed" != "$sum_repo" ]; then
      echo "  [!] PATH: $tool content mismatch: $resolved != $JARATE_DIR/dispatch/$tool" >&2
      PATH_FAIL=1
    fi
    continue
  fi
  echo "  [!] PATH: $tool shadowed by non-symlink: $resolved (install.sh re-points family names; remove foreign tools)" >&2
  PATH_FAIL=1
done
if [ "$PATH_FAIL" -eq 0 ]; then
  echo "  PATH: all dispatch tools resolvable in unit env"
elif [ "$DRY" -eq 0 ]; then
  echo "[!] install FAILED: dispatch family not fully resolvable in unit env" >&2
  exit 1
fi

# recall: only adopt if the dest is absent or already our symlink (a live
# deployed dir with .venv/.git is migrated manually, see DEPLOY.md)
RECALL_DEST="$HOME/projects/recall"
if [ ! -e "$RECALL_DEST" ] || { [ -L "$RECALL_DEST" ] && [ "$(readlink "$RECALL_DEST")" = "$JARATE_DIR/packages/recall" ]; }; then
  link_into "$RECALL_DEST" "$JARATE_DIR/packages/recall"
else
  echo "  recall: $RECALL_DEST exists (not this symlink); left untouched"
fi

# --- 3b. agent-fleet peers seed (agent-say peer names) ----------------------
# One-time: the peers file is machine state (operators add peers), so an
# existing file is never clobbered. Seed = the local roster
# dispatch/peers.json (gitignored; copy dispatch/peers.example.json and
# fill in real channel ids) PLUS this agent's own channel (name = $USER,
# id from settings.json — the file is never written, only read).
PEERS_DEST="$HOME/.config/agent-fleet/peers.json"
PEERS_SRC="$JARATE_DIR/dispatch/peers.json"
[ -f "$PEERS_SRC" ] || PEERS_SRC="$JARATE_DIR/dispatch/peers.example.json"
if [ -f "$PEERS_DEST" ]; then
  echo "  peers: $PEERS_DEST (exists, unchanged)"
else
  self=""
  if command -v jq >/dev/null 2>&1 && [ -f "$HOME/.pi/agent/settings.json" ]; then
    self="$(jq -r '[.channels[]? | select(.type == "discord") | .channel // empty] | .[0] // empty' "$HOME/.pi/agent/settings.json" 2>/dev/null || true)"
  fi
  if [ "$DRY" = 1 ]; then
    echo "  peers: [dry-run] would seed $PEERS_DEST (local roster + own channel)"
  else
    mkdir -p "$(dirname "$PEERS_DEST")"
    if [ -n "$self" ] && command -v jq >/dev/null 2>&1 && [ -f "$PEERS_SRC" ]; then
      jq --arg u "${USER:-agent}" --arg c "$self" '. + {($u): $c}' \
        "$PEERS_SRC" > "$PEERS_DEST"
    elif [ -f "$PEERS_SRC" ]; then
      cp "$PEERS_SRC" "$PEERS_DEST"
    else
      echo '{}' > "$PEERS_DEST"
    fi
    echo "  peers: seeded $PEERS_DEST (from ${PEERS_SRC#"$JARATE_DIR"/})"
  fi
fi

# --- 4. finish ---------------------------------------------------------------
echo
echo "== done (settings.json untouched, no pi processes touched)"
echo "SET THIS IN ~/.pi/agent/settings.json:"
echo "  \"packages\": [\"$JARATE_DIR/packages/bridge\"]"
echo "THEN restart pi to pick up the new bridge:"
echo "  XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service"

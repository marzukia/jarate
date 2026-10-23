#!/usr/bin/env bash
# jarate bootstrap — NO-RSYNC (v3, 2026-09-10, operator: "no more rsync biz").
#
# The jarate checkout IS the deployment. This script:
#   1. ensures a checkout exists (--jarate-dir, or clones into it)
#   2. git pull --ff-only on an existing checkout
#   3. bun install in packages/bridge (deps only; node_modules is gitignored,
#      machine-local)
#   4. makes machine paths POINTERS (symlinks) into the checkout:
#        dispatch family — the drain is declared (#279): only the
#        jarate-bg launch stub (exit 10; `signal` subcommand stays live)
#        and pi-postcheck.sh are owned by install.sh, each linked into
#        BOTH ~/.local/bin and ~/scripts:
#        {~/.local/bin,~/scripts}/jarate-bg -> <jarate>/dispatch/jarate-bg
#        {~/.local/bin,~/scripts}/pi-postcheck.sh -> <jarate>/dispatch/pi-postcheck.sh
#        ~/scripts/jarate    -> <jarate>/bin/jarate
#        ~/bin/jarate-diff   -> <jarate>/bin/jarate-diff
#        ~/bin/jarate        -> <jarate>/bin/jarate
#   5. cleans up a stale ~/projects/recall symlink left by pre-2026-10-17
#      installs (the repo no longer ships packages/recall)
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
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,23p'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# Canonicalize once (PR #155 review LOW-1): the 3a ownership check compares
# readlink -f(resolved) against $JARATE_DIR, so a symlinked --jarate-dir
# must be resolved here or every tool reports "stale symlink". GNU readlink
# -f tolerates a missing LEAF (the clone case below) but needs every PARENT
# component to exist; on a fresh HOME the parents are missing too, so fall
# back to the raw path when canonicalization fails (the clone below then
# creates the tree under it).
JARATE_DIR_RAW="$JARATE_DIR"
JARATE_DIR="$(readlink -f "$JARATE_DIR" 2>/dev/null || true)"
if [ -z "$JARATE_DIR" ]; then
  JARATE_DIR="$JARATE_DIR_RAW"
fi

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
# Dispatch family: the drain is declared (#279, t180-verified: zero
# state=running records fleet-wide) — install.sh owns only the two live
# members: the jarate-bg launch stub (exit 10 retirement notice; the
# `signal` subcommand stays live until the fleet timer lands) and
# pi-postcheck.sh (live: pi-restart schedules it 90s after every restart).
# Linked into BOTH ~/.local/bin and ~/scripts. install.sh OWNS these names:
# stale entries (pi-dispatch-era files, symlinks to old checkouts) are
# re-pointed, one auditable line per change.
for tool in jarate-bg pi-postcheck.sh; do
  link_owned "$HOME/.local/bin/$tool" "$JARATE_DIR/dispatch/$tool"
  link_owned "$HOME/scripts/$tool"    "$JARATE_DIR/dispatch/$tool"
done
# Retired dispatch pointers: the jarate-bg launch-stub era kept 11 names in
# this list; #283 dropped the four pi-bg* shims, #279 (the drain) drops
# jarate-wait/-tail/-kill + pi-wait (deleted now) and the watchdog (splits in
# a follow-up, audit action 3). The deleted names are gone from the repo
# after the step-1 pull, so our symlinks into them dangle (the watchdog link
# dangles once action 3 deletes the script). Remove only OUR links (into
# this checkout) that are now dangling; a live dir or a foreign symlink is
# left untouched.
for tool in pi-bg pi-bg-kill pi-bg-tail pi-bg-watchdog \
            jarate-wait jarate-bg-tail jarate-bg-kill pi-wait \
            jarate-bg-watchdog; do
  for dest in "$HOME/.local/bin/$tool" "$HOME/scripts/$tool"; do
    if [ -L "$dest" ] && [ ! -e "$dest" ]; then
      case "$(readlink "$dest")" in
        "$JARATE_DIR"/dispatch/*)
          echo "  retired shim: removing dangling symlink $dest"
          run rm -f "$dest"
          ;;
      esac
    fi
  done
done
link_into "$HOME/scripts/jarate"     "$JARATE_DIR/bin/jarate"
link_into "$HOME/bin/jarate-diff"    "$JARATE_DIR/bin/jarate-diff"
link_into "$HOME/bin/jarate"         "$JARATE_DIR/bin/jarate"

# --- 3a. PATH verify (issue #71, #151) -------------------------------------
# Assert every family member resolves in the unit's PATH AND is jarate-owned
# (a symlink into this checkout). A missing tool, or a stale non-symlink
# shadowing the name (e.g. a leftover file in ~/.local/bin from before the
# #151 rename), must never be a silent success: the callback is the only
# wake mechanism, and if the wrapper is unreachable by name the agent can
# never dispatch a job. Hard fail outside dry-run.
UNIT_PATH="$HOME/.local/bin:$HOME/bin:$HOME/scripts:/usr/local/bin:/usr/bin:/bin"
PATH_FAIL=0
FAMILY_TOOLS="jarate-bg pi-postcheck.sh"
for tool in $FAMILY_TOOLS jarate jarate-diff; do
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
      jarate-bg|pi-postcheck.sh) ;;
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

# recall: removed from the repo 2026-10-17 (fleet order). Stale-symlink
# cleanup: if the box link still points at the (now gone) packages/recall,
# remove it. Anything else (a live dir, a foreign symlink) is left
# untouched; the rag Postgres data is kept but unused.
RECALL_DEST="$HOME/projects/recall"
if [ -L "$RECALL_DEST" ] && [ ! -e "$RECALL_DEST" ]; then
  case "$(readlink "$RECALL_DEST")" in
    "$JARATE_DIR/packages/recall" | "$JARATE_DIR_RAW/packages/recall")
      echo "  recall: removing stale symlink $RECALL_DEST (target gone)"
      run rm -f "$RECALL_DEST"
      ;;
  esac
fi

# --- 3b. live marker dir (issue #191 M2) ------------------------------------
# /var/tmp/jarate-live: the per-agent liveness markers (<uid>, 0644) the
# bridge touches every poll cycle; the watchdog's fleet liveness sweep
# (another user) reads everyone's, so the dir is sticky world-writable
# like /tmp. /var/tmp, not /tmp: the marker must survive a reboot so the
# sweep can classify BOOT-GAP (marker older than kernel btime) instead of
# alerting on a fresh boot. Created only when absent: a dir another agent
# created first is already shared (1777) and un-chmoddable by us.
LIVE_MARKER_DIR=/var/tmp/jarate-live
if [ -d "$LIVE_MARKER_DIR" ]; then
  echo "  live marker: $LIVE_MARKER_DIR (exists, unchanged)"
else
  echo "  live marker: $LIVE_MARKER_DIR (create, 1777 sticky)"
  run mkdir -p "$LIVE_MARKER_DIR"
  run chmod 1777 "$LIVE_MARKER_DIR"
fi

# --- 4. finish ---------------------------------------------------------------
echo
echo "== done (settings.json untouched, no pi processes touched)"
echo "SET THIS IN ~/.pi/agent/settings.json:"
echo "  \"packages\": [\"$JARATE_DIR/packages/bridge\"]"
echo "THEN restart pi to pick up the new bridge:"
echo "  XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi.service"

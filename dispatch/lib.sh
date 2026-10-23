#!/usr/bin/env bash
# lib.sh — shared logic for the dispatch/ scripts (issue #262 DRY/connascence).
#
# Sourced by jarate-bg, jarate-bg-watchdog, pi-postcheck.sh and install.sh
# (the drain, #279, retired jarate-wait/-tail/-kill). Sourcing defines the
# functions + constants below and computes/exports JRATE_LIB_DIR - no other
# side effects, so it is safe under the scripts' `set -u` / `set -euo
# pipefail` combos.
#
# Single-sourced contracts (the #262 findings live here, in one place):
#   - the ticket id regex (run-identity contract, documented in the
#     dispatch/jarate-bg header)
#   - the dispatch webhook resolver: $PI_DISPATCH_WEBHOOK, else the FIRST
#     LINE of ~/.config/pi-dispatch/webhook (head -1, not cat - a stray
#     second line must not leak into the URL)
#   - the record dir: $PI_DISPATCH_RECORD_DIR, else ~/.pi-dispatch/runs
#   - the cgroup v2 user-slice root: $PI_BG_CG_ROOT, else the system path
#   - the live marker dir default: /var/tmp/jarate-live, shared with
#     install.sh (which creates it 1777) and the bridge, which writes it
#     (packages/bridge/channel/index.ts, JARATE_LIVE_DIR); the watchdog's
#     fleet liveness sweep (the reader) left with #280/3a -> hall-monitor#59
#   - the webhook POST retry shape: 3 tries, i*3*PI_BG_WB_BACKOFF backoff
#     (PI_BG_WB_BACKOFF=0 is the no-sleep test seam; the watchdog used to
#     hardcode i*3 and ignore the env)
#   - the run-record state/finished updater (the 4 identical python
#     heredocs collapsed to one function)
#   - the /proc ppid scan + cgroup process tree (BFS)
#   - the pi session-dir slug + find (HUNG / mid-run events)
# The python side of the shared logic (frame geometry, embed colors,
# channel selection) lives in jrate_common.py next to this file.
#
# Naming: bash functions are jrate_* (they land on PATH via install.sh
# symlinks); python symbols are plain (module-qualified on import).

# --- location ----------------------------------------------------------------
# The dispatch dir this file was sourced from. Scripts are invoked through
# install.sh symlinks (~/.local/bin, ~/scripts); readlink -f resolves to the
# real repo path, so the python heredocs import jrate_common.py from the
# checkout, not from the link's directory.
JRATE_LIB_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
export JRATE_LIB_DIR

# --- run-identity contract (see the dispatch/jarate-bg header) ---------------
# A ticket/run id: 8-digit UTC date + 6-digit UTC time + '-' + a numeric
# suffix of VARIABLE width. The watchdog mints <stamp>-$RANDOM (1-5 digits);
# the old launcher minted <stamp>-$$. Anything matching this regex is a
# valid id - downstream code must never assume a fixed suffix width.
JRATE_TICKET_RE='^[0-9]{8}-[0-9]{6}-[0-9]+$'
# A short id is a unique 7+ digit SUFFIX of a ticket id (issue #86); the
# capture group is what the run-record scan matches.
JRATE_SHORT_ID_RE='^[0-9]{7,}$'
JRATE_TICKET_SHORT_SUFFIX_RE='^[0-9]{8}-[0-9]{6}-([0-9]{7,})$'

# jrate_resolve_ticket <id> <rec-dir> <label>: resolve a short id to the
# full ticket via the run records (<rec-dir>/pi-bg-*.json). Prints the
# resolved full id on stdout. rc 0 = resolved, rc 1 = short id not
# resolvable (unique match required; the error is already printed to
# stderr, prefixed <label>:), rc 2 = not a ticket id at all (the caller
# prints its own usage error, which mentions the expected shape).
jrate_resolve_ticket() {
  local id="$1" rec_dir="$2" label="$3" rf base
  local matches=()
  if [[ "$id" =~ $JRATE_TICKET_RE ]]; then
    printf '%s' "$id"
    return 0
  fi
  if [[ "$id" =~ $JRATE_SHORT_ID_RE ]]; then
    for rf in "$rec_dir"/pi-bg-*.json; do
      [ -f "$rf" ] || continue
      base="${rf##*/}"; base="${base#pi-bg-}"; base="${base%.json}"
      [[ "$base" =~ $JRATE_TICKET_SHORT_SUFFIX_RE ]] || continue
      [ "${BASH_REMATCH[1]}" = "$id" ] && matches+=("$base")
    done
    case "${#matches[@]}" in
      1)
        echo "$label: short id $id -> ${matches[0]} (run record)" >&2
        printf '%s' "${matches[0]}"
        return 0
        ;;
      0)
        echo "$label: no run record in $rec_dir matches short id '$id' (want the full id, or a unique 7+ digit suffix)" >&2
        return 1
        ;;
      *)
        echo "$label: short id '$id' is ambiguous, matches: ${matches[*]} (use the full id)" >&2
        return 1
        ;;
    esac
  fi
  return 2
}

# --- config paths (single derivation each, issue #262) -----------------------

# The dispatch webhook URL: $PI_DISPATCH_WEBHOOK wins; else the first line
# of ~/.config/pi-dispatch/webhook. head -1, not cat (issue #262: pi-
# postcheck used to read the whole file). Empty string when neither exists.
jrate_webhook() {
  local w="${PI_DISPATCH_WEBHOOK:-}"
  if [ -z "$w" ] && [ -f "${HOME}/.config/pi-dispatch/webhook" ]; then
    w="$(head -1 "${HOME}/.config/pi-dispatch/webhook")"
  fi
  printf '%s' "$w"
}

# The run-record dir (issue #51): records are <rec-dir>/pi-bg-<id>.json.
jrate_rec_dir() {
  printf '%s' "${PI_DISPATCH_RECORD_DIR:-${HOME}/.pi-dispatch/runs}"
}

# The cgroup v2 user-slice root; tickets live under <root>/pi-bg/<id>.
jrate_cg_root() {
  printf '%s' "${PI_BG_CG_ROOT:-/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service}"
}

# The agent-liveness marker dir default (issue #191 M2). The watchdog's
# fleet liveness sweep (the reader) is gone with #280/3a: install.sh creates
# the dir and the bridge writes the per-agent <uid> files; liveness paging
# now runs on the hall-monitor control plane (hall-monitor#59).
JRATE_LIVE_DIR_DEFAULT=/var/tmp/jarate-live

# --- webhook post (shared retry shape, issue #262) ---------------------------
# jrate_wb_post <webhook> <body-file> [resp-file]: POST the JSON body file
# to the webhook. 3 attempts; after a non-2xx, sleep i*3*PI_BG_WB_BACKOFF
# seconds (PI_BG_WB_BACKOFF=0 = no sleep, the test seam; default 1).
# Prints the final HTTP code on stdout (000 when curl itself failed).
# rc 0 = a 2xx landed, rc 1 = all attempts failed. The caller writes its
# own dead letter / keeps its own response-file consumer.
jrate_wb_post() {
  local hook="$1" body="$2" resp="${3:-/dev/null}" code i
  for i in 1 2 3; do
    code="$(curl -s -o "$resp" -w '%{http_code}' -X POST "$hook" \
      -H 'Content-Type: application/json' --max-time 15 --data @"$body" 2>/dev/null)" \
      || code="000"
    case "$code" in 2*) printf '%s' "$code"; return 0 ;; esac
    [ "$i" -lt 3 ] && sleep $(( i * 3 * ${PI_BG_WB_BACKOFF:-1} ))
  done
  printf '%s' "$code"
  return 1
}

# --- run-record state update (single heredoc, issue #262) --------------------
# jrate_rec_set_state <record-file> <state>: set "state" + "finished"
# (UTC ISO) in the run record. Audit only - a missing/corrupt record or a
# missing python3 never fails the caller (same as the per-script copies).
jrate_rec_set_state() {
  PI_BG_REC_STATE="$2" python3 - "$1" <<'PY' 2>/dev/null || true
import datetime, json, os, sys
p = sys.argv[1]
try:
    rec = json.load(open(p))
except Exception:
    sys.exit(0)
rec["state"] = os.environ.get("PI_BG_REC_STATE", "killed")
rec["finished"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(rec, open(p, "w"), indent=2)
PY
}

# --- process tree (single /proc scan + BFS, issue #262) -----------------------
# jrate_children_of <pid>: pids whose /proc/<pid>/stat ppid is $1.
# The `s#*) ` strip makes the scan robust to a comm containing spaces
# (e.g. "jarate-bg (agent)"); the 2026-09-15 tr-subshell fix (a bare
# `set --` in the loop body re-split the pid list) is preserved: the stat
# line is read into ONE variable first, then split once.
jrate_children_of() {
  local want="$1" c s
  for c in /proc/[0-9]*; do
    IFS= read -r s 2>/dev/null < "$c/stat" || continue
    s="${s#*) }"
    [ "${s#* }" = "${s}" ] && continue
    set -- $s
    [ "$2" = "$want" ] && basename "$c"
  done
}

# jrate_list_tree <cgroup-dir>: the cgroup's members (cgroup.procs, sorted
# -u) plus all their descendants (BFS via jrate_children_of), one pid per
# line. A leaf with no children is listed once.
jrate_list_tree() {
  local cg="$1" p d c queue=() next=()
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    echo "$p"
    queue=("$p")
    while [ "${#queue[@]}" -gt 0 ]; do
      next=()
      for d in "${queue[@]}"; do
        for c in $(jrate_children_of "$d"); do
          echo "$c"
          next+=("$c")
        done
      done
      queue=("${next[@]+"${next[@]}"}")
    done
  done < <(cat "$cg/cgroup.procs" 2>/dev/null | sort -un)
}

# --- pi session discovery (issue #262) ---------------------------------------
# jrate_session_file <profile> <pi-cwd> <start-ts>: the newest session
# .jsonl for pi's cwd (the session-dir slug is the cwd with '/' -> '-',
# wrapped in leading/trailing '--'), created or modified after <start-ts>
# (epoch seconds). Prints the path on stdout; nothing when absent.
jrate_session_file() {
  local prof="$1" pi_cwd="$2" start="$3" slug sd
  [ -n "$pi_cwd" ] || return 0
  slug="--${pi_cwd#/}"; slug="${slug//\//-}--"
  sd="$HOME/.pi/agent-${prof}/sessions/$slug"
  find "$sd" -maxdepth 1 -name '*.jsonl' -newermt "$start" -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr | head -1 | cut -d' ' -f2-
}

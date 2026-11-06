#!/usr/bin/env bash
#
# jarate fleet rollout (#314, G4 of P1 #322) — one run = the whole host, on the named tag.
#
# The tag is the version (tag discipline, deploy/README.md): every change that ships to the fleet is tagged, and untagged main is not a deploy target. This script moves every agent checkout on the host to the tag, restarts each pi.service, verifies liveness + delivery, and writes the pinned-SHA pointer the bridge's startup drift check compares against.
#
# Runs under a hall-monitor vault plan (SUDO_PW). The plan executor is the worker account, not root (#326, first rollout plan 180): when EUID is not 0 the script self-elevates at the top of main() — it re-execs itself under sudo (the password over stdin via `printf '%s\n' "$SUDO_PW" | sudo -S ...`, never in argv/ps, args + env preserved), and fails loud when not root AND SUDO_PW is unset. Cross-user steps use `printf '%s\n' "$SUDO_PW" | sudo -S -u <user> ...` (the printf keeps the password out of `ps` output) with XDG_RUNTIME_DIR=/run/user/<uid> for the user systemd instance. One operator tap: the plan is approved, the run does the whole host.
#
# Usage: jarate-rollout.sh <tag> [hm-base]
#   <tag>     the release tag (must exist after `git fetch --tags`)
#   hm-base   the hall-monitor base (http://host:port) — or the JARATE_HM_URL env var. NO default: unset = fail loud.
#
# Per agent user (deterministic lane set, in /etc/passwd order: login-shell users with a ~/projects/jarate checkout AND a resolvable HM agent key — see classify_lane; a checkout without a resolvable key is a visible skip (dev checkout), a resolvable key without a checkout fails loud; a lane whose live marker is older than JARATE_ROLLOUT_LAPSED_S (default 300s) pre-restart is a visible lapsed skip (no restart, no smoke-say, no pin), a missing marker is fresh (roll — the post-restart 90s gate judges it); the post-restart 90s gate is unchanged for live lanes):
#   1. dirty-tree check (fail loud — never move a dirty checkout)
#   2. git fetch --tags (as the user)
#   3. ff-move the checkout to the tag (plain ff; divergent = fail loud, no merge, no rebase)
#   4. restart pi.service (the user systemd instance)
#   5. verify: /var/tmp/jarate-live/<uid> mtime advances after the restart (≤90s wait loop, fail loud)
#   6. verify: one delivered smoke say via hall-monitor (POST <base>/api/fleet/say, X-Agent-Key = the user's agent key, resolved from the first existing of ~/.config/hall-monitor/agent-key, ~/.config/hall-monitor/key, ~/hall-monitor.key — the key is the X_AGENT_KEY= line, or the first non-comment line when absent; 2xx = delivered; the recipient is smoke_target: 'warden', except the warden lane itself targets 'piboy' — a self-say 400s, #332)
#   7. write /var/tmp/jarate-pinned/<uid> = the tag's SHA
#
# A per-user failure stops the whole run (fail loud, exit 1); already rolled users keep their pins (their drift check stays quiet), the failed user keeps none (its drift check pages warden — the mismatch is real and is what should be heard about).
#
# Only bash + git + sudo + curl + getent are required.

set -euo pipefail

TAG="${1:-}"
HM_BASE="${2:-${JARATE_HM_URL:-}}"
LIVE_DIR="${JARATE_LIVE_DIR:-/var/tmp/jarate-live}"
PINNED_DIR="${JARATE_PINNED_DIR:-/var/tmp/jarate-pinned}"
GATE_TIMEOUT_S="${JARATE_ROLLOUT_GATE_TIMEOUT_S:-90}"
LAPSED_S="${JARATE_ROLLOUT_LAPSED_S:-300}"

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "ROLLOUT FAIL: $*"; exit 1; }

# Cross-user step: the password over stdin (never in argv/ps); the command's own env is set with `env` inside the target user (sudo strips XDG_RUNTIME_DIR).
as_user() {
  local user="$1"
  shift
  printf '%s\n' "$SUDO_PW" | sudo -S -u "$user" "$@"
}

# --- pure helpers (sourced-harness tested in rollout.test.ts) --------------

# validate_hm_base <base>: ok when <base> is http(s)://host[:port] with no path and no trailing slash (the endpoint is appended as /api/fleet/say).
validate_hm_base() {
  local base="${1:-}"
  [[ -n "$base" && "$base" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]
}

# smoke_target <user>: the step 6 smoke-say recipient — 'warden' (the fixed, always-live lane), EXCEPT when <user> IS 'warden', in which case 'piboy': the hall-monitor say edge 400s a self-say ('Cannot say to yourself'), and plan 247's 7th (warden) lane failed on exactly that (2026-11-02, #332).
smoke_target() {
  local user="${1:-}"
  if [[ "$user" == "warden" ]]; then
    printf '%s\n' "piboy"
  else
    printf '%s\n' "warden"
  fi
}

# resolve_key_file <home>: the first EXISTING candidate of the fleet agent-key paths — $home/.config/hall-monitor/agent-key (onboarding shape: comment lines, then BASE_URL=, then X_AGENT_KEY=), $home/.config/hall-monitor/key (bare key after comment lines), $home/hall-monitor.key (bare key) — lanes onboarded at different times carry different paths on the same host; 1 when none exist (the caller names them in the die message). The two legacy candidates are kept for one rollout cycle after the 2026-11-06 host migration (#347 moved every live agent to the canonical path); their removal is scheduled for the next rollout cycle.
resolve_key_file() {
  local home="$1"
  local f
  for f in "$home/.config/hall-monitor/agent-key" "$home/.config/hall-monitor/key" "$home/hall-monitor.key"; do
    if [[ -e "$f" ]]; then
      printf '%s\n' "$f"
      return 0
    fi
  done
  return 1
}

# first_key_line <file>: the agent key from the user's agent-key file (the fleet path chain — see resolve_key_file): an X_AGENT_KEY= line wins (the value after the =, trimmed), then an hm_agent_ line (the new onboarding key-file format, where the first non-comment line is BASE_URL=...), else the first non-comment, non-blank line (legacy bare-key files); 1 when the file is missing or nothing matches.
# classify_lane <home> <marker_age>: the fleet-lane class of a login-shell user's home (marker_age = the pre-restart live marker's age in seconds, or "missing" when the marker file does not exist) — roll (a ~/projects/jarate checkout AND a resolvable HM agent key via resolve_key_file AND a fresh or missing marker: the lane to roll), lapsed (checkout + resolvable key but the pre-restart live marker is older than $LAPSED_S: the lane has lapsed — the caller logs a visible skip and does not restart, does not smoke-say, does not pin; the post-restart 90s gate is unchanged for live lanes), skip (checkout, no resolvable key: a dev checkout — the caller logs a visible, deterministic skip, never a silent one; the key check runs FIRST, so a stale marker on a no-key user is this skip, never lapsed), fail (resolvable key, no checkout: the lane is broken — the caller dies), ignore (neither: not an agent). Lapsed is a pure mtime comparison (no inference in the enforcement path); a missing marker is FRESH (roll — operator ruling 2026-11-02: no evidence of liveness is not evidence of lapse; the post-restart 90s gate judges it).
classify_lane() {
  local home="$1"
  local marker_age="${2:-missing}"
  local has_checkout=0 has_key=0 lapsed=0
  resolve_key_file "$home" >/dev/null && has_key=1
  [[ -e "$home/projects/jarate/.git" ]] && has_checkout=1 # -e: .git is a dir in a clone, a file in a git worktree
  if [[ "$has_key" -eq 1 && "$has_checkout" -eq 1 && "$marker_age" != "missing" ]]; then
    if (( marker_age > LAPSED_S )); then
      lapsed=1
    fi
  fi
  case "$has_checkout/$has_key/$lapsed" in
    "1/1/0") printf '%s\n' "roll" ;;
    "1/1/1") printf '%s\n' "lapsed" ;;
    "1/0/0") printf '%s\n' "skip" ;;
    "0/1/0") printf '%s\n' "fail" ;;
    *) printf '%s\n' "ignore" ;;
  esac
}

first_key_line() {
  local f="$1" line legacy=""
  [[ -r "$f" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -n "$line" && "$line" != \#* ]] || continue
    if [[ "$line" == X_AGENT_KEY=* ]]; then
      local rest
      rest="${line#X_AGENT_KEY=}"
      rest="${rest#"${rest%%[![:space:]]*}"}"
      rest="${rest%"${rest##*[![:space:]]}"}"
      if [[ -n "$rest" ]]; then
        printf '%s\n' "$rest"
        return 0
      fi
    fi
    if [[ "$line" == hm_agent_* ]]; then
      printf '%s\n' "$line"
      return 0
    fi
    [[ -z "$legacy" ]] && legacy="$line"
  done <"$f"
  if [[ -n "$legacy" ]]; then
    printf '%s\n' "$legacy"
    return 0
  fi
  return 1
}

# wait_marker <dir> <uid> <bar_epoch_s> <timeout_s>: 0 when the marker's mtime (epoch seconds) is strictly newer than <bar_epoch_s>; 1 on timeout. Polls every 3s.
wait_marker() {
  local dir="$1" uid="$2" bar_s="$3" timeout_s="$4"
  local f="$dir/$uid" deadline m
  deadline=$(( $(date +%s) + timeout_s ))
  while (( $(date +%s) < deadline )); do
    if [[ -f "$f" ]]; then
      m="$(stat -c %Y "$f" 2>/dev/null || true)"
      if [[ -n "$m" && "$m" -gt "$bar_s" ]]; then
        return 0
      fi
    fi
    sleep 3
  done
  return 1
}

# enumerate_agents <passwd_file>: login-shell usernames, sorted — the deterministic enumeration input (a user is a roll-set AGENT when, on top, classify_lane says roll — checkout + resolvable HM agent key; that check is in the main loop).
enumerate_agents() {
  local pf="$1"
  awk -F: '{
    sh = $7
    sub(".*/", "", sh)
    if (sh == "bash" || sh == "sh" || sh == "zsh" || sh == "dash") print $1
  }' "$pf" | sort -u
}

# --- main -----------------------------------------------------------------

main() {
  # Self-elevation (#326): the vault plan executor is the worker account, not root — a non-root start re-execs the whole script under sudo, feeding SUDO_PW to `sudo -S` on stdin (never echoed, never in argv); args + env are preserved, so the set -euo pipefail semantics carry over the re-exec. Not root AND SUDO_PW unset = die loud.
  if [[ "$(id -u)" -ne 0 ]]; then
    [[ -n "${SUDO_PW:-}" ]] || die "not root and SUDO_PW is not set (run as root, or via a hall-monitor vault plan that injects SUDO_PW)"
    printf '%s\n' "$SUDO_PW" | exec sudo -S "$0" "$@"
  fi
  [[ -n "$TAG" ]] || die "usage: $0 <tag> [hm-base] (hm-base or JARATE_HM_URL required; no default)"
  validate_hm_base "$HM_BASE" || die "hall-monitor base is not http(s)://host[:port] (arg 2 or JARATE_HM_URL; no default)"
  [[ -n "${SUDO_PW:-}" ]] || die "SUDO_PW is not set (the vault plan credential)"
  command -v curl >/dev/null 2>&1 || die "curl is required"

  local users=()
  while IFS= read -r u; do
    users+=("$u")
  done < <(enumerate_agents /etc/passwd)

  # Roll set: a login-shell user with a ~/projects/jarate checkout AND a resolvable HM agent key (classify_lane). A checkout without a resolvable key is a dev checkout (visible skip); a resolvable key without a checkout is a broken lane (die loud). Pre-restart lapsed check: the live marker's age is read from $LIVE_DIR/<uid> BEFORE the restart step — marker exists AND mtime older than $LAPSED_S seconds = lapsed (visible skip, no restart, no smoke-say, no pin); missing marker = fresh (the post-restart 90s gate judges it).
  local agents=() u h cls m_uid m_mt m_age
  for u in "${users[@]}"; do
    h="$(getent passwd "$u" | awk -F: '{print $6}')"
    m_uid="$(id -u "$u")"
    m_age="missing"
    if [[ -f "$LIVE_DIR/$m_uid" ]]; then
      m_mt="$(stat -c %Y "$LIVE_DIR/$m_uid" 2>/dev/null || echo 0)"
      m_age=$(( $(date +%s) - m_mt ))
    fi
    cls="$(classify_lane "$h" "$m_age")"
    case "$cls" in
      roll) agents+=("$u") ;;
      skip) log "skip $u: no agent key (dev checkout)" ;;
      lapsed) log "skip $u: lane lapsed (live marker ${m_age}s old pre-restart)" ;;
      fail) die "$u: resolvable HM agent key but no ~/projects/jarate checkout (a fleet lane missing its checkout is broken)" ;;
    esac
  done
  [[ ${#agents[@]} -gt 0 ]] || die "no agent users found (no login-shell user with a ~/projects/jarate checkout AND a resolvable HM agent key)"

  # Fail fast on a bad tag (validated in the first agent's repo after a fetch; `git fetch --tags --force` so origin tags are authoritative over a stale pre-existing local tag of the same name).
  local first_home
  first_home="$(getent passwd "${agents[0]}" | awk -F: '{print $6}')"
  as_user "${agents[0]}" git -C "$first_home/projects/jarate" fetch --tags --force origin || die "fetch --tags failed in ${agents[0]}"
  as_user "${agents[0]}" git -C "$first_home/projects/jarate" rev-parse --verify "refs/tags/$TAG^{commit}" >/dev/null || die "tag $TAG does not exist after fetch --tags"

  local tag_sha
  tag_sha="$(as_user "${agents[0]}" git -C "$first_home/projects/jarate" rev-parse "refs/tags/$TAG^{commit}")"
  log "rollout $TAG ($tag_sha) across ${#agents[@]} agent(s): ${agents[*]}"

  local uid repo prev key key_file code host
  for u in "${agents[@]}"; do
    uid="$(id -u "$u")"
    h="$(getent passwd "$u" | awk -F: '{print $6}')"
    repo="$h/projects/jarate"
    log "agent $u (uid $uid): starting"

    # 1. dirty tree — fail loud before anything moves.
    if [[ -n "$(as_user "$u" git -C "$repo" status --porcelain)" ]]; then
      die "agent $u: dirty tree at $repo (a dirty checkout is never moved by a rollout)"
    fi

    # 2. fetch the tags.
    as_user "$u" git -C "$repo" fetch --tags origin || die "agent $u: git fetch --tags failed"

    # 3. plain ff to the tag; divergent = fail loud (no merge, no rebase).
    prev="$(as_user "$u" git -C "$repo" rev-parse HEAD)"
    if [[ "$prev" != "$tag_sha" ]]; then
      as_user "$u" git -C "$repo" merge --ff-only "refs/tags/$TAG" || die "agent $u: checkout diverged from $TAG at $prev (plain ff refused; fix the branch by hand)"
    fi

    # 4. restart pi.service via the user systemd instance.
    local bar_s
    bar_s="$(date +%s)"
    if [[ -f "$LIVE_DIR/$uid" ]]; then
      local pre
      pre="$(stat -c %Y "$LIVE_DIR/$uid" 2>/dev/null || echo 0)"
      [[ "$pre" -gt "$bar_s" ]] && bar_s="$pre"
    fi
    as_user "$u" env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user restart pi.service || die "agent $u: restart pi.service failed"

    # 5. verify: the live marker mtime advances after the restart.
    wait_marker "$LIVE_DIR" "$uid" "$bar_s" "$GATE_TIMEOUT_S" || die "agent $u: $LIVE_DIR/$uid did not advance within ${GATE_TIMEOUT_S}s after restart (pi.service did not come up)"

    # 6. verify: one delivered smoke say via hall-monitor (2xx). Recipient = smoke_target: 'warden', except the warden lane itself targets 'piboy' (a self-say 400s, #332).
    key_file="$(resolve_key_file "$h")" || die "agent $u: no agent key file (tried: $h/.config/hall-monitor/agent-key, $h/.config/hall-monitor/key, $h/hall-monitor.key)"
    key="$(first_key_line "$key_file")" || die "agent $u: no agent key line in $key_file"
    host="$(hostname)"
    code="$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST "$HM_BASE/api/fleet/say" \
      -H "X-Agent-Key: $key" \
      -H 'Content-Type: application/json' \
      -d "{\"to\": \"$(smoke_target "$u")\", \"message\": \"smoke: rolled $TAG (${tag_sha:0:7}) on $host for $u\"}")"
    [[ "$code" =~ ^2[0-9][0-9]$ ]] || die "agent $u: smoke say failed (http $code)"

    # 7. pin: the tag's SHA, written only after the rollout fully passed.
    mkdir -p "$PINNED_DIR"
    printf '%s\n' "$tag_sha" >"$PINNED_DIR/$uid"
    log "agent $u: pinned $tag_sha ($TAG); rollout verified"
  done

  log "rollout $TAG complete: ${#agents[@]} agent(s) on $tag_sha"
}

# Guard so tests can source the pure helpers without running main.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

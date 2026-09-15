#!/usr/bin/env bash
#
# jarate deploy — timer-driven, idempotent, health-gated, auto-rollback.
# (Pattern: switchboard's deploy/deploy.sh.)
#
# Runs as monky (user unit systemd/jarate-deploy.service, or manually).
# Flow: fetch → (up to date? exit 0) → pull → install → check (typecheck) →
# test → restart pi.service → health gate (≤90s) → on fail: reset to previous
# commit, restart, re-gate once.
#
# jarate layout facts (2026-09-12):
#   - NO jarate service of its own: the checkout IS the deployment
#     (install.sh v3, "no more rsync biz"). Machine paths (~/scripts/pi-bg,
#     ~/bin/agent-say, packages/bridge) are symlinks into the checkout.
#   - The long-running consumer is pi.service (pi + @jarate/bridge via
#     settings.json "packages"), so "restart jarate" = restart pi.service.
#   - No build step (no dist/ artifacts), so rollback is a plain
#     git reset --hard + restart.
#   - Real ready signal: "[interactions] registered N slash commands in
#     guild ..." — logged by the bridge at Discord connect on every pi boot.
#
# Backoff (2026-09-15): 3+ consecutive failed attempts on the SAME commit
# stop the tick (one log line) until the commit changes or --force — a
# broken commit otherwise re-deploys, re-rolls-back and re-restarts
# pi.service every timer tick.
#
# .deploy-state: line 1 = deployed commit, line 2 (optional) =
# "<failed-commit> <consecutive-fails>".
#
# Only bash + git + bun + systemctl/journalctl (user) are required.

set -euo pipefail

# bun is not on monky's default PATH in all systemd contexts.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
# systemctl --user / journalctl --user need this when invoked from a timer.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

REPO="${JARATE_HOME:-$HOME/projects/jarate}"
STATE_FILE="$REPO/.deploy-state"
SERVICE="${JARATE_DEPLOY_SERVICE:-pi.service}"
LOCK_FILE="${JARATE_DEPLOY_LOCK:-/run/user/$(id -u)/jarate-deploy.lock}"
LOG_DIR="$HOME/.local/share/jarate/logs"
LOG_FILE="$LOG_DIR/deploy-$(date '+%Y%m%d-%H%M%S').log"
GATE_TIMEOUT_S="${JARATE_GATE_TIMEOUT_S:-90}"

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

FORCE=0
GATE_REASON=""

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "DEPLOY FAIL: $*"; exit 1; }

# state helpers: line 1 = deployed commit, line 2 = "<commit> <fails>"
state_deployed() { sed -n 1p "$STATE_FILE" 2>/dev/null | tr -d '[:space:]'; }
state_fail_commit() { sed -n 2p "$STATE_FILE" 2>/dev/null | awk '{print $1}'; }
state_fail_count() {
  local n
  n="$(sed -n 2p "$STATE_FILE" 2>/dev/null | awk '{print $2}')"
  [[ "$n" =~ ^[0-9]+$ ]] && printf '%s' "$n" || printf '0'
}

# record_fail <tried-commit> <deployed-after>: bump the same-commit
# fail counter (line 2) and record what is actually deployed (line 1).
record_fail() {
  local tried="$1" deployed_after="$2"
  local cur=0
  [[ "$(state_fail_commit)" == "$tried" ]] && cur="$(state_fail_count)"
  printf '%s\n%s %s\n' "$deployed_after" "$tried" "$((cur + 1))" >"$STATE_FILE"
}

# --- health gate -------------------------------------------------------------

# gate <since-ts>
# Poll up to GATE_TIMEOUT_S. Every tick ALL of:
#   a. pi.service is active
#   b. journal lines SINCE the restart show the bridge's Discord-ready line
#      ("[interactions] registered" = guild slash commands registered,
#       which only happens after the Discord gateway connect succeeds)
# Sets GATE_REASON on failure.
gate() {
  local since="$1"
  local deadline=$(( $(date +%s) + GATE_TIMEOUT_S ))
  local reasons=()

  while (( $(date +%s) < deadline )); do
    reasons=()

    local state
    state="$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)"
    if [[ "$state" != "active" ]]; then
      reasons+=("$SERVICE not active (state: ${state:-unknown})")
    fi

    if ! journalctl --user -u "$SERVICE" --since "$since" --no-pager 2>/dev/null \
        | grep -aq '\[interactions\] registered'; then
      reasons+=("no '[interactions] registered' line in $SERVICE journal since restart")
    fi

    if [[ ${#reasons[@]} -eq 0 ]]; then
      GATE_REASON=""
      return 0
    fi
    GATE_REASON="${reasons[*]}"
    sleep 3
  done
  return 1
}

# --- rollback ----------------------------------------------------------------

# rollback <new-commit> <prev-commit>
# Reset the checkout to the previous commit, restart, re-run the gate once.
# Always exits 1 (this deploy attempt failed) — or 2 if even the rollback
# did not pass the gate.
rollback() {
  local new_commit="$1" prev_commit="$2"
  local original_reason="$GATE_REASON"

  log "HEALTH GATE FAILED (${GATE_REASON}) — rolling back $new_commit -> $prev_commit"
  cd "$REPO"

  git reset --hard "$prev_commit" || die "rollback: git reset --hard $prev_commit failed"
  bun install --cwd "$REPO/packages/bridge" >/dev/null

  # stop -> since -> start: the OLD process can re-log '[interactions]' lines
  # while it shuts down; capturing since after it is dead keeps the gate
  # window free of stale ready lines.
  systemctl --user stop "$SERVICE" || die "rollback: stop $SERVICE failed"
  local since
  since="$(date '+%F %T')"
  systemctl --user start "$SERVICE" || die "rollback: start $SERVICE failed"

  if gate "$since"; then
    log "ROLLED BACK to $prev_commit. Reason: $original_reason"
    exit 1
  fi
  log "CRITICAL: rollback gate also failed (${GATE_REASON}). Manual fix needed."
  exit 2
}

# --- main --------------------------------------------------------------------

main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
    --force) FORCE=1 ;;
    *) die "unknown flag: $arg (only --force is supported)" ;;
    esac
  done

  [[ -d "$REPO/.git" ]] || die "repo not found: $REPO"
  cd "$REPO"

  # Overlapping timer ticks must not double-deploy.
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another deploy holds $LOCK_FILE; skipping this tick"
    exit 0
  fi

  git fetch origin
  local new_commit
  new_commit="$(git rev-parse origin/main)"

  # Log hygiene: prune deploy logs older than 3 days (each tick tees a
  # fresh one; the live one is minutes old and survives the find).
  find "$LOG_DIR" -type f -mtime +3 -delete 2>/dev/null || true

  local deployed="" fail_commit="" fails=0
  if [[ -f "$STATE_FILE" ]]; then
    deployed="$(state_deployed)"
    fail_commit="$(state_fail_commit)"
    fails="$(state_fail_count)"
  fi
  local prev_commit
  if [[ -n "$deployed" ]]; then
    prev_commit="$deployed"
  else
    prev_commit="$(git rev-parse HEAD)"
    log "no $STATE_FILE yet; assuming current HEAD ($prev_commit) is deployed"
  fi

  # Backoff: 3+ consecutive fails on the SAME commit -> skip the tick
  # (single log line) until the commit changes or --force.
  if [[ $FORCE -eq 0 && "$fail_commit" == "$new_commit" && $fails -ge 3 ]]; then
    log "backoff: $fails consecutive fails on $new_commit; skipping tick (deploy --force to override)"
    exit 0
  fi

  # A non-zero exit records the failed attempt (backoff counter) and
  # what is actually deployed afterwards (rollback restores prev_commit;
  # a pre-restart die never left the old commit). Success rewrites line 1
  # and drops the counter. Globals (no local): the EXIT trap fires after
  # main has returned.
  DEPLOY_TRIED=""
  DEPLOY_PREV="$prev_commit"
  on_exit() {
    local ec=$?
    if [[ $ec -ne 0 && -n "$DEPLOY_TRIED" ]]; then
      record_fail "$DEPLOY_TRIED" "$DEPLOY_PREV"
      log "recorded fail #$(state_fail_count) on $DEPLOY_TRIED (backoff after 3)"
    fi
    return 0
  }
  trap on_exit EXIT

  if [[ $FORCE -eq 0 && "$deployed" == "$new_commit" ]]; then
    log "up to date ($deployed)"
    exit 0
  fi

  log "deploying $deployed -> $new_commit (log: $LOG_FILE)"
  DEPLOY_TRIED="$new_commit"
  git pull --ff-only origin main || die "git pull --ff-only origin main failed"

  # Machine-local deps (node_modules is gitignored). Matches install.sh.
  bun install --cwd "$REPO/packages/bridge" || die "bun install (packages/bridge) failed"

  # Pre-deploy verification. Fails abort BEFORE any restart.
  # typecheck is jarate's check (biome lint runs in CI; typecheck+test is the
  # gate here). No build step exists for jarate — checkout IS the deployment.
  bun run typecheck || die "pre-deploy typecheck failed"
  bun run test || die "pre-deploy tests failed"

  # stop -> since -> start (not restart): the old process can re-log
  # '[interactions]' lines while shutting down, which would be a stale ready
  # signal inside the gate window. systemctl stop returns after exit, so the
  # old process is dead before we open the window.
  systemctl --user stop "$SERVICE" || die "stop $SERVICE failed"
  local since
  since="$(date '+%F %T')"
  systemctl --user start "$SERVICE" || die "start $SERVICE failed"

  if gate "$since"; then
    printf '%s\n' "$new_commit" >"$STATE_FILE"
    log "deployed $new_commit; gate passed"
  else
    rollback "$new_commit" "$prev_commit"
  fi
}

# Guard so tests can source the pure helpers without running main.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

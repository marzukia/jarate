#!/usr/bin/env bash
#
# init-repo.sh — instantiate the fleet newrepo boilerplate.
#
# Usage:
#   init-repo.sh <dir> <owner/repo> [options]
#
# Options:
#   --push              gh repo create + push after init (needs gh + token)
#   --private           repo is private (with --push)
#   --force             overwrite existing files (default: refuse)
#   --dry-run           print the plan, touch nothing
#   --biome             keep the biome.json starter (dropped by default)
#   --lead L            project lead (name + how to reach)
#   --commit-identity I "name <email>" agents commit as
#   --stack S           one-line stack description
#   --project P         human project name (default: repo name, titlecased)
#   --remote URL        git remote (default: https://github.com/<owner>/<repo>.git)
#
# Idempotent: refuses to clobber files that already exist in <dir>.

set -euo pipefail

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

DIR="" OWNER_REPO="" PUSH=0 PRIVATE=0 FORCE=0 DRY=0 BIOME=0
LEAD="TBD (fill before first merge)"
COMMIT_IDENTITY="TBD <tbd@example.com>"
STACK="TBD: one-line stack description (stack, deploy target, layout)"
PROJECT="" REMOTE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1 ;;
    --private) PRIVATE=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    --biome) BIOME=1 ;;
    --lead) LEAD="$2"; shift ;;
    --commit-identity) COMMIT_IDENTITY="$2"; shift ;;
    --stack) STACK="$2"; shift ;;
    --project) PROJECT="$2"; shift ;;
    --remote) REMOTE="$2"; shift ;;
    -h|--help) usage 0 ;;
    -*) echo "error: unknown flag: $1" >&2; usage 1 ;;
    *) if [ -z "$DIR" ]; then DIR="$1"
       elif [ -z "$OWNER_REPO" ]; then OWNER_REPO="$1"
       else echo "error: extra arg: $1" >&2; exit 1; fi ;;
  esac
  shift
done

[ -n "$DIR" ] && [ -n "$OWNER_REPO" ] || usage 1
[[ "$OWNER_REPO" == */* ]] || { echo "error: <owner/repo> expected, got '$OWNER_REPO'" >&2; exit 1; }

OWNER="${OWNER_REPO%%/*}"
REPO="${OWNER_REPO##*/}"
[ -n "$PROJECT" ] || PROJECT="$(echo "$REPO" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')"
[ -n "$REMOTE" ] || REMOTE="https://github.com/${OWNER_REPO}.git"

# Commit identity: "name <email>" -> name, email
C_NAME="${COMMIT_IDENTITY%% *}"
C_EMAIL_RAW="${COMMIT_IDENTITY##* }"
C_EMAIL="${C_EMAIL_RAW#<}"; C_EMAIL="${C_EMAIL%>}"

TEMPLATE_DIR="$(cd "$(dirname "$0")/../templates/newrepo" && pwd)"
[ -d "$TEMPLATE_DIR" ] || { echo "error: template dir not found: $TEMPLATE_DIR" >&2; exit 1; }

# --- plan ------------------------------------------------------------------
mapfile -t FILES < <(cd "$TEMPLATE_DIR" && find . -type f | sed 's|^\./||' | sort)
KEEP=()
for f in "${FILES[@]}"; do
  [ "$f" = "biome.json" ] && [ "$BIOME" -eq 0 ] && continue
  KEEP+=("$f")
done

existing=()
for f in "${KEEP[@]}"; do
  [ -e "$DIR/$f" ] && existing+=("$f")
done

echo "init-repo: ${OWNER_REPO} -> $DIR"
if [ ${#existing[@]} -gt 0 ] && [ "$FORCE" -eq 0 ]; then
  echo "error: refusing to clobber existing files (use --force to override):" >&2
  printf '  %s\n' "${existing[@]}" >&2
  exit 1
fi

for f in "${KEEP[@]}"; do
  if [ -e "$DIR/$f" ]; then
    echo "  overwrite  $f"
  else
    echo "  create     $f"
  fi
done
[ "$BIOME" -eq 0 ] && [ -e "$TEMPLATE_DIR/biome.json" ] && echo "  drop       biome.json (pass --biome to keep)"
echo "  git        init -b main, commit as $C_NAME <$C_EMAIL>"
if command -v pre-commit >/dev/null 2>&1; then
  echo "  hooks      pre-commit install (writes .git/hooks/pre-commit)"
else
  echo "  hooks      core.hooksPath=.git/hooks (pre-commit absent; run 'pre-commit install' after setup)"
fi
echo "  remote     $REMOTE"
[ "$PUSH" -eq 1 ] && echo "  push       gh repo create ${OWNER_REPO} $( [ "$PRIVATE" -eq 1 ] && echo --private )" || true

[ "$DRY" -eq 1 ] && { echo "dry-run: no changes made"; exit 0; }

# --- render ----------------------------------------------------------------
render() { # $1 = file
  sed -e "s|{{PROJECT}}|$PROJECT|g" \
      -e "s|{{REPO}}|$REPO|g" \
      -e "s|{{OWNER}}|$OWNER|g" \
      -e "s|{{LEAD}}|$LEAD|g" \
      -e "s|{{COMMIT_IDENTITY}}|$C_NAME|g" \
      -e "s|{{STACK}}|$STACK|g" \
      "$1"
}

for f in "${KEEP[@]}"; do
  mkdir -p "$DIR/$(dirname "$f")"
  render "$TEMPLATE_DIR/$f" > "$DIR/$f"
done

# Leftover-placeholder guard: any unrendered {{TOKEN}} is a bug.
if left=$(grep -rEl '\{\{[A-Z_]+\}\}' "$DIR" 2>/dev/null || true); then
  if [ -n "$left" ]; then
    echo "error: unrendered placeholders in:" >&2
    echo "$left" >&2
    exit 1
  fi
fi

# --- git -------------------------------------------------------------------
if [ ! -d "$DIR/.git" ]; then
  git -C "$DIR" init -b main -q
fi
git -C "$DIR" config user.name "$C_NAME"
git -C "$DIR" config user.email "$C_EMAIL"
if command -v pre-commit >/dev/null 2>&1; then
  # pre-commit install writes .git/hooks/pre-commit itself. It REFUSES to
  # run when core.hooksPath is set ("Cowardly refusing to install hooks"),
  # so do NOT set hooksPath in this branch.
  if (cd "$DIR" && pre-commit install); then
    echo "  hooks      pre-commit installed (.git/hooks/pre-commit)"
  else
    echo "error: 'pre-commit install' failed — see output above" >&2
    exit 1
  fi
else
  git -C "$DIR" config core.hooksPath .git/hooks
  echo "  hooks      pre-commit not found; core.hooksPath=.git/hooks set. Run 'pre-commit install' after setup."
fi
git -C "$DIR" add -A
# --no-verify: the bootstrap commit lands on main, which the template's
# no-commit-to-branch hook (rightly) refuses for day-to-day work.
# Guard: --force re-render with zero content diff stages nothing; an empty
# commit exits 1 and set -e would report failure on a successful no-op.
if git -C "$DIR" diff --cached --quiet; then
  echo "  commit     $(git -C "$DIR" rev-parse --short HEAD) (unchanged — no new commit)"
else
  git -C "$DIR" commit -q --no-verify -m "chore: init ${REPO} from fleet boilerplate"
  echo "  commit     $(git -C "$DIR" rev-parse --short HEAD)"
fi

# --- remote / push ---------------------------------------------------------
if ! git -C "$DIR" remote get-url origin >/dev/null 2>&1; then
  git -C "$DIR" remote add origin "$REMOTE"
fi
if [ "$PUSH" -eq 1 ]; then
  if command -v gh >/dev/null 2>&1 && ! gh repo view "$OWNER_REPO" >/dev/null 2>&1; then
    gh repo create "$OWNER_REPO" ${PRIVATE:+--private} --source "$DIR" --remote origin --push
  else
    git -C "$DIR" push -u origin main
  fi
fi

echo "done: $DIR (${OWNER_REPO})"
echo "next: wire LINT_CMD/TEST_CMD in the Makefile, fill the TBD fields, then start the loop from AGENTS.md"

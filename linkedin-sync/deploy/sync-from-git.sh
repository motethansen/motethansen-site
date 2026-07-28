#!/usr/bin/env bash
#
# Bring the droplet's checkout in line with origin/main, then rebuild the image.
#
# Why this exists: the droplet ran for a while as a hand-managed copy (files
# rsync'd/scp'd in) while its git checkout stayed pinned to an old commit. That
# is invisible drift — the code running was not the code in git, and nobody could
# tell by looking. This makes the droplet a real checkout again, repeatably.
#
# What it protects:
#   * linkedin-sync/.env        — gitignored, never touched.
#   * article-urls.txt          — LIVE data. The job appends to it whenever
#                                 discovery finds a new article, so the droplet's
#                                 copy is routinely AHEAD of git. It is preserved
#                                 and UNIONED with git's copy, never replaced.
#   * untracked local files     — .claude/, AGENTS.md, *.bak, captures/ survive
#                                 (this never runs `git clean`).
#
# Anything else in the working tree is discarded in favour of origin/main. That
# is the point: the droplet is a deploy target, not somewhere to edit code.
#
#   bash deploy/sync-from-git.sh            # sync + rebuild
#   bash deploy/sync-from-git.sh --no-build # sync only
#   bash deploy/sync-from-git.sh --dry-run  # show what would change, touch nothing

set -euo pipefail

# `git reset --hard` rewrites this very file mid-execution, and bash reads
# scripts incrementally — a changed file length can make it resume at the wrong
# byte and execute garbage. So re-exec from a private copy first.
if [ "${_SYNC_RELAUNCHED:-}" != "1" ]; then
  _copy="$(mktemp /tmp/sync-from-git.XXXXXX.sh)"
  cp "$0" "$_copy"
  export _SYNC_RELAUNCHED=1
  trap 'rm -f "$_copy"' EXIT
  bash "$_copy" "$@"
  exit $?
fi

REPO="$(cd "$(dirname "$(readlink -f "$0")")/../.." 2>/dev/null && pwd || echo /opt/motethansen-site)"
[ -d "$REPO/.git" ] || { echo "error: $REPO is not a git checkout" >&2; exit 1; }
cd "$REPO"

URLS="linkedin-sync/article-urls.txt"
BUILD=1; DRY=0
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --dry-run)  DRY=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

echo "▶ Fetching origin..."
git fetch origin --quiet
HEAD_NOW="$(git rev-parse --short HEAD)"
TARGET="$(git rev-parse --short origin/main)"
echo "  local  $HEAD_NOW"
echo "  target $TARGET"
if [ "$HEAD_NOW" = "$TARGET" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  echo "  already in sync"
fi

if [ "$DRY" = "1" ]; then
  echo ""
  echo "▶ Tracked files that would change:"
  git diff --stat HEAD origin/main | tail -20
  echo ""
  echo "▶ Local modifications that would be DISCARDED:"
  git status --porcelain --untracked-files=no | sed 's/^/  /' || true
  echo ""
  echo "(dry run — nothing changed)"
  exit 0
fi

# Preserve the live URL list before the reset.
SAVED=""
if [ -f "$URLS" ]; then
  SAVED="$(mktemp)"
  cp "$URLS" "$SAVED"
  echo "▶ Preserved $(grep -c '^https' "$SAVED" || echo 0) live article URL(s)"
fi

echo "▶ Resetting to origin/main..."
git reset --hard origin/main --quiet
echo "  now at $(git rev-parse --short HEAD)"

# Union the two lists: git's copy provides the comments/seed, the droplet's copy
# provides anything discovery appended since the last commit. Order is preserved
# and duplicates dropped. The droplet's list is never allowed to shrink.
if [ -n "$SAVED" ]; then
  before=$(grep -c '^https' "$URLS" 2>/dev/null || echo 0)
  added=0
  while IFS= read -r line; do
    case "$line" in
      https://*)
        if ! grep -Fxq "$line" "$URLS"; then echo "$line" >> "$URLS"; added=$((added+1)); fi ;;
    esac
  done < "$SAVED"
  rm -f "$SAVED"
  echo "▶ URL list: $before from git + $added preserved from the droplet = $(grep -c '^https' "$URLS")"
  if [ "$added" -gt 0 ]; then
    echo "  NOTE: $added URL(s) exist only on the droplet. Commit them so git catches up:"
    echo "        scp root@\$DROPLET:$REPO/$URLS ./$URLS"
  fi
fi

if [ "$BUILD" = "1" ]; then
  echo "▶ Rebuilding the sync image..."
  ( cd linkedin-sync && docker compose build sync >/dev/null && echo "  built" )
fi

echo ""
echo "✅ Droplet is in sync with origin/main ($(git rev-parse --short HEAD))"
echo "   Verify with: cd linkedin-sync && docker compose run --rm sync --dry-run"

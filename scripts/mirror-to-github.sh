#!/usr/bin/env bash
#
# Mirror the current branch to GitHub (the secondary remote).
#
# The canonical origin is GitCode (gitcode.com/ProgramAnalysis/homegraph.git).
# GitHub (github.com/fujiaxin-coder/homegraph) is the mirror that runs the
# Release CI. This script pushes the current branch to `github` so the GitHub
# Actions workflow can see the latest code.
#
# Usage:
#   scripts/mirror-to-github.sh              # push current branch
#   scripts/mirror-to-github.sh main         # push a specific branch
#   scripts/mirror-to-github.sh --init       # first-time mirror: push all refs
#
set -euo pipefail

REMOTE="github"
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "[mirror] remote '$REMOTE' is not configured."
  echo "[mirror] add it with:  git remote add github https://github.com/fujiaxin-coder/homegraph.git"
  exit 1
fi

if [ "$BRANCH" = "--init" ]; then
  echo "[mirror] initial mirror: pushing all refs to $REMOTE"
  git push "$REMOTE" --mirror
  exit $?
fi

echo "[mirror] pushing $BRANCH to $REMOTE"
git push "$REMOTE" "$BRANCH"
echo "[mirror] done: $BRANCH → $REMOTE"

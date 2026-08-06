#!/usr/bin/env bash
# Run build + unit tests across Node majors for engines compatibility.
# Default matrix: 18 19 20 21 22 23 24 25 (see docs/specs/0003-support-node-18.md §5.1).
#
# Requires nvm (https://github.com/nvm-sh/nvm).
#
# Usage:
#   ./scripts/test-node-matrix.sh
#   ./scripts/test-node-matrix.sh 18 22 25          # subset
#   NODE_MATRIX="18 20 22" ./scripts/test-node-matrix.sh
#   FAIL_FAST=1 ./scripts/test-node-matrix.sh      # stop on first failure
#   SKIP_INSTALL=1 ./scripts/test-node-matrix.sh   # reuse node_modules (not recommended across majors)
#
# Env:
#   NODE_MATRIX   Space-separated majors (default: 18 19 20 21 22 23 24 25)
#   FAIL_FAST     If 1, exit on first failed major (default: 0 — run all, summarize)
#   SKIP_INSTALL  If 1, skip `rm -rf node_modules && npm ci` per major
#   NVM_DIR       nvm install path (default: ~/.nvm)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEFAULT_MATRIX=(18 19 20 21 22 23 24 25)
FAIL_FAST="${FAIL_FAST:-0}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # nvm is a shell function; disable nounset while sourcing
    set +u
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    set -u
    return 0
  fi
  echo "error: nvm not found at \$NVM_DIR/nvm.sh (NVM_DIR=${NVM_DIR})" >&2
  echo "Install nvm: https://github.com/nvm-sh/nvm" >&2
  exit 1
}

resolve_matrix() {
  if [ "$#" -gt 0 ]; then
    MATRIX=("$@")
  elif [ -n "${NODE_MATRIX:-}" ]; then
    # shellcheck disable=SC2206
    MATRIX=($NODE_MATRIX)
  else
    MATRIX=("${DEFAULT_MATRIX[@]}")
  fi
}

run_one() {
  local major="$1"
  echo
  echo "========================================"
  echo " Node ${major}"
  echo "========================================"

  nvm install "${major}"
  nvm use "${major}"
  echo "node: $(node -v)  npm: $(npm -v)  which: $(command -v node)"

  if [ "$SKIP_INSTALL" != "1" ]; then
    rm -rf node_modules
    npm ci
  else
    echo "SKIP_INSTALL=1 — reusing node_modules (may break native addons across majors)"
    npm rebuild better-sqlite3 2>/dev/null || true
  fi

  npm run build
  npm test
}

load_nvm
resolve_matrix "$@"

echo "HomeGraph Node compatibility matrix"
echo "  root:    $ROOT"
echo "  majors:  ${MATRIX[*]}"
echo "  FAIL_FAST=${FAIL_FAST}  SKIP_INSTALL=${SKIP_INSTALL}"

passed=()
failed=()

for major in "${MATRIX[@]}"; do
  if run_one "$major"; then
    passed+=("$major")
    echo "✓ Node ${major} PASSED"
  else
    failed+=("$major")
    echo "✗ Node ${major} FAILED" >&2
    if [ "$FAIL_FAST" = "1" ]; then
      echo "FAIL_FAST=1 — stopping." >&2
      break
    fi
  fi
done

echo
echo "========================================"
echo " Summary"
echo "========================================"
echo "  passed: ${passed[*]:-(none)}"
echo "  failed: ${failed[*]:-(none)}"

if [ "${#failed[@]}" -gt 0 ]; then
  exit 1
fi

echo "All ${#passed[@]} Node major(s) passed."
exit 0

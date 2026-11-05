#!/usr/bin/env bash
# Owner-run root script: build the hashed lock file and the runtime venv.
# This is the only script in the repository that is expected to reach the
# network. It does NOT touch the store or sudoers.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "RUNTIME_VENV: FAIL (run as root)" >&2
  exit 1
fi

PYTHON="${PYTHON:-python3.12}"
INSTALL_ROOT="/opt/test-writer"
BUILD_VENV="/tmp/tw-build-venv"
LOCK_FILE="$INSTALL_ROOT/requirements.lock"
REQUIREMENTS="$INSTALL_ROOT/requirements.in"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "RUNTIME_VENV: FAIL ($PYTHON not found)" >&2
  exit 1
fi

if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)'; then
  echo "RUNTIME_VENV: FAIL (Python 3.12 is required)" >&2
  exit 1
fi

if ! "$PYTHON" -m pip --version >/dev/null 2>&1; then
  echo "RUNTIME_VENV: FAIL (pip is required for $PYTHON)" >&2
  exit 1
fi

if [[ ! -f "$REQUIREMENTS" ]]; then
  echo "RUNTIME_VENV: FAIL ($REQUIREMENTS is missing; run install-root.sh first)" >&2
  exit 1
fi

# Build tooling stays in /tmp; it is not part of the installed runtime.
rm -rf "$BUILD_VENV"
"$PYTHON" -m venv "$BUILD_VENV"
"$BUILD_VENV/bin/pip" install --upgrade pip pip-tools

"$BUILD_VENV/bin/pip-compile" \
  --generate-hashes \
  --output-file "$LOCK_FILE" \
  "$REQUIREMENTS"

rm -rf "$INSTALL_ROOT/venv"
"$PYTHON" -m venv "$INSTALL_ROOT/venv"
"$INSTALL_ROOT/venv/bin/pip" install --require-hashes -r "$LOCK_FILE"

# WHY: the service account runs the grader under bwrap; it must never be able
# to mutate site-packages and thereby gain code execution outside the sandbox.
chmod -R go-w "$INSTALL_ROOT/venv"

echo "RUNTIME_VENV: PASS"
echo "Lock file: $LOCK_FILE"
"$INSTALL_ROOT/venv/bin/pip" list --format=freeze | grep -E '^(pytest|hypothesis)==' || true

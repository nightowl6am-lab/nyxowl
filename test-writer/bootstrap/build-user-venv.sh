#!/usr/bin/env bash
# Owner-run rootless venv builder for the Test-Writer runtime.
# It creates <install>/venv and installs the hashed lock when present, else the
# loose requirements file.  It never uses root, a service account, or a
# system-owned install path.

set -euo pipefail

PYTHON="${PYTHON:-python3}"
INSTALL_ROOT="${TW_INSTALL_ROOT:-$HOME/.nyxowl/test-writer}"
VENV="$INSTALL_ROOT/venv"
LOCK_FILE="$INSTALL_ROOT/requirements.lock"
REQUIREMENTS="$INSTALL_ROOT/requirements.in"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "USER_VENV: FAIL ($PYTHON not found)" >&2
  exit 1
fi

if [[ ! -d "$INSTALL_ROOT" ]]; then
  echo "USER_VENV: FAIL ($INSTALL_ROOT is missing; run install-user.sh first)" >&2
  exit 1
fi

if [[ -f "$LOCK_FILE" ]]; then
  if ! grep -q -- '--hash=sha256:' "$LOCK_FILE"; then
    echo "USER_VENV: FAIL ($LOCK_FILE has no sha256 hashes)" >&2
    exit 1
  fi
  REQUIREMENTS_ARGS=(--require-hashes -r "$LOCK_FILE")
elif [[ -f "$REQUIREMENTS" ]]; then
  REQUIREMENTS_ARGS=(-r "$REQUIREMENTS")
else
  echo "USER_VENV: FAIL (requirements.lock or requirements.in is missing)" >&2
  exit 1
fi

rm -rf "$VENV"
"$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install "${REQUIREMENTS_ARGS[@]}"

# The sandbox runs this interpreter; the owner must remain able to update the
# venv, so only remove group/other write bits.
chmod -R go-w "$VENV"

echo "USER_VENV: PASS"
echo "Venv: $VENV"
"$VENV/bin/python" -m pip list --format=freeze | grep -E '^(pytest|hypothesis)==' || true

#!/usr/bin/env bash
# Owner-run rootless installer for the Test-Writer runtime tree.
# It installs into the owner's home by default and never requires a privilege
# transition, a service account, or a system-owned install path.  It does not
# build the venv.

set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${TW_INSTALL_ROOT:-$HOME/.nyxowl/test-writer}"
STORE_ROOT="${TW_STORE_ROOT:-$INSTALL_ROOT/store}"

if [[ -z "$INSTALL_ROOT" || "$INSTALL_ROOT" == "/" ]]; then
  echo "USER_INSTALL: FAIL (refusing unsafe install root: '$INSTALL_ROOT')" >&2
  exit 1
fi

for directory in bin gate grader agent; do
  if [[ ! -d "$SOURCE_DIR/$directory" ]]; then
    echo "USER_INSTALL: FAIL (missing source directory: $SOURCE_DIR/$directory)" >&2
    exit 1
  fi
done

case "$STORE_ROOT" in
  /opt/*|/var/lib/*)
    echo "USER_INSTALL: FAIL (store must not be under /opt or /var/lib: $STORE_ROOT)" >&2
    exit 1
    ;;
esac

install -d -m 0755 "$INSTALL_ROOT"
install -d -m 0700 "$STORE_ROOT"

# Replace only the managed trees so stale files cannot survive an upgrade.
# The venv and the store are intentionally never removed here.
rm -rf "$INSTALL_ROOT/bin" "$INSTALL_ROOT/gate" "$INSTALL_ROOT/grader" "$INSTALL_ROOT/agent"
install -d -m 0755 \
  "$INSTALL_ROOT/bin" \
  "$INSTALL_ROOT/gate" \
  "$INSTALL_ROOT/grader" \
  "$INSTALL_ROOT/agent"
cp -a "$SOURCE_DIR/bin/." "$INSTALL_ROOT/bin/"
# The variant adder is owner-only and deliberately not broker-exposed.
install -m 0755 "$SOURCE_DIR/bin/tw-add-variant" "$INSTALL_ROOT/bin/tw-add-variant"
cp -a "$SOURCE_DIR/gate/." "$INSTALL_ROOT/gate/"
cp -a "$SOURCE_DIR/grader/." "$INSTALL_ROOT/grader/"
cp -a "$SOURCE_DIR/agent/." "$INSTALL_ROOT/agent/"

for file in \
  HELPER_API.md \
  requirements.in \
  README_OWNER.md \
  SANDBOX.md \
  DECISIONS.md \
  INTEGRATION.md \
  PLAN_STATUS.md; do
  install -m 0644 "$SOURCE_DIR/$file" "$INSTALL_ROOT/$file"
done
if [[ -f "$SOURCE_DIR/requirements.lock" ]]; then
  install -m 0644 "$SOURCE_DIR/requirements.lock" "$INSTALL_ROOT/requirements.lock"
fi

find "$INSTALL_ROOT/bin" "$INSTALL_ROOT/gate" "$INSTALL_ROOT/grader" "$INSTALL_ROOT/agent" \
  -type d -name __pycache__ -prune -exec rm -rf {} +

# The runtime is owner-owned and readable by the owner.  Wrappers stay
# executable; every other managed file is read-only to its owner.
find "$INSTALL_ROOT/bin" "$INSTALL_ROOT/gate" "$INSTALL_ROOT/grader" "$INSTALL_ROOT/agent" \
  -type d -exec chmod 0755 {} +
find "$INSTALL_ROOT/bin" "$INSTALL_ROOT/gate" "$INSTALL_ROOT/grader" "$INSTALL_ROOT/agent" \
  -type f -exec chmod 0644 {} +
find "$INSTALL_ROOT/bin" -type f -exec chmod 0755 {} +
for file in \
  HELPER_API.md \
  requirements.in \
  README_OWNER.md \
  SANDBOX.md \
  DECISIONS.md \
  INTEGRATION.md \
  PLAN_STATUS.md; do
  chmod 0644 "$INSTALL_ROOT/$file"
done
if [[ -f "$INSTALL_ROOT/requirements.lock" ]]; then
  chmod 0644 "$INSTALL_ROOT/requirements.lock"
fi
chmod 0700 "$STORE_ROOT"

echo "USER_INSTALL: PASS"
echo "Installed $INSTALL_ROOT as the current user."
echo "Store: $STORE_ROOT (0700)."
echo "Next: bash bootstrap/build-user-venv.sh"

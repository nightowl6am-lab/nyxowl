#!/usr/bin/env bash
# Owner-run root installer for the M0 runtime tree.
# It creates the service account and the two production roots, then copies the
# managed source. It does NOT write sudoers, build a venv, or start a service.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ROOT_INSTALL: FAIL (run as root)" >&2
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="/opt/test-writer"
STORE_ROOT="/var/lib/test-writer"
SERVICE_USER="tw-grader"
SERVICE_GROUP="tw-grader"

if ! getent group "$SERVICE_GROUP" >/dev/null; then
  groupadd --system "$SERVICE_GROUP"
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system \
    --gid "$SERVICE_GROUP" \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "$SERVICE_USER"
fi

install -d -o root -g root -m 0755 "$INSTALL_ROOT"
# The store is private to the service account; the owner never needs to read it.
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$STORE_ROOT"

# Replace only the managed trees so stale files cannot survive an upgrade.
rm -rf "$INSTALL_ROOT/grader" "$INSTALL_ROOT/agent"
install -d -o root -g root -m 0755 "$INSTALL_ROOT/grader" "$INSTALL_ROOT/agent"
cp -a "$SOURCE_DIR/grader/." "$INSTALL_ROOT/grader/"
cp -a "$SOURCE_DIR/agent/." "$INSTALL_ROOT/agent/"

for file in requirements.in README_OWNER.md SANDBOX.md DECISIONS.md INTEGRATION.md PLAN_STATUS.md; do
  install -o root -g root -m 0644 "$SOURCE_DIR/$file" "$INSTALL_ROOT/$file"
done

find "$INSTALL_ROOT" -type d -name __pycache__ -prune -exec rm -rf {} +

# Everything installed here is root-owned and read-only to the service account.
chown -R root:root "$INSTALL_ROOT"
find "$INSTALL_ROOT" -type d -exec chmod 0755 {} +
find "$INSTALL_ROOT" -type f -exec chmod 0644 {} +

echo "ROOT_INSTALL: PASS"
echo "Installed $INSTALL_ROOT (root:root 0755) and $STORE_ROOT ($SERVICE_USER:$SERVICE_GROUP 0700)."
echo "NOT installed: sudoers."
echo "Next: review bootstrap/sudoers.test-writer.draft, then run: sudo visudo -f /etc/sudoers.d/test-writer"

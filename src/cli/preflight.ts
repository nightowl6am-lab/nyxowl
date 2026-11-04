export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;

const NODE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function isSupportedNodeVersion(version: string): boolean {
  const match = NODE_VERSION_PATTERN.exec(version);
  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > MIN_NODE_MAJOR) {
    return true;
  }
  return major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR;
}

export function formatNodeUpgradeMessage(version: string): string {
  const found = version.replace(/^v/, "");
  return [
    `Nyxowl requires Node.js >= 22.13 (found v${found}).`,
    "Upgrade with: nvm install --lts",
    "Or download the latest LTS from https://nodejs.org",
    "",
  ].join("\n");
}

export function assertSupportedNode(version: string): void {
  if (!isSupportedNodeVersion(version)) {
    process.stderr.write(formatNodeUpgradeMessage(version));
    process.exit(1);
  }
}

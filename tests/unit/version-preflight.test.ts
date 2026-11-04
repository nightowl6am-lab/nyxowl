import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateClaudeHostPackage } from "../../src/cli/adapters/claude.ts";
import {
  formatNodeUpgradeMessage,
  isSupportedNodeVersion,
} from "../../src/cli/preflight.ts";
import { NYXOWL_VERSION } from "../../src/core/version.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Version single source of truth & Node preflight", () => {
  let tmpRoot: string;
  let nyxowlHome: string;
  let projectPath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-version-preflight-"));
    nyxowlHome = path.join(tmpRoot, "nyxowl-home");
    projectPath = path.join(tmpRoot, "project");
    fs.mkdirSync(projectPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("derives NYXOWL_VERSION from package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(NYXOWL_VERSION).toBe(pkg.version);
  });

  it("accepts only Node >= 22.13", () => {
    for (const version of ["18.19.1", "20.0.0", "22.12.9", "", "abc"]) {
      expect(isSupportedNodeVersion(version), version).toBe(false);
    }
    for (const version of ["22.13.0", "22.13.1", "24.22.2", "v22.13.0"]) {
      expect(isSupportedNodeVersion(version), version).toBe(true);
    }
  });

  it("formats an actionable Node upgrade message", () => {
    const message = formatNodeUpgradeMessage("18.19.1");
    expect(message).toContain("22.13");
    expect(message).toContain("18.19.1");
    expect(message).toContain("nvm install --lts");
    expect(message).toContain("nodejs.org");
  });

  it("generates host metadata using the package version and no stale literal", () => {
    generateClaudeHostPackage({ nyxowlHome, projectPath });

    const pluginPath = path.join(nyxowlHome, "hosts", "claude", ".claude-plugin", "plugin.json");
    const pluginText = fs.readFileSync(pluginPath, "utf8");
    const plugin = JSON.parse(pluginText) as { version: string };

    expect(plugin.version).toBe(NYXOWL_VERSION);
    expect(pluginText).not.toContain("0.1.0");
  });

  it("points the bin entry at the preflight wrapper", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      bin: { nyxowl: string };
    };
    expect(pkg.bin.nyxowl).toBe("./dist/cli/bin.js");
  });
});

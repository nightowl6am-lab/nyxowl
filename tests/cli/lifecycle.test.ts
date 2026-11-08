import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.ts";
import { MANAGED_BEGIN } from "../../src/cli/manifest.ts";
import { computeRepoId } from "../../src/core/git.ts";

function writeExecutable(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function createFakeOpencode(binDir: string): void {
  writeExecutable(
    path.join(binDir, "opencode"),
    [
      "#!/usr/bin/env node",
      'if (process.argv.includes("--version")) { console.log("opencode 2.2.5"); process.exit(0); }',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
}

function initGitRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Lifecycle Test"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# lifecycle fixture\n");
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repoDir, stdio: "ignore" });
}

function modeOf(targetPath: string): number {
  return fs.statSync(targetPath).mode & 0o777;
}

describe("fresh-HOME CLI lifecycle matrix", () => {
  let tmpRoot: string;
  let fakeBin: string;
  let homeDir: string;
  let nyxowlHome: string;
  let repoDir: string;
  let newRepoDir: string;
  const originalHome = process.env["HOME"];
  const originalPath = process.env["PATH"];
  const originalNyxHome = process.env["NYXOWL_HOME"];
  const originalInstall = process.env["NYXOWL_TESTWRITER_INSTALL"];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-lifecycle-"));
    fakeBin = path.join(tmpRoot, "bin");
    homeDir = path.join(tmpRoot, "home");
    nyxowlHome = path.join(homeDir, ".nyxowl");
    repoDir = path.join(tmpRoot, "work", "repo");
    newRepoDir = path.join(tmpRoot, "work", "repo-copy");

    fs.mkdirSync(homeDir, { recursive: true });
    createFakeOpencode(fakeBin);

    process.env["HOME"] = homeDir;
    process.env["NYXOWL_HOME"] = nyxowlHome;
    process.env["PATH"] = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    process.env["NYXOWL_TESTWRITER_INSTALL"] = "0";

    initGitRepo(repoDir);
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    restore("HOME", originalHome);
    restore("PATH", originalPath);
    restore("NYXOWL_HOME", originalNyxHome);
    restore("NYXOWL_TESTWRITER_INSTALL", originalInstall);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("runs doctor, init, copy+relink, and both uninstall modes in order", async () => {
    // 1. doctor on a fresh HOME/NYXOWL_HOME.
    const doctor = await runCli(["doctor"], { nyxowlHome });
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout).toContain("Skill slots: 11");
    expect(doctor.stdout).toContain("MCP Smoke Test: OK (38 tools listed)");
    expect(doctor.stdout).toContain("INSTALLED at");
    expect(modeOf(nyxowlHome)).toBe(0o700);
    const receiptKey = path.join(nyxowlHome, "secrets", "receipt.key");
    expect(fs.existsSync(receiptKey)).toBe(true);
    expect(modeOf(receiptKey)).toBe(0o600);

    // 2. init --project writes the committable config and managed AGENTS.md block.
    const init = await runCli(["init", "--project"], { cwd: repoDir, nyxowlHome });
    expect(init.exitCode).toBe(0);
    expect(fs.existsSync(path.join(repoDir, ".nyxowl", "config.json"))).toBe(true);
    const agentsBefore = fs.readFileSync(path.join(repoDir, "AGENTS.md"), "utf8");
    expect(agentsBefore).toContain(MANAGED_BEGIN);

    // Seed per-project state under the old repo id so relink has something to copy.
    const oldRepoId = await computeRepoId(repoDir);
    const oldProjectDir = path.join(nyxowlHome, "projects", oldRepoId);
    fs.mkdirSync(oldProjectDir, { recursive: true });
    fs.writeFileSync(path.join(oldProjectDir, "marker.txt"), "old-state\n");

    // 3. Copy the repository while the old path still exists, then relink.
    fs.cpSync(repoDir, newRepoDir, { recursive: true });
    expect(fs.existsSync(repoDir)).toBe(true);

    const relink = await runCli(["relink", repoDir, newRepoDir], {
      cwd: tmpRoot,
      nyxowlHome,
    });
    expect(relink.exitCode).toBe(0);
    expect(relink.stdout).toContain("Relinked Nyxowl project state");

    const newRepoId = await computeRepoId(newRepoDir);
    expect(newRepoId).not.toBe(oldRepoId);
    const newProjectDir = path.join(nyxowlHome, "projects", newRepoId);
    expect(fs.readFileSync(path.join(newProjectDir, "marker.txt"), "utf8")).toBe("old-state\n");
    expect(fs.existsSync(oldProjectDir)).toBe(false);

    // 4. Non-purging uninstall removes restored files but keeps the state home.
    const uninstall = await runCli(["uninstall", "--yes"], { nyxowlHome });
    expect(uninstall.exitCode).toBe(0);
    expect(uninstall.stdout).toContain("Purged ~/.nyxowl: no");
    const agentsPath = path.join(repoDir, "AGENTS.md");
    if (fs.existsSync(agentsPath)) {
      expect(fs.readFileSync(agentsPath, "utf8")).not.toContain(MANAGED_BEGIN);
    }
    expect(fs.existsSync(nyxowlHome)).toBe(true);

    // 5. Purging uninstall removes the state home entirely.
    const purge = await runCli(["uninstall", "--purge", "--yes"], { nyxowlHome });
    expect(purge.exitCode).toBe(0);
    expect(purge.stdout).toContain("Purged ~/.nyxowl: yes");
    expect(fs.existsSync(nyxowlHome)).toBe(false);
  });
});

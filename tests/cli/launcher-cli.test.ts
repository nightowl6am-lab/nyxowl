import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import { computeRepoId, computeWorkingTreeHash } from "../../src/core/git.ts";
import { ensureProjectNyxowlDirs } from "../../src/core/paths.ts";
import { NYXOWL_VERSION } from "../../src/core/version.ts";
import { ensureReceiptKey, generateUlid, signReceipt } from "../../src/core/receipts.ts";
import { openProjectDb } from "../../src/mcp/db/sqlite.ts";
import { runCli } from "../../src/cli/index.ts";
import { classifyProjectFolder, launchNyxowlSession } from "../../src/cli/launcher.ts";

function createFakeHostBin(binDir: string, name: string, version = "1.0.0"): string {
  const binPath = path.join(binDir, name);
  const script = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    `if (process.argv.includes("--version")) { console.log("${name} ${version}"); process.exit(0); }`,
    "if (process.env.FAKE_HOST_RECORD_FILE) {",
    "  fs.writeFileSync(process.env.FAKE_HOST_RECORD_FILE, JSON.stringify({",
    `    host: "${name}",`,
    "    argv: process.argv.slice(2),",
    "    cwd: process.cwd(),",
    "    nyxowlSession: process.env.NYXOWL_SESSION,",
    "    nyxowlProject: process.env.NYXOWL_PROJECT,",
    "    opencodeConfig: process.env.OPENCODE_CONFIG || null,",
    "  }));",
    "}",
    "process.exit(0);",
  ].join("\n");
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

describe("Step 9 — Launcher, Fake Host Binaries, Zero-Footprint & CLI Commands", () => {
  let tmpRoot: string;
  let nyxowlHome: string;
  let fakeBinDir: string;
  let envPathWithFakeHosts: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-cli-test-"));
    nyxowlHome = path.join(tmpRoot, "nyxowl-home");
    fakeBinDir = path.join(tmpRoot, "fake-bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    // Keep system git/node on PATH while putting fakeBinDir first
    envPathWithFakeHosts = `${fakeBinDir}${path.delimiter}${process.env["PATH"] ?? ""}`;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("classifies empty, adopt-no-git, and dirty git-repo folders accurately", async () => {
    const emptyDir = path.join(tmpRoot, "empty-folder");
    fs.mkdirSync(emptyDir, { recursive: true });
    const cEmpty = await classifyProjectFolder(emptyDir);
    expect(cEmpty.classification).toBe("empty");
    expect(cEmpty.mainCheckoutDirty).toBe(false);

    const adoptDir = path.join(tmpRoot, "adopt-folder");
    fs.mkdirSync(adoptDir, { recursive: true });
    fs.writeFileSync(path.join(adoptDir, "index.js"), "console.log(1);\n");
    const cAdopt = await classifyProjectFolder(adoptDir);
    expect(cAdopt.classification).toBe("adopt-no-git");

    const repoDir = path.join(tmpRoot, "git-repo-folder");
    fs.mkdirSync(repoDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: repoDir });
    await execCommand("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execCommand("git", ["config", "user.name", "Test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "app.ts"), "export const x = 1;\n");
    await execCommand("git", ["add", "-A"], { cwd: repoDir });
    await execCommand("git", ["commit", "-m", "init"], { cwd: repoDir });

    const cClean = await classifyProjectFolder(repoDir);
    expect(cClean.classification).toBe("git-repo");
    expect(cClean.mainCheckoutDirty).toBe(false);

    // Dirty the repo
    fs.writeFileSync(path.join(repoDir, "app.ts"), "export const x = 2;\n");
    const cDirty = await classifyProjectFolder(repoDir);
    expect(cDirty.classification).toBe("git-repo");
    expect(cDirty.mainCheckoutDirty).toBe(true);
  });

  it("launches fake host binaries with OpenCode first (opencode > claude > agy) and zero project footprint", async () => {
    createFakeHostBin(fakeBinDir, "claude", "1.0.0");
    createFakeHostBin(fakeBinDir, "opencode", "2.2.5");
    createFakeHostBin(fakeBinDir, "agy", "1.5.0");

    const projectDir = path.join(tmpRoot, "zero-footprint-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: projectDir });
    await execCommand("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
    await execCommand("git", ["config", "user.name", "Test"], { cwd: projectDir });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Clean Project\n");
    await execCommand("git", ["add", "-A"], { cwd: projectDir });
    await execCommand("git", ["commit", "-m", "init"], { cwd: projectDir });

    const beforeTreeHash = await computeWorkingTreeHash(projectDir);
    const beforeFiles = fs.readdirSync(projectDir).sort();

    const recordFile = path.join(tmpRoot, "host-invocation.json");
    process.env["FAKE_HOST_RECORD_FILE"] = recordFile;
    try {
      // 1. Default priority selects `opencode`
      const res1 = await launchNyxowlSession({
        targetPath: projectDir,
        nyxowlHome,
        envPath: envPathWithFakeHosts,
      });
      expect(res1.selectedHost.id).toBe("opencode");
      expect(res1.exitCode).toBe(0);

      const rec1 = JSON.parse(fs.readFileSync(recordFile, "utf8")) as {
        host: string;
        argv: string[];
        nyxowlSession: string;
        nyxowlProject: string;
        opencodeConfig: string | null;
      };
      expect(rec1.host).toBe("opencode");
      expect(rec1.argv).toEqual(["--standalone", projectDir]);
      expect(rec1.opencodeConfig).toContain("opencode.json");
      expect(rec1.nyxowlSession).toBe("1");
      expect(rec1.nyxowlProject).toBe(projectDir);

      // First-run generation covers OpenCode plus only the hosts detected on PATH.
      const hostDirs = fs
        .readdirSync(path.join(nyxowlHome, "hosts"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(hostDirs).toEqual(["antigravity", "claude", "opencode", "opencode-plugin"]);

      // 2. Explicit `--host claude` still selects Claude Code with its plugin flags
      const res2 = await launchNyxowlSession({
        targetPath: projectDir,
        hostOverride: "claude",
        nyxowlHome,
        envPath: envPathWithFakeHosts,
      });
      expect(res2.selectedHost.id).toBe("claude");
      const rec2 = JSON.parse(fs.readFileSync(recordFile, "utf8")) as {
        host: string;
        argv: string[];
      };
      expect(rec2.host).toBe("claude");
      expect(rec2.argv).toContain("--plugin-dir");
      expect(rec2.argv).toContain("--settings");
      expect(rec2.argv).toContain("--agent");
      expect(rec2.argv).toContain("nyxowl");

      // 3. Assert project tree is 100% byte-identical before and after `nyxowl <path>`!
      const afterTreeHash = await computeWorkingTreeHash(projectDir);
      const afterFiles = fs.readdirSync(projectDir).sort();
      expect(afterFiles).toEqual(beforeFiles);
      expect(afterTreeHash).toBe(beforeTreeHash);
    } finally {
      delete process.env["FAKE_HOST_RECORD_FILE"];
    }
  });

  it("executes CLI subcommands: doctor, status, handoff, receipts verify (detecting forgery), relink, and uninstall", async () => {
    createFakeHostBin(fakeBinDir, "claude", "1.0.0");

    const projectDir = path.join(tmpRoot, "cli-subcommands-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: projectDir });
    await execCommand("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
    await execCommand("git", ["config", "user.name", "Test"], { cwd: projectDir });
    fs.writeFileSync(path.join(projectDir, "index.ts"), "export const v = 1;\n");
    await execCommand("git", ["add", "-A"], { cwd: projectDir });
    await execCommand("git", ["commit", "-m", "init"], { cwd: projectDir });

    // --version & --help
    const verRes = await runCli(["--version"], { nyxowlHome });
    expect(verRes.exitCode).toBe(0);
    expect(verRes.stdout).toContain(`nyxowl v${NYXOWL_VERSION}`);

    const helpRes = await runCli(["--help"], { nyxowlHome });
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain("Usage:");

    // doctor
    const docRes = await runCli(["doctor"], {
      nyxowlHome,
      envPath: envPathWithFakeHosts,
      cwd: projectDir,
    });
    expect(docRes.exitCode).toBe(0);
    expect(docRes.stdout).toContain("Skills verified: 16 bundled skills");
    expect(docRes.stdout).toContain("MCP Smoke Test: OK");

    // Seed a valid signed receipt in SQLite and verify `nyxowl receipts verify` passes, then tamper with it and assert rejection (§13 Scenario 9)
    const repoId = await computeRepoId(projectDir);
    const projPaths = ensureProjectNyxowlDirs(repoId, nyxowlHome);
    const key = ensureReceiptKey(nyxowlHome);
    const treeHash = await computeWorkingTreeHash(projectDir);
    const receiptId = generateUlid();
    const signed = signReceipt(
      {
        id: receiptId,
        kind: "verify",
        status: "GREEN",
        worktree: projectDir,
        branch: "nyx/test",
        treeHash,
        baseSha: treeHash,
        commandsHash: "abc12345",
        evidenceArtifactId: null,
        createdAt: new Date().toISOString(),
      },
      key,
    );

    const db = openProjectDb(projPaths.stateDbFile);
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO receipts (id, kind, status, coverage, worktree, branch, tree_hash, base_sha, commands_hash, evidence_artifact_id, na_justification, created_at, hmac)
           VALUES (?, ?, ?, null, ?, ?, ?, ?, ?, null, null, ?, ?)`,
        )
        .run(
          signed.id,
          signed.kind,
          signed.status,
          signed.worktree,
          signed.branch,
          signed.treeHash,
          signed.baseSha,
          signed.commandsHash,
          signed.createdAt,
          signed.hmac,
        );
    });
    db.close();

    const verifyOk = await runCli(["receipts", "verify", receiptId], {
      nyxowlHome,
      cwd: projectDir,
    });
    expect(verifyOk.exitCode).toBe(0);
    expect(verifyOk.stdout).toContain("all HMAC signatures and tree bindings valid");

    // Tamper with the receipt in SQLite (Scenario 9: Forgery)
    const dbTamper = openProjectDb(projPaths.stateDbFile);
    dbTamper.withWriteTransaction((conn) => {
      conn
        .prepare("UPDATE receipts SET tree_hash = ? WHERE id = ?")
        .run("0000000000000000000000000000000000000000", receiptId);
    });
    dbTamper.close();

    const verifyForged = await runCli(["receipts", "verify", receiptId], {
      nyxowlHome,
      cwd: projectDir,
    });
    expect(verifyForged.exitCode).toBe(1);
    expect(verifyForged.stderr).toContain("INVALID HMAC");

    // status & handoff
    const statusRes = await runCli(["status"], { nyxowlHome, cwd: projectDir });
    expect(statusRes.exitCode).toBe(0);
    expect(statusRes.stdout).toContain("Nyxowl Status");

    const handoffRes = await runCli(["handoff"], { nyxowlHome, cwd: projectDir });
    expect(handoffRes.exitCode).toBe(0);
    expect(handoffRes.stdout).toContain("Nyxowl Session Hydrate");

    // uninstall --purge
    const uninstRes = await runCli(["uninstall", "--purge"], {
      nyxowlHome,
      cwd: projectDir,
    });
    expect(uninstRes.exitCode).toBe(0);
    expect(fs.existsSync(nyxowlHome)).toBe(false);
  });
});

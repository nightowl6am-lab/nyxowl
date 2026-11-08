import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import { computeRepoId } from "../../src/core/git.ts";
import { ensureProjectNyxowlDirs, type NyxProjectLayout } from "../../src/core/paths.ts";
import {
  ensureReceiptKey,
  generateUlid,
  signReceipt,
  type SignedReceipt,
} from "../../src/core/receipts.ts";
import { openProjectDb } from "../../src/mcp/db/sqlite.ts";
import { runCli } from "../../src/cli/index.ts";
import {
  MANAGED_BEGIN,
  MANAGED_END,
  loadInstallManifest,
  recordManifestEntry,
  uninstallFromManifest,
  upsertJsoncPropertyFile,
  upsertManagedBlockFile,
  upsertTomlSectionFile,
  writeTrackedFile,
} from "../../src/cli/manifest.ts";
import { ensureFirstRunSetup, runPreflightChecks } from "../../src/cli/setup.ts";

function createFakeHostBin(binDir: string, name: string, version = "1.0.0"): string {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, name);
  const script = [
    "#!/usr/bin/env node",
    `if (process.argv.includes("--version")) { console.log("${name} ${version}"); process.exit(0); }`,
    "process.exit(0);",
  ].join("\n");
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

function createFakeGit(binDir: string, stdout: string, exitCode = 0): string {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "git");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' '${stdout}'`,
    `exit ${exitCode}`,
  ].join("\n");
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function insertReceipt(projPaths: NyxProjectLayout, signed: SignedReceipt): void {
  const db = openProjectDb(projPaths.stateDbFile);
  db.withWriteTransaction((conn) => {
    conn
      .prepare(
        `INSERT INTO receipts (id, kind, status, coverage, worktree, branch, tree_hash, base_sha, commands_hash, evidence_artifact_id, na_justification, created_at, hmac)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        signed.id,
        signed.kind,
        signed.status,
        signed.coverage ?? null,
        signed.worktree,
        signed.branch,
        signed.treeHash,
        signed.baseSha,
        signed.commandsHash,
        signed.evidenceArtifactId,
        signed.naJustification ?? null,
        signed.createdAt,
        signed.hmac,
      );
  });
  db.close();
}

describe("Campaign C — CLI subcommand branch coverage", () => {
  let tmpRoot: string;
  let nyxowlHome: string;
  let projectDir: string;
  let fakeBinDir: string;
  let envPathWithFakeHosts: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-cli-coverage-"));
    nyxowlHome = path.join(tmpRoot, "nyxowl-home");
    projectDir = path.join(tmpRoot, "project");
    fakeBinDir = path.join(tmpRoot, "fake-bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    envPathWithFakeHosts = `${fakeBinDir}${path.delimiter}${process.env["PATH"] ?? ""}`;
    process.env["NYXOWL_TESTWRITER_INSTALL"] = "0";
    prevHome = process.env["NYXOWL_HOME"];
    process.env["NYXOWL_HOME"] = nyxowlHome;

    fs.mkdirSync(projectDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: projectDir });
    await execCommand("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
    await execCommand("git", ["config", "user.name", "Test"], { cwd: projectDir });
    fs.writeFileSync(path.join(projectDir, "index.ts"), "export const v = 1;\n");
    await execCommand("git", ["add", "-A"], { cwd: projectDir });
    await execCommand("git", ["commit", "-m", "init"], { cwd: projectDir });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env["NYXOWL_HOME"];
    else process.env["NYXOWL_HOME"] = prevHome;
    delete process.env["NYXOWL_TESTWRITER_INSTALL"];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("handles status and worktree list/prune/remove with missing and empty state", async () => {
    const missingStatus = await runCli(["status"], { nyxowlHome, cwd: projectDir });
    expect(missingStatus.exitCode).toBe(0);
    expect(missingStatus.stdout).toContain("No active state");

    const missingList = await runCli(["worktree", "list"], { nyxowlHome, cwd: projectDir });
    expect(missingList.exitCode).toBe(0);
    expect(missingList.stdout).toBe("No worktrees recorded.\n");

    const repoId = await computeRepoId(projectDir);
    const projPaths = ensureProjectNyxowlDirs(repoId, nyxowlHome);
    const db = openProjectDb(projPaths.stateDbFile);
    db.close();

    const emptyStatus = await runCli(["status"], { nyxowlHome, cwd: projectDir });
    expect(emptyStatus.stdout).toContain("Worktrees (0): none");
    expect(emptyStatus.stdout).toContain("Recent Slices (0): none");
    expect(emptyStatus.stdout).toContain("Active Locks (0): none");
    expect(emptyStatus.stdout).toContain("Receipts (0): none");

    for (const action of ["list", "prune"]) {
      const res = await runCli(["worktree", action], { nyxowlHome, cwd: projectDir });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe("No worktrees.\n");
    }

    const removeNoSlug = await runCli(["worktree", "remove"], {
      nyxowlHome,
      cwd: projectDir,
    });
    expect(removeNoSlug.exitCode).toBe(1);
    expect(removeNoSlug.stderr).toContain("worktree remove <slug>");

    const now = new Date().toISOString();
    const seed = openProjectDb(projPaths.stateDbFile);
    seed.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO worktrees (task_slug, branch, root, worktree_path, base_branch, base_sha, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("feat-auth", "nyx/feat-auth", tmpRoot, projPaths.worktreesRootDir, "main", "abc", "active", now, now);
    });
    seed.close();

    const list = await runCli(["worktree", "list"], { nyxowlHome, cwd: projectDir });
    expect(list.stdout).toContain("feat-auth\tnyx/feat-auth\tactive");
    const prune = await runCli(["worktree", "prune"], { nyxowlHome, cwd: projectDir });
    expect(prune.stdout).toContain("feat-auth");

    const removed = await runCli(["worktree", "remove", "feat-auth"], {
      nyxowlHome,
      cwd: projectDir,
    });
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toBe("Removed worktree record for feat-auth.\n");
    const afterRemove = await runCli(["worktree", "list"], { nyxowlHome, cwd: projectDir });
    expect(afterRemove.stdout).toContain("\tremoved\t");

    const unknown = await runCli(["worktree", "explode"], { nyxowlHome, cwd: projectDir });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toBe("Unknown worktree action: explode\n");
  });

  it("verifies receipts across missing DB, empty rows, all-row scans, and stale trees", async () => {
    const missing = await runCli(["receipts", "verify"], { nyxowlHome, cwd: projectDir });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toBe("No project state database found.\n");

    const repoId = await computeRepoId(projectDir);
    const projPaths = ensureProjectNyxowlDirs(repoId, nyxowlHome);
    const emptyDb = openProjectDb(projPaths.stateDbFile);
    emptyDb.close();

    const empty = await runCli(["receipts", "verify"], { nyxowlHome, cwd: projectDir });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toBe("No matching receipts found.\n");

    const key = ensureReceiptKey(nyxowlHome);
    const createdAt = new Date().toISOString();
    const goneWorktree = path.join(tmpRoot, "gone-worktree");
    const valid = signReceipt(
      {
        id: generateUlid(),
        kind: "verify",
        status: "GREEN",
        worktree: goneWorktree,
        branch: "nyx/test",
        treeHash: "a".repeat(40),
        baseSha: "b".repeat(40),
        commandsHash: "abc12345",
        evidenceArtifactId: null,
        createdAt,
      },
      key,
    );
    insertReceipt(projPaths, valid);

    const allRows = await runCli(["receipts", "verify"], { nyxowlHome, cwd: projectDir });
    expect(allRows.exitCode).toBe(0);
    expect(allRows.stdout).toContain("Verified 1 receipt(s)");

    const stale = signReceipt(
      {
        id: generateUlid(),
        kind: "seam",
        status: "GREEN",
        coverage: "full",
        worktree: projectDir,
        branch: "nyx/test",
        treeHash: "0".repeat(40),
        baseSha: "b".repeat(40),
        commandsHash: "def67890",
        evidenceArtifactId: null,
        createdAt,
      },
      key,
    );
    insertReceipt(projPaths, stale);

    const staleRes = await runCli(["receipts", "verify", stale.id], {
      nyxowlHome,
      cwd: projectDir,
    });
    expect(staleRes.exitCode).toBe(1);
    expect(staleRes.stderr).toContain("STALE TREE");
  });

  it("reports testwriter status, disabled install, and unknown actions", async () => {
    const missingSource = path.join(tmpRoot, "missing-source");
    const status = await runCli(["testwriter", "status"], {
      nyxowlHome,
      cwd: projectDir,
      testWriterSourceDir: missingSource,
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Test-Writer: not ready");
    expect(status.stdout).toContain("Wrappers: 0/6 executable");
    expect(status.stdout).toContain(`Source: ${missingSource}`);

    const install = await runCli(["testwriter", "install"], {
      nyxowlHome,
      cwd: projectDir,
      envPath: envPathWithFakeHosts,
      testWriterSourceDir: missingSource,
      installTestWriter: false,
    });
    expect(install.exitCode).toBe(1);
    expect(install.stdout).toContain("installation disabled");
    expect(install.stderr).toContain("installation disabled");

    const unknown = await runCli(["testwriter", "bogus"], {
      nyxowlHome,
      cwd: projectDir,
    });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toBe("Usage: nyxowl testwriter install|status\n");
  });

  it("initializes project config idempotently, connects GitHub, relinks state, and uninstalls without purge", async () => {
    const init = await runCli(["init", "--project"], { nyxowlHome, cwd: projectDir });
    expect(init.exitCode).toBe(0);
    const configPath = path.join(projectDir, ".nyxowl", "config.json");
    const agentsPath = path.join(projectDir, "AGENTS.md");
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(agentsPath, "utf8")).toContain(MANAGED_BEGIN);

    const initAgain = await runCli(["init", "--project"], { nyxowlHome, cwd: projectDir });
    expect(initAgain.exitCode).toBe(0);
    expect(initAgain.stdout).toContain(configPath);

    const github = await runCli(["github", "connect"], { nyxowlHome, cwd: projectDir });
    expect(github.exitCode).toBe(0);
    expect(github.stdout).toContain("Mode A (Optional Dedicated GitHub App)");
    expect(fs.existsSync(path.join(nyxowlHome, "secrets", "github-app"))).toBe(true);

    const relinkMissing = await runCli(["relink"], { nyxowlHome, cwd: projectDir });
    expect(relinkMissing.exitCode).toBe(1);
    expect(relinkMissing.stderr).toBe("Usage: nyxowl relink <old-path> <new-path>\n");

    const oldDir = path.join(tmpRoot, "old-repo");
    const newDir = path.join(tmpRoot, "new-repo");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    const oldRepoId = await computeRepoId(oldDir);
    const oldProj = ensureProjectNyxowlDirs(oldRepoId, nyxowlHome);
    fs.writeFileSync(path.join(oldProj.projectStateDir, "marker.txt"), "moved\n");
    const relink = await runCli(["relink", oldDir, newDir], {
      nyxowlHome,
      cwd: tmpRoot,
    });
    expect(relink.exitCode).toBe(0);
    expect(relink.stdout).toContain("Relinked Nyxowl project state");
    expect(fs.existsSync(oldProj.projectStateDir)).toBe(false);
    const newRepoId = await computeRepoId(newDir);
    expect(
      fs.readFileSync(
        path.join(ensureProjectNyxowlDirs(newRepoId, nyxowlHome).projectStateDir, "marker.txt"),
        "utf8",
      ),
    ).toBe("moved\n");

    const uninstall = await runCli(["uninstall"], { nyxowlHome, cwd: projectDir });
    expect(uninstall.exitCode).toBe(0);
    expect(uninstall.stdout).toContain("Purged ~/.nyxowl: no");
    expect(fs.existsSync(nyxowlHome)).toBe(true);
    expect(fs.existsSync(agentsPath)).toBe(false);
  });

  it("doctor reports missing hosts, version drift, and unavailable test-writer", async () => {
    const noHost = await runCli(["doctor"], {
      nyxowlHome,
      cwd: projectDir,
      envPath: "/usr/bin:/bin",
      installTestWriter: false,
    });
    expect(noHost.exitCode).toBe(0);
    expect(noHost.stdout).toContain("not found");
    expect(noHost.stdout).toContain("Detected host: none on PATH");
    expect(noHost.stdout).toContain("OpenCode: none");

    createFakeHostBin(fakeBinDir, "opencode", "3.0.0");
    const drift = await runCli(["doctor"], {
      nyxowlHome,
      cwd: projectDir,
      envPath: envPathWithFakeHosts,
      installTestWriter: false,
    });
    expect(drift.exitCode).toBe(0);
    expect(drift.stdout).toContain("INSTALLED at");
    expect(drift.stdout).toContain("[WARN: OpenCode v3.0.0");

    const unavailable = await runCli(["doctor"], {
      nyxowlHome: path.join(tmpRoot, "home-unavailable"),
      cwd: projectDir,
      envPath: envPathWithFakeHosts,
      installTestWriter: true,
      testWriterSourceDir: path.join(tmpRoot, "missing-tw-source"),
    });
    expect(unavailable.exitCode).toBe(0);
    expect(unavailable.stdout).toContain("Test-Writer: unavailable");
  });

  it("preflight rejects old or missing git and unsupported Node", async () => {
    const oldGit = createFakeGit(path.join(tmpRoot, "git-old"), "git version 2.20.0");
    expect(oldGit).toContain("git-old");
    await expect(runPreflightChecks({ envPath: path.dirname(oldGit) })).rejects.toThrow(
      /git >= 2.30.0/,
    );

    const brokenGit = createFakeGit(path.join(tmpRoot, "git-broken"), "", 1);
    await expect(runPreflightChecks({ envPath: path.dirname(brokenGit) })).rejects.toThrow(
      /git \(>= 2.30\)/,
    );

    const unknownGit = createFakeGit(path.join(tmpRoot, "git-unknown"), "git version unknown");
    const unknown = await runPreflightChecks({ envPath: path.dirname(unknownGit) });
    expect(unknown.gitVersion).toBe("2.30.0");

    await expect(runPreflightChecks({ nodeVersion: "22.12.0" })).rejects.toThrow(
      /Node.js >= 22.13.0/,
    );

    const setup = await ensureFirstRunSetup({
      nyxowlHome,
      envPath: envPathWithFakeHosts,
      installTestWriter: false,
    });
    expect(setup.firstRunOrUpgraded).toBe(true);
    expect(setup.testWriter.status).toBe("disabled");
  });

  it("dispatches hook subcommands and rejects unknown hooks", async () => {
    const guard = await runCli(["hook", "guard"], {
      stdinText: JSON.stringify({
        agent_name: "nyxowl",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      }),
    });
    expect(guard.exitCode).toBe(0);
    expect(JSON.parse(guard.stdout).permissionDecision).toBe("deny");

    const editGuard = await runCli(["hook", "edit-guard"], {
      stdinText: JSON.stringify({
        agent_name: "nyxowl",
        tool_name: "Edit",
        tool_input: { file_path: path.join(projectDir, "src/x.ts") },
        cwd: projectDir,
      }),
    });
    expect(JSON.parse(editGuard.stdout).permissionDecision).toBe("deny");

    const sessionStart = await runCli(["hook", "session-start"], {
      stdinText: JSON.stringify({ agent_name: "nyxowl", cwd: projectDir }),
    });
    expect(sessionStart.exitCode).toBe(0);
    expect(sessionStart.stdout).toContain("additionalContext");

    const preCompact = await runCli(["hook", "pre-compact"], {
      stdinText: JSON.stringify({ agent_name: "nyxowl", cwd: projectDir }),
    });
    expect(JSON.parse(preCompact.stdout).hookSpecificOutput.hookEventName).toBe("PreCompact");

    const empty = await runCli(["hook", "guard"], { stdinText: "" });
    expect(empty).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const unknown = await runCli(["hook", "nope"], { stdinText: "" });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toBe("Unknown hook subcommand: nope\n");
  });

  it("parses default launch flags and dry-runs OpenCode", async () => {
    createFakeHostBin(fakeBinDir, "opencode", "2.2.5");

    const withDirty = await runCli([projectDir, "--include-dirty"], {
      nyxowlHome,
      envPath: envPathWithFakeHosts,
      cwd: projectDir,
      dryRunLaunch: true,
      installTestWriter: false,
    });
    expect(withDirty.exitCode).toBe(0);
    expect(withDirty.stdout).toContain("Launched OpenCode (Tier A)");
    expect(withDirty.stdout).toContain("[git-repo]");

    const withHost = await runCli(["--host", "opencode", projectDir], {
      nyxowlHome,
      envPath: envPathWithFakeHosts,
      cwd: projectDir,
      dryRunLaunch: true,
      installTestWriter: false,
    });
    expect(withHost.exitCode).toBe(0);
    expect(withHost.stdout).toContain("Launched OpenCode");
  });

  it("resolves the default Nyxowl home from the environment", async () => {
    const version = await runCli(["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toContain("nyxowl v");
  });
});

describe("Campaign C — install manifest branch coverage", () => {
  let tmpRoot: string;
  let home: string;
  let userDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-manifest-coverage-"));
    home = path.join(tmpRoot, "home");
    userDir = path.join(tmpRoot, "user-files");
    fs.mkdirSync(userDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("loads missing/corrupt manifests and updates entries while preserving backups", () => {
    expect(loadInstallManifest(home).entries).toEqual([]);

    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "install-manifest.json"), "{not-json");
    expect(loadInstallManifest(home).entries).toEqual([]);

    const target = path.join(userDir, "tracked.txt");
    recordManifestEntry(
      { targetPath: target, kind: "created-file", writtenSha256: "one" },
      home,
    );
    recordManifestEntry(
      {
        targetPath: target,
        kind: "modified-file",
        backupPath: path.join(tmpRoot, "backup.bak"),
        originalSha256: "orig",
        writtenSha256: "two",
      },
      home,
    );
    recordManifestEntry(
      { targetPath: target, kind: "modified-file", writtenSha256: "three" },
      home,
    );

    const entries = loadInstallManifest(home).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("modified-file");
    expect(entries[0]?.backupPath).toBe(path.join(tmpRoot, "backup.bak"));
    expect(entries[0]?.originalSha256).toBe("orig");
    expect(entries[0]?.writtenSha256).toBe("three");
  });

  it("writes tracked files with backups, idempotency, mode, host, and inside-home exclusion", () => {
    const target = path.join(userDir, "config.txt");
    writeTrackedFile({
      targetPath: target,
      content: "v1\n",
      host: "opencode",
      nyxowlHome: home,
      mode: 0o600,
    });
    expect(fs.readFileSync(target, "utf8")).toBe("v1\n");
    let entry = loadInstallManifest(home).entries.find((e) => e.targetPath === target);
    expect(entry?.kind).toBe("created-file");
    expect(entry?.host).toBe("opencode");

    writeTrackedFile({ targetPath: target, content: "v2\n", nyxowlHome: home });
    entry = loadInstallManifest(home).entries.find((e) => e.targetPath === target);
    expect(entry?.kind).toBe("modified-file");
    const firstBackup = entry?.backupPath;
    expect(firstBackup && fs.existsSync(firstBackup)).toBe(true);
    expect(firstBackup && fs.readFileSync(firstBackup, "utf8")).toBe("v1\n");

    // Second modification must reuse the original backup rather than re-backup v2.
    writeTrackedFile({ targetPath: target, content: "v3\n", nyxowlHome: home });
    const reused = loadInstallManifest(home).entries.find((e) => e.targetPath === target);
    expect(reused?.backupPath).toBe(firstBackup);
    expect(firstBackup && fs.readFileSync(firstBackup, "utf8")).toBe("v1\n");

    // Identical content is a no-op.
    writeTrackedFile({ targetPath: target, content: "v3\n", nyxowlHome: home });
    expect(fs.readFileSync(target, "utf8")).toBe("v3\n");

    // Files inside the Nyxowl home are never recorded in the user manifest.
    const inside = path.join(home, "inside.txt");
    writeTrackedFile({ targetPath: inside, content: "inside\n", nyxowlHome: home });
    expect(fs.existsSync(inside)).toBe(true);
    expect(loadInstallManifest(home).entries.some((e) => e.targetPath === inside)).toBe(false);
  });

  it("upserts managed blocks: insert, replace, idempotent, marker-wrapped body, and inside home", () => {
    const target = path.join(userDir, "AGENTS.md");
    fs.writeFileSync(target, "user content without newline");
    upsertManagedBlockFile({
      targetPath: target,
      blockBody: "first block",
      host: "opencode",
      nyxowlHome: home,
    });
    const inserted = fs.readFileSync(target, "utf8");
    expect(inserted.startsWith("user content without newline")).toBe(true);
    expect(inserted).toContain("first block");
    expect(inserted).toContain(MANAGED_BEGIN);

    // Idempotent call does not change the file.
    upsertManagedBlockFile({
      targetPath: target,
      blockBody: "first block",
      nyxowlHome: home,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(inserted);

    // Replace an existing managed block.
    upsertManagedBlockFile({
      targetPath: target,
      blockBody: "second block",
      nyxowlHome: home,
    });
    const replaced = fs.readFileSync(target, "utf8");
    expect(replaced).toContain("second block");
    expect(replaced).not.toContain("first block");

    // A block body that already has markers is used verbatim.
    upsertManagedBlockFile({
      targetPath: target,
      blockBody: `${MANAGED_BEGIN}\nraw body\n${MANAGED_END}`,
      nyxowlHome: home,
    });
    expect(fs.readFileSync(target, "utf8")).toContain("raw body");

    const created = path.join(userDir, "NEW.md");
    upsertManagedBlockFile({
      targetPath: created,
      blockBody: "new file",
      host: "opencode",
      nyxowlHome: home,
    });
    expect(fs.readFileSync(created, "utf8")).toContain("new file");
    expect(loadInstallManifest(home).entries.some((e) => e.targetPath === created)).toBe(true);

    const inside = path.join(home, "inside.md");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(inside, "inside user\n");
    upsertManagedBlockFile({ targetPath: inside, blockBody: "inside block", nyxowlHome: home });
    expect(fs.readFileSync(inside, "utf8")).toContain("inside block");
    expect(loadInstallManifest(home).entries.some((e) => e.targetPath === inside)).toBe(false);
  });

  it("upserts JSONC properties for new, existing, idempotent, and inside-home files", () => {
    const target = path.join(userDir, "opencode.json");
    upsertJsoncPropertyFile({
      targetPath: target,
      jsonPath: ["mcpServers", "nyxowl"],
      value: { command: ["nyxowl", "mcp"] },
      host: "opencode",
      nyxowlHome: home,
    });
    const created = JSON.parse(fs.readFileSync(target, "utf8")) as {
      mcpServers: { nyxowl: { command: string[] } };
    };
    expect(created.mcpServers.nyxowl.command).toEqual(["nyxowl", "mcp"]);
    expect(
      loadInstallManifest(home).entries.find((e) => e.targetPath === target)?.kind,
    ).toBe("created-file");

    fs.writeFileSync(
      target,
      '{\n  // keep me\n  "mcpServers": {\n    "other": { "x": 1 }\n  }\n}\n',
    );
    upsertJsoncPropertyFile({
      targetPath: target,
      jsonPath: ["mcpServers", "nyxowl"],
      value: { command: ["nyxowl", "mcp"] },
      host: "opencode",
      nyxowlHome: home,
    });
    const modifiedText = fs.readFileSync(target, "utf8");
    expect(modifiedText).toContain("// keep me");
    expect(modifiedText).toContain('"nyxowl"');
    const modifiedEntry = loadInstallManifest(home).entries.find(
      (e) => e.targetPath === target,
    );
    expect(modifiedEntry?.kind).toBe("modified-file");
    expect(modifiedEntry?.backupPath && fs.existsSync(modifiedEntry.backupPath)).toBe(true);

    // Identical value is an idempotent no-op.
    upsertJsoncPropertyFile({
      targetPath: target,
      jsonPath: ["mcpServers", "nyxowl"],
      value: { command: ["nyxowl", "mcp"] },
      nyxowlHome: home,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(modifiedText);

    const inside = path.join(home, "inside.json");
    upsertJsoncPropertyFile({
      targetPath: inside,
      jsonPath: ["mcpServers", "nyxowl"],
      value: { command: ["x"] },
      nyxowlHome: home,
    });
    expect(fs.existsSync(inside)).toBe(true);
    expect(loadInstallManifest(home).entries.some((e) => e.targetPath === inside)).toBe(false);
  });

  it("upserts TOML sections for new, existing, scalar-section, idempotent, and inside-home files", () => {
    const target = path.join(userDir, "config.toml");
    upsertTomlSectionFile({
      targetPath: target,
      sectionKey: "mcp",
      subKey: "nyxowl",
      value: { command: "nyxowl" },
      host: "opencode",
      nyxowlHome: home,
    });
    expect(fs.readFileSync(target, "utf8")).toContain("[mcp.nyxowl]");
    expect(
      loadInstallManifest(home).entries.find((e) => e.targetPath === target)?.kind,
    ).toBe("created-file");

    fs.writeFileSync(target, '[other]\nvalue = 1\n');
    upsertTomlSectionFile({
      targetPath: target,
      sectionKey: "mcp",
      subKey: "nyxowl",
      value: { command: "nyxowl" },
      host: "opencode",
      nyxowlHome: home,
    });
    const modified = fs.readFileSync(target, "utf8");
    expect(modified).toContain("[other]");
    expect(modified).toContain("[mcp.nyxowl]");
    const modifiedEntry = loadInstallManifest(home).entries.find(
      (e) => e.targetPath === target,
    );
    expect(modifiedEntry?.kind).toBe("modified-file");
    expect(modifiedEntry?.backupPath && fs.existsSync(modifiedEntry.backupPath)).toBe(true);

    // Same value is idempotent.
    upsertTomlSectionFile({
      targetPath: target,
      sectionKey: "mcp",
      subKey: "nyxowl",
      value: { command: "nyxowl" },
      nyxowlHome: home,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(modified);

    // A non-object section is replaced with an object.
    fs.writeFileSync(target, 'mcp = "scalar"\n');
    upsertTomlSectionFile({
      targetPath: target,
      sectionKey: "mcp",
      subKey: "nyxowl",
      value: { command: "nyxowl" },
      nyxowlHome: home,
    });
    expect(fs.readFileSync(target, "utf8")).toContain("[mcp.nyxowl]");

    const inside = path.join(home, "inside.toml");
    upsertTomlSectionFile({
      targetPath: inside,
      sectionKey: "mcp",
      subKey: "nyxowl",
      value: { command: "x" },
      nyxowlHome: home,
    });
    expect(fs.existsSync(inside)).toBe(true);
    expect(loadInstallManifest(home).entries.some((e) => e.targetPath === inside)).toBe(false);
  });

  it("uninstalls created, modified, missing, block-stripped, JSON-cleaned, and user-edited files", () => {
    const createdFile = path.join(userDir, "created.txt");
    fs.writeFileSync(createdFile, "created\n");
    recordManifestEntry(
      { targetPath: createdFile, kind: "created-file", writtenSha256: sha256("created\n") },
      home,
    );

    const createdDir = path.join(userDir, "created-dir");
    fs.mkdirSync(createdDir, { recursive: true });
    fs.writeFileSync(path.join(createdDir, "x.txt"), "x\n");
    recordManifestEntry({ targetPath: createdDir, kind: "created-dir" }, home);

    const missing = path.join(userDir, "missing.txt");
    recordManifestEntry(
      { targetPath: missing, kind: "created-file", writtenSha256: sha256("gone") },
      home,
    );

    const backup = path.join(tmpRoot, "restore.bak");
    fs.writeFileSync(backup, "original\n");
    const restoreTarget = path.join(userDir, "restore.txt");
    fs.writeFileSync(restoreTarget, "nyxowl-written\n");
    recordManifestEntry(
      {
        targetPath: restoreTarget,
        kind: "modified-file",
        backupPath: backup,
        originalSha256: sha256("original\n"),
        writtenSha256: sha256("nyxowl-written\n"),
      },
      home,
    );

    const blockTarget = path.join(userDir, "block.md");
    fs.writeFileSync(
      blockTarget,
      `user keep\n${MANAGED_BEGIN}\nold block\n${MANAGED_END}\ntail\n`,
    );
    recordManifestEntry(
      {
        targetPath: blockTarget,
        kind: "modified-file",
        writtenSha256: sha256("nyxowl version"),
      },
      home,
    );

    const jsonTarget = path.join(userDir, "config.json");
    fs.writeFileSync(
      jsonTarget,
      '{"mcpServers":{"nyxowl":{"command":["x"]},"other":{"y":1}},"keep":true}\n',
    );
    recordManifestEntry(
      {
        targetPath: jsonTarget,
        kind: "modified-file",
        writtenSha256: sha256("nyxowl json"),
      },
      home,
    );

    const plainTarget = path.join(userDir, "plain.txt");
    fs.writeFileSync(plainTarget, "user edited\n");
    recordManifestEntry(
      {
        targetPath: plainTarget,
        kind: "modified-file",
        writtenSha256: sha256("nyxowl plain"),
      },
      home,
    );

    const result = uninstallFromManifest({ nyxowlHome: home });
    expect(result.purgedHome).toBe(false);
    expect(result.deletedFiles).toContain(createdFile);
    expect(result.deletedFiles).toContain(createdDir);
    expect(result.restoredFiles).toContain(restoreTarget);
    expect(result.restoredFiles).toContain(blockTarget);
    expect(result.restoredFiles).toContain(jsonTarget);
    expect(result.skippedUserEditedFiles).toContain(plainTarget);

    expect(fs.existsSync(createdFile)).toBe(false);
    expect(fs.existsSync(createdDir)).toBe(false);
    expect(fs.readFileSync(restoreTarget, "utf8")).toBe("original\n");
    const stripped = fs.readFileSync(blockTarget, "utf8");
    expect(stripped).not.toContain(MANAGED_BEGIN);
    expect(stripped).toContain("user keep");
    const cleaned = JSON.parse(fs.readFileSync(jsonTarget, "utf8")) as {
      mcpServers?: { nyxowl?: unknown; other?: unknown };
      keep: boolean;
    };
    expect(cleaned.mcpServers?.nyxowl).toBeUndefined();
    expect(cleaned.mcpServers?.other).toEqual({ y: 1 });
    expect(cleaned.keep).toBe(true);
    expect(fs.readFileSync(plainTarget, "utf8")).toBe("user edited\n");
    expect(loadInstallManifest(home).entries).toEqual([]);
  });
});

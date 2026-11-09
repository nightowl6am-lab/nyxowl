#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_NYXOWL_CONFIG } from "../core/config.ts";
import { computeRepoId, computeTempIndexTreeHash, resolveGitCommonDir } from "../core/git.ts";
import { resolveGlobalNyxowlPaths, resolveProjectNyxowlPaths } from "../core/paths.ts";
import { ensureReceiptKey, type ReceiptPayload, verifyReceiptHmac } from "../core/receipts.ts";
import { openProjectDb } from "../mcp/db/sqlite.ts";
import { startStdioMcpServer } from "../mcp/server.ts";
import { buildProjectAgentsBlock } from "./compiler.ts";
import { type HostId } from "./detect-hosts.ts";
import { runEditGuardCli } from "./hooks/edit-guard.ts";
import { runGuardCli } from "./hooks/guard.ts";
import { runPreCompactCli } from "./hooks/pre-compact.ts";
import { buildHydrateDigestForHook, runSessionStartCli } from "./hooks/session-start.ts";
import { launchNyxowlSession } from "./launcher.ts";
import { uninstallFromManifest, upsertManagedBlockFile } from "./manifest.ts";
import { runMcpSmoke } from "./mcp-smoke.ts";
import { ensureFirstRunSetup, NYXOWL_VERSION } from "./setup.ts";
import {
  ensureTestWriterRuntime,
  testWriterRoot,
  testWriterStatus,
} from "./testwriter.ts";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCli(
  argv: string[],
  options?: {
    nyxowlHome?: string;
    envPath?: string;
    cwd?: string;
    dryRunLaunch?: boolean;
    stdinText?: string;
    testWriterSourceDir?: string;
    installTestWriter?: boolean;
  },
): Promise<CliResult> {
  const cwd = options?.cwd ?? process.cwd();
  const nyxowlHome = options?.nyxowlHome ?? process.env["NYXOWL_HOME"];
  const installTestWriter =
    options?.installTestWriter ?? (process.env["NYXOWL_TESTWRITER_INSTALL"] !== "0");
  const args = [...argv];

  if (args.includes("--version") || args.includes("-v")) {
    return { exitCode: 0, stdout: `nyxowl v${NYXOWL_VERSION}\n`, stderr: "" };
  }

  if (args.includes("--help") || args.includes("-h")) {
    const help = [
      `nyxowl v${NYXOWL_VERSION} — Principal Tech Lead, 10 Subagents & 8-Engine Runtime MCP`,
      "",
      "Usage:",
      "  nyxowl [path] [--host opencode] [--include-dirty]   Setup (if first run) and launch an OpenCode session",
      "  nyxowl doctor                                   Verify runtimes, OpenCode status, skill packages, and MCP server",
      "  nyxowl status [path]                            Show worktrees, slices, strikes, locks, receipts",
      "  nyxowl handoff [path]                           Print latest task handoff & hydrate digest",
      "  nyxowl worktree list|prune|remove [<slug>]      Manage isolated Nyxowl worktrees",
      "  nyxowl receipts verify [<id>]                   Verify receipt HMACs and working-tree bindings",
      "  nyxowl testwriter install|status                Install or inspect the rootless Test-Writer runtime",
      "  nyxowl github connect                           Configure optional Mode A GitHub App credentials",
      "  nyxowl init --project                            Write optional committable project config",
      "  nyxowl relink <old-path> <new-path>             Migrate state after moving a repository",
      "  nyxowl uninstall [--purge] [--yes]              Restore user configs and remove Nyxowl files",
      "  nyxowl mcp                                      Start stdio MCP server",
      "  nyxowl hook <guard|edit-guard|session-start|pre-compact>",
      "",
    ].join("\n");
    return { exitCode: 0, stdout: help, stderr: "" };
  }

  const sub = args[0];

  // 1. nyxowl mcp
  if (sub === "mcp") {
    await startStdioMcpServer({
      defaultProjectPath: process.env["NYXOWL_PROJECT"] ?? cwd,
      ...(nyxowlHome ? { nyxHome: nyxowlHome } : {}),
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  // 2. nyxowl hook <subcommand>
  if (sub === "hook") {
    const hookSub = args[1];
    if (hookSub === "guard") {
      const res = await runGuardCli(options?.stdinText);
      return { exitCode: res.exitCode, stdout: res.stdout ? `${res.stdout}\n` : "", stderr: "" };
    }
    if (hookSub === "edit-guard") {
      const res = await runEditGuardCli(options?.stdinText);
      return { exitCode: res.exitCode, stdout: res.stdout ? `${res.stdout}\n` : "", stderr: "" };
    }
    if (hookSub === "session-start") {
      const res = await runSessionStartCli(options?.stdinText);
      return { exitCode: res.exitCode, stdout: res.stdout ? `${res.stdout}\n` : "", stderr: "" };
    }
    if (hookSub === "pre-compact") {
      const res = await runPreCompactCli(options?.stdinText);
      return { exitCode: res.exitCode, stdout: res.stdout ? `${res.stdout}\n` : "", stderr: "" };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown hook subcommand: ${hookSub ?? "(none)"}\n`,
    };
  }

  // 3. nyxowl testwriter install|status
  if (sub === "testwriter") {
    const action = args[1];
    const root = testWriterRoot(nyxowlHome);
    if (action === "status") {
      const status = testWriterStatus(root, options?.testWriterSourceDir);
      const readyWrappers = status.wrappers.filter((wrapper) => wrapper.executable).length;
      const lines = [
        `Test-Writer: ${status.ready ? "ready" : "not ready"} at ${status.root}`,
        `  Wrappers: ${readyWrappers}/${status.wrappers.length} executable`,
        `  Venv: ${status.venv.ready ? "ready" : "missing"} (${status.venv.python})`,
        `  Store: ${status.store}`,
        `  Source: ${status.source || "(not found)"}`,
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    if (action === "install") {
      const result = await ensureTestWriterRuntime({
        ...(nyxowlHome ? { nyxowlHome } : {}),
        ...(options?.testWriterSourceDir ? { sourceDir: options.testWriterSourceDir } : {}),
        ...(options?.envPath ? { envPath: options.envPath } : {}),
        force: args.includes("--force"),
        // An explicit `testwriter install` overrides the env opt-out unless the
        // caller passed installTestWriter:false (automatic setup path).
        install: options?.installTestWriter ?? true,
      });
      const ok = result.status === "installed" || result.status === "already-installed";
      const lines = [
        result.status === "installed"
          ? `Test-Writer: installed at ${result.root}`
          : result.status === "already-installed"
            ? `Test-Writer: ready at ${result.root}`
            : result.message,
        ...result.lines,
      ];
      return {
        exitCode: ok ? 0 : 1,
        stdout: `${lines.join("\n")}\n`,
        stderr: ok ? "" : `${result.message}\n`,
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Usage: nyxowl testwriter install|status\n`,
    };
  }

  // 4. nyxowl doctor
  if (sub === "doctor") {
    const setupRes = await ensureFirstRunSetup({
      ...(nyxowlHome ? { nyxowlHome } : {}),
      ...(options?.envPath ? { envPath: options.envPath } : {}),
      ...(options?.testWriterSourceDir ? { testWriterSourceDir: options.testWriterSourceDir } : {}),
      installTestWriter,
    });
    const smoke = await runMcpSmoke();
    const smokeLine = smoke.ok
      ? `MCP Smoke Test: OK (${smoke.message})`
      : `MCP Smoke Test: FAIL (${smoke.message})`;
    const lines = [
      ...setupRes.summaryLines,
      "OpenCode Status:",
      ...setupRes.detectedHosts.map(
        (h) =>
          `  - ${h.id} (${h.displayName}): ${
            h.installed
              ? `INSTALLED at ${h.binaryPath} (v${h.detectedVersion ?? "unknown"}, Tier ${h.tier})`
              : "not found"
          }${h.versionDriftWarning ? ` [WARN: ${h.versionDriftWarning}]` : ""}`,
      ),
      smokeLine,
    ];
    return {
      exitCode: smoke.ok ? 0 : 1,
      stdout: `${lines.join("\n")}\n`,
      stderr: smoke.ok ? "" : `${smoke.message}\n`,
    };
  }

  // 4. nyxowl status [path]
  if (sub === "status") {
    const targetPath = path.resolve(cwd, args[1] ?? ".");
    const commonDir = await resolveGitCommonDir(targetPath);
    const repoId = await computeRepoId(targetPath, commonDir);
    const projPaths = resolveProjectNyxowlPaths(repoId, nyxowlHome);

    if (!fs.existsSync(projPaths.stateDbFile)) {
      return {
        exitCode: 0,
        stdout: `Nyxowl Status (${targetPath}): No active state (repo-id=${repoId}).\n`,
        stderr: "",
      };
    }

    const db = openProjectDb(projPaths.stateDbFile);
    try {
      const worktrees = db.db
        .prepare("SELECT task_slug AS slug, branch, worktree_path, status FROM worktrees ORDER BY updated_at DESC")
        .all() as Array<{ slug: string; branch: string; worktree_path: string; status: string }>;
      const slices = db.db
        .prepare("SELECT slice_id, label, tree_hash FROM slices ORDER BY seq DESC LIMIT 5")
        .all() as Array<{ slice_id: string; label: string; tree_hash: string }>;
      const receipts = db.db
        .prepare("SELECT id, kind, status, branch, tree_hash FROM receipts ORDER BY created_at DESC LIMIT 10")
        .all() as Array<{ id: string; kind: string; status: string; branch: string; tree_hash: string }>;
      const locks = db.db
        .prepare("SELECT file_path, owner_role, expires_at FROM locks WHERE expires_at > ?")
        .all(Math.floor(Date.now() / 1000)) as Array<{
        file_path: string;
        owner_role: string;
        expires_at: number;
      }>;

      const out = [
        `Nyxowl Status — ${targetPath} (repo-id: ${repoId})`,
        `Worktrees (${worktrees.length}): ${worktrees.map((w) => `${w.slug}[${w.status}]`).join(", ") || "none"}`,
        `Recent Slices (${slices.length}): ${slices.map((s) => `${s.slice_id}(${s.label})`).join(", ") || "none"}`,
        `Active Locks (${locks.length}): ${locks.map((l) => `${l.file_path}:${l.owner_role}`).join(", ") || "none"}`,
        `Receipts (${receipts.length}): ${receipts.map((r) => `${r.kind}=${r.status}`).join(", ") || "none"}`,
      ].join("\n");
      return { exitCode: 0, stdout: `${out}\n`, stderr: "" };
    } finally {
      db.close();
    }
  }

  // 5. nyxowl handoff [path]
  if (sub === "handoff") {
    const targetPath = path.resolve(cwd, args[1] ?? ".");
    const digest = buildHydrateDigestForHook(targetPath, nyxowlHome);
    return { exitCode: 0, stdout: `${digest}\n`, stderr: "" };
  }

  // 6. nyxowl worktree list|prune|remove [<slug>]
  if (sub === "worktree") {
    const action = args[1] ?? "list";
    const commonDir = await resolveGitCommonDir(cwd);
    const repoId = await computeRepoId(cwd, commonDir);
    const projPaths = resolveProjectNyxowlPaths(repoId, nyxowlHome);
    if (!fs.existsSync(projPaths.stateDbFile)) {
      return { exitCode: 0, stdout: "No worktrees recorded.\n", stderr: "" };
    }
    const db = openProjectDb(projPaths.stateDbFile);
    try {
      if (action === "list" || action === "prune") {
        const rows = db.db
          .prepare("SELECT task_slug AS slug, branch, worktree_path, status FROM worktrees")
          .all() as Array<{ slug: string; branch: string; worktree_path: string; status: string }>;
        const lines = rows.map(
          (r) => `${r.slug}\t${r.branch}\t${r.status}\t${r.worktree_path}`,
        );
        return {
          exitCode: 0,
          stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "No worktrees.\n",
          stderr: "",
        };
      }
      if (action === "remove") {
        const slug = args[2];
        if (!slug) {
          return { exitCode: 1, stdout: "", stderr: "Usage: nyxowl worktree remove <slug>\n" };
        }
        db.withWriteTransaction((conn) => {
          conn
            .prepare("UPDATE worktrees SET status = 'removed' WHERE task_slug = ?")
            .run(slug);
        });
        return { exitCode: 0, stdout: `Removed worktree record for ${slug}.\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `Unknown worktree action: ${action}\n` };
    } finally {
      db.close();
    }
  }

  // 7. nyxowl receipts verify [<id>]
  if (sub === "receipts" && args[1] === "verify") {
    const receiptId = args[2];
    const commonDir = await resolveGitCommonDir(cwd);
    const repoId = await computeRepoId(cwd, commonDir);
    const projPaths = resolveProjectNyxowlPaths(repoId, nyxowlHome);

    if (!fs.existsSync(projPaths.stateDbFile)) {
      return { exitCode: 1, stdout: "", stderr: "No project state database found.\n" };
    }

    const key = ensureReceiptKey(nyxowlHome);
    const db = openProjectDb(projPaths.stateDbFile);
    try {
      const rows = (receiptId
        ? db.db.prepare("SELECT * FROM receipts WHERE id = ?").all(receiptId)
        : db.db.prepare("SELECT * FROM receipts ORDER BY created_at DESC").all()) as Array<{
        id: string;
        kind: "verify" | "seam" | "slop" | "exploit";
        status: "GREEN" | "RED" | "NA";
        coverage: "full" | "partial" | "none" | null;
        worktree: string;
        branch: string;
        tree_hash: string;
        base_sha: string;
        commands_hash: string;
        evidence_artifact_id: string | null;
        na_justification: string | null;
        created_at: string;
        hmac: string;
      }>;

      if (rows.length === 0) {
        return { exitCode: 1, stdout: "", stderr: "No matching receipts found.\n" };
      }

      const failures: string[] = [];
      for (const row of rows) {
        const payload: ReceiptPayload = {
          id: row.id,
          kind: row.kind,
          status: row.status,
          ...(row.coverage ? { coverage: row.coverage } : {}),
          worktree: row.worktree,
          branch: row.branch,
          treeHash: row.tree_hash,
          baseSha: row.base_sha,
          commandsHash: row.commands_hash,
          evidenceArtifactId: row.evidence_artifact_id,
          ...(row.na_justification ? { naJustification: row.na_justification } : {}),
          createdAt: row.created_at,
        };
        const hmacOk = verifyReceiptHmac(key, payload, row.hmac);
        if (!hmacOk) {
          failures.push(`Receipt ${row.id} (${row.kind}): INVALID HMAC (tampered or forged)`);
          continue;
        }
        if (fs.existsSync(row.worktree)) {
          try {
            const currentTree = await computeTempIndexTreeHash(row.worktree);
            if (currentTree !== row.tree_hash) {
              failures.push(
                `Receipt ${row.id} (${row.kind}): STALE TREE (expected ${row.tree_hash}, current ${currentTree})`,
              );
            }
          } catch {
            // Worktree may no longer be a git dir
          }
        }
      }

      if (failures.length > 0) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Receipt verification failed:\n${failures.join("\n")}\n`,
        };
      }
      return {
        exitCode: 0,
        stdout: `Verified ${rows.length} receipt(s): all HMAC signatures and tree bindings valid.\n`,
        stderr: "",
      };
    } finally {
      db.close();
    }
  }

  // 8. nyxowl github connect
  if (sub === "github" && args[1] === "connect") {
    const globalPaths = resolveGlobalNyxowlPaths(nyxowlHome);
    const appDir = path.join(globalPaths.secretsDir, "github-app");
    fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
    return {
      exitCode: 0,
      stdout: [
        "Nyxowl GitHub Integration:",
        "  - Mode B (Zero-Config Default): Uses your authenticated `gh` CLI automatically with Co-authored-by attribution.",
        `  - Mode A (Optional Dedicated GitHub App): Place your GitHub App credentials (app-id, installation-id, private-key.pem) in ${appDir} (0700).`,
        "",
      ].join("\n"),
      stderr: "",
    };
  }

  // 9. nyxowl init --project
  if (sub === "init" && args.includes("--project")) {
    const cfgDir = path.join(cwd, ".nyxowl");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, "config.json");
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, `${JSON.stringify(DEFAULT_NYXOWL_CONFIG, null, 2)}\n`, "utf8");
    }
    upsertManagedBlockFile({
      targetPath: path.join(cwd, "AGENTS.md"),
      blockBody: buildProjectAgentsBlock(),
      ...(nyxowlHome ? { nyxowlHome } : {}),
    });
    return {
      exitCode: 0,
      stdout: `Initialized optional committable project config at ${cfgPath} and AGENTS.md managed block.\n`,
      stderr: "",
    };
  }

  // 10. nyxowl relink <old> <new>
  if (sub === "relink") {
    const oldPath = args[1];
    const newPath = args[2];
    if (!oldPath || !newPath) {
      return { exitCode: 1, stdout: "", stderr: "Usage: nyxowl relink <old-path> <new-path>\n" };
    }
    const oldRepoId = await computeRepoId(path.resolve(cwd, oldPath));
    const newCommonDir = await resolveGitCommonDir(path.resolve(cwd, newPath));
    const newRepoId = await computeRepoId(path.resolve(cwd, newPath), newCommonDir);
    const oldProj = resolveProjectNyxowlPaths(oldRepoId, nyxowlHome);
    const newProj = resolveProjectNyxowlPaths(newRepoId, nyxowlHome);

    if (fs.existsSync(oldProj.projectStateDir) && oldProj.projectStateDir !== newProj.projectStateDir) {
      fs.mkdirSync(path.dirname(newProj.projectStateDir), { recursive: true, mode: 0o700 });
      fs.cpSync(oldProj.projectStateDir, newProj.projectStateDir, { recursive: true });
      fs.rmSync(oldProj.projectStateDir, { recursive: true, force: true });
    }
    return {
      exitCode: 0,
      stdout: `Relinked Nyxowl project state from ${oldRepoId} to ${newRepoId}.\n`,
      stderr: "",
    };
  }

  // 11. nyxowl uninstall [--purge] [--yes]
  if (sub === "uninstall") {
    const purge = args.includes("--purge");
    const res = uninstallFromManifest({
      ...(nyxowlHome ? { nyxowlHome } : {}),
      purge,
    });
    return {
      exitCode: 0,
      stdout: [
        `Nyxowl uninstall complete:`,
        `  - Restored files: ${res.restoredFiles.length}`,
        `  - Deleted files: ${res.deletedFiles.length}`,
        `  - Purged ~/.nyxowl: ${res.purgedHome ? "yes" : "no"}`,
        "",
      ].join("\n"),
      stderr: "",
    };
  }

  // 12. Default command: nyxowl [path] [--host opencode] [--include-dirty]
  let targetPath = cwd;
  let hostOverride: HostId | undefined;
  let includeDirty = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--host" && args[i + 1]) {
      const hostValue = args[i + 1]!;
      if (hostValue !== "opencode") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Unsupported host "${hostValue}". OpenCode is the only supported host.\n`,
        };
      }
      hostOverride = hostValue as HostId;
      i++;
    } else if (arg === "--include-dirty") {
      includeDirty = true;
    } else if (!arg.startsWith("-")) {
      targetPath = path.resolve(cwd, arg);
    }
  }

  const launchRes = await launchNyxowlSession({
    targetPath,
    ...(hostOverride ? { hostOverride } : {}),
    includeDirty,
    ...(nyxowlHome ? { nyxowlHome } : {}),
    ...(options?.envPath ? { envPath: options.envPath } : {}),
    ...(options?.dryRunLaunch !== undefined ? { dryRun: options.dryRunLaunch } : {}),
    installTestWriter,
  });

  return {
    exitCode: launchRes.exitCode,
    stdout: `Launched ${launchRes.selectedHost.displayName} (Tier ${launchRes.selectedHost.tier}) on ${launchRes.projectPath} [${launchRes.classification}]\n`,
    stderr: "",
  };
}

// Execute when invoked directly as CLI binary (including via node_modules/.bin symlink)
function isCliMain(): boolean {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    return fs.realpathSync(arg1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(arg1) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isCliMain()) {
  runCli(process.argv.slice(2))
    .then((res) => {
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exitCode = res.exitCode;
    })
    .catch((err) => {
      process.stderr.write(`Nyxowl CLI error: ${(err as Error).message}\n`);
      process.exitCode = 1;
    });
}

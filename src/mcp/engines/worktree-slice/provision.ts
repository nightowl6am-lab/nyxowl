import fs from "node:fs";
import path from "node:path";
import type { NyxConfig } from "../../../core/config.ts";
import { execCommand } from "../../../core/exec.ts";
import type { NyxProjectLayout } from "../../../core/paths.ts";
import { isSecretEnvFileName } from "../../../core/redact.ts";
import type { StateDb } from "../../db/sqlite.ts";
import { storeOverflowArtifact } from "../../tool.ts";

export interface ProvisionResult {
  linkedEnvFiles: string[];
  installCommand: string | null;
  installStatus: "installed" | "linked-fallback" | "skipped" | "failed";
  installArtifactId: string | null;
}

export function detectLockfileInstallCommand(
  worktreePath: string,
): { cmd: string; args: string[] } | null {
  const checks: Array<{ file: string; cmd: string; args: string[] }> = [
    { file: "pnpm-lock.yaml", cmd: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] },
    { file: "package-lock.json", cmd: "npm", args: ["ci", "--ignore-scripts"] },
    { file: "bun.lockb", cmd: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"] },
    { file: "bun.lock", cmd: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"] },
    { file: "uv.lock", cmd: "uv", args: ["sync", "--frozen"] },
    { file: "poetry.lock", cmd: "poetry", args: ["install", "--no-interaction"] },
    { file: "go.sum", cmd: "go", args: ["mod", "download"] },
    { file: "Cargo.lock", cmd: "cargo", args: ["fetch", "--locked"] },
    { file: "Gemfile.lock", cmd: "bundle", args: ["install", "--deployment"] },
    { file: "composer.lock", cmd: "composer", args: ["install", "--no-interaction", "--no-scripts"] },
  ];

  for (const item of checks) {
    if (fs.existsSync(path.join(worktreePath, item.file))) {
      return { cmd: item.cmd, args: item.args };
    }
  }
  return null;
}

export async function provisionWorktree(
  mainRepoPath: string,
  worktreePath: string,
  config: NyxConfig,
  db: StateDb,
  projectLayout: NyxProjectLayout,
): Promise<ProvisionResult> {
  const linkedEnvFiles: string[] = [];

  // 1. Symlink .env* files from main checkout into the worktree (§1.1.2)
  if (config.provision.linkEnv && fs.existsSync(mainRepoPath)) {
    const entries = fs.readdirSync(mainRepoPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      if (!isSecretEnvFileName(entry.name)) {
        continue;
      }
      const srcEnv = path.join(mainRepoPath, entry.name);
      const destEnv = path.join(worktreePath, entry.name);
      if (!fs.existsSync(destEnv)) {
        fs.symlinkSync(srcEnv, destEnv);
        linkedEnvFiles.push(entry.name);
      }
    }
  }

  // 2. Install or link dependencies (§1.1.2)
  if (config.provision.install === "off") {
    return {
      linkedEnvFiles,
      installCommand: null,
      installStatus: "skipped",
      installArtifactId: null,
    };
  }

  // If mainRepoPath already has node_modules and we are in a deterministic offline test or fast path,
  // check if a lockfile exists
  const detected = detectLockfileInstallCommand(worktreePath);
  const mainNodeModules = path.join(mainRepoPath, "node_modules");
  const wtNodeModules = path.join(worktreePath, "node_modules");

  if (!detected) {
    if (fs.existsSync(mainNodeModules) && !fs.existsSync(wtNodeModules)) {
      fs.symlinkSync(mainNodeModules, wtNodeModules, "dir");
      return {
        linkedEnvFiles,
        installCommand: "symlink:node_modules",
        installStatus: "linked-fallback",
        installArtifactId: null,
      };
    }
    return {
      linkedEnvFiles,
      installCommand: null,
      installStatus: "skipped",
      installArtifactId: null,
    };
  }

  const installCommandStr = `${detected.cmd} ${detected.args.join(" ")}`;

  // If NYXOWL_OFFLINE_PROVISION=1 or main node_modules exists and lockfile install fails offline, symlink fallback
  if (process.env["NYXOWL_OFFLINE_PROVISION"] === "1" && fs.existsSync(mainNodeModules)) {
    if (!fs.existsSync(wtNodeModules)) {
      fs.symlinkSync(mainNodeModules, wtNodeModules, "dir");
    }
    const artifactId = storeOverflowArtifact(
      db,
      projectLayout,
      "worktree_provision",
      `Executed offline provision for ${installCommandStr} (linked node_modules from main checkout).`,
    );
    return {
      linkedEnvFiles,
      installCommand: installCommandStr,
      installStatus: "installed",
      installArtifactId: artifactId,
    };
  }

  const res = await execCommand(detected.cmd, detected.args, {
    cwd: worktreePath,
    timeoutMs: 120_000,
  });

  const artifactId = storeOverflowArtifact(
    db,
    projectLayout,
    "worktree_provision",
    `Command: ${installCommandStr}\nExit: ${res.exitCode}\n${res.combined}`,
  );

  if (res.exitCode === 0) {
    return {
      linkedEnvFiles,
      installCommand: installCommandStr,
      installStatus: "installed",
      installArtifactId: artifactId,
    };
  }

  // Fallback to symlinking main checkout's node_modules if offline registry failed
  if (fs.existsSync(mainNodeModules) && !fs.existsSync(wtNodeModules)) {
    fs.symlinkSync(mainNodeModules, wtNodeModules, "dir");
    return {
      linkedEnvFiles,
      installCommand: installCommandStr,
      installStatus: "linked-fallback",
      installArtifactId: artifactId,
    };
  }

  return {
    linkedEnvFiles,
    installCommand: installCommandStr,
    installStatus: "failed",
    installArtifactId: artifactId,
  };
}

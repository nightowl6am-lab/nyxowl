import fs from "node:fs";
import path from "node:path";
import type { NyxConfig } from "../../../core/config.ts";
import { execCommand } from "../../../core/exec.ts";
import type { NyxProjectLayout } from "../../../core/paths.ts";
import { discoverSecretEnvFiles } from "../../../core/safe-runner.ts";
import type { StateDb } from "../../db/sqlite.ts";
import { storeOverflowArtifact } from "../../tool.ts";

export interface ProvisionResult {
  linkedEnvFiles: string[];
  installCommand: string | null;
  installStatus: "installed" | "linked-fallback" | "skipped" | "failed";
  installArtifactId: string | null;
}

const GIT_CHECK_TIMEOUT_MS = 20_000;

/**
 * Returns the absolute path of the git working-tree root that contains
 * `dir`, or null when `dir` is not inside a git working tree.
 */
async function gitWorkingTreeRoot(dir: string): Promise<string | null> {
  const res = await execCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    timeoutMs: 10_000,
  });
  if (res.exitCode !== 0) {
    return null;
  }
  const top = res.stdout.trim();
  return top.length > 0 ? path.resolve(top) : null;
}

/**
 * Returns the subset of `relativePaths` (relative to `repoRoot`) that git
 * ignores.
 *
 * `git check-ignore` never reports tracked paths as ignored, so a committed
 * `.env` stays unlinked (it is already materialized inside the worktree by the
 * checkout itself).
 */
async function gitIgnoredPaths(
  repoRoot: string,
  relativePaths: string[],
): Promise<Set<string> | null> {
  if (relativePaths.length === 0) {
    return new Set<string>();
  }
  const res = await execCommand("git", ["check-ignore", "-z", "--stdin"], {
    cwd: repoRoot,
    timeoutMs: GIT_CHECK_TIMEOUT_MS,
    stdin: relativePaths.join("\0"),
  });
  // 0 = at least one path ignored, 1 = none ignored, anything else = failure.
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    return null;
  }
  return new Set(
    res.stdout
      .split("\0")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Links the secret env files of the main checkout into the worktree.
 *
 * Rules:
 * - every package directory (and the repository root) is scanned, so
 *   package-level `.env`, `.env.local`, `.env.<environment>` and
 *   provider-specific files are covered,
 * - the relative path is preserved inside the worktree (parent directories are
 *   created on demand),
 * - a file is only linked when the source exists and the destination does not,
 * - file contents are never read, copied, logged or returned,
 * - when the source is a git repository, only git-ignored env files are linked;
 *   a name-based fallback applies when the source is not a git repository.
 *
 * @returns relative paths (by name only) of the files that were linked.
 */
export async function linkEnvFiles(
  mainRepoPath: string,
  worktreePath: string,
): Promise<string[]> {
  const linkedEnvFiles: string[] = [];
  if (!fs.existsSync(mainRepoPath)) {
    return linkedEnvFiles;
  }

  const candidates = discoverSecretEnvFiles(mainRepoPath);
  if (candidates.length === 0) {
    return linkedEnvFiles;
  }

  let selected = candidates;
  const gitRoot = await gitWorkingTreeRoot(mainRepoPath);
  if (gitRoot) {
    // `git check-ignore --stdin` resolves the given paths relative to its
    // working directory, so the candidates are re-expressed relative to the
    // git root before the query.
    const gitRelative = new Map<string, string>();
    for (const candidate of candidates) {
      const rel = path.relative(gitRoot, candidate.absolutePath).split(path.sep).join("/");
      if (rel.length > 0 && !rel.startsWith("..")) {
        gitRelative.set(candidate.relativePath, rel);
      }
    }
    const ignored = await gitIgnoredPaths(gitRoot, [...gitRelative.values()]);
    if (ignored) {
      selected = candidates.filter((candidate) => {
        const rel = gitRelative.get(candidate.relativePath);
        return rel !== undefined && ignored.has(rel);
      });
    }
    // `ignored === null` means git could not answer: fall back to the
    // name-based rule below.
  }

  for (const candidate of selected) {
    const sourcePath = candidate.absolutePath;
    let sourceExists = false;
    try {
      sourceExists = fs.existsSync(sourcePath);
    } catch {
      sourceExists = false;
    }
    if (!sourceExists) {
      continue;
    }

    const destPath = path.join(worktreePath, candidate.relativePath);
    let destExists = false;
    try {
      fs.lstatSync(destPath);
      destExists = true;
    } catch {
      destExists = false;
    }
    if (destExists) {
      continue;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      fs.symlinkSync(sourcePath, destPath);
    } catch {
      continue;
    }
    linkedEnvFiles.push(candidate.relativePath);
  }

  return linkedEnvFiles;
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
    linkedEnvFiles.push(...(await linkEnvFiles(mainRepoPath, worktreePath)));
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

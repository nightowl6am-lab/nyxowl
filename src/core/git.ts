import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execCommand } from "./exec.ts";
import { NyxError } from "./errors.ts";

/**
 * Resolves the git common directory (`git rev-parse --git-common-dir`) if inside a git repo,
 * or returns null when `dir` is not a git repository.
 */
export async function getGitCommonDir(dir: string): Promise<string | null> {
  if (!fs.existsSync(dir)) {
    return null;
  }
  const res = await execCommand("git", ["rev-parse", "--git-common-dir"], {
    cwd: dir,
    timeoutMs: 10_000,
  });
  if (res.exitCode !== 0) {
    return null;
  }
  const raw = res.stdout.trim();
  if (!raw) {
    return null;
  }
  const resolved = path.resolve(dir, raw);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

export const resolveGitCommonDir = getGitCommonDir;

/**
 * Synchronous repo-id resolver for fast <150ms hook execution (inspects `.git` file/directory directly).
 */
export function computeRepoIdSync(projectPath: string, commonDirOverride?: string | null): string {
  const absPath = path.resolve(projectPath);
  const realFolder = fs.existsSync(absPath) ? fs.realpathSync(absPath) : absPath;

  let commonDir: string | null = commonDirOverride ?? null;
  if (!commonDir) {
    // Walk up to find .git directory or worktree .git file
    let cur = realFolder;
    for (let i = 0; i < 10; i++) {
      const dotGit = path.join(cur, ".git");
      if (fs.existsSync(dotGit)) {
        const stat = fs.statSync(dotGit);
        if (stat.isDirectory()) {
          commonDir = fs.realpathSync(dotGit);
        } else if (stat.isFile()) {
          const content = fs.readFileSync(dotGit, "utf8").trim();
          const m = content.match(/^gitdir:\s*(.+)$/m);
          if (m?.[1]) {
            const gitDir = path.resolve(cur, m[1].trim());
            const commonDirFile = path.join(gitDir, "commondir");
            if (fs.existsSync(commonDirFile)) {
              const relCommon = fs.readFileSync(commonDirFile, "utf8").trim();
              const resolvedCommon = path.resolve(gitDir, relCommon);
              commonDir = fs.existsSync(resolvedCommon)
                ? fs.realpathSync(resolvedCommon)
                : resolvedCommon;
            } else {
              commonDir = fs.existsSync(gitDir) ? fs.realpathSync(gitDir) : gitDir;
            }
          }
        }
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  let baseDirForName = realFolder;
  let canonicalTarget = realFolder;
  if (commonDir) {
    canonicalTarget = commonDir;
    if (path.basename(commonDir) === ".git") {
      baseDirForName = path.dirname(commonDir);
    }
  }

  const rawBase = path
    .basename(baseDirForName)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safeBase = rawBase || "repo";
  const hash8 = crypto.createHash("sha256").update(canonicalTarget).digest("hex").slice(0, 8);
  return `${safeBase}-${hash8}`;
}

/**
 * Computes `<basename>-<sha256(realpath(git-common-dir or folder))[:8]>` (§0.3.2).
 * Worktrees and the main checkout of the same repository share the same `git-common-dir`,
 * so they always resolve to the exact same `repo-id`!
 */
export async function computeRepoId(
  projectPath: string,
  commonDirOverride?: string | null,
): Promise<string> {
  const absPath = path.resolve(projectPath);
  const realFolder = fs.existsSync(absPath) ? fs.realpathSync(absPath) : absPath;
  const commonDir =
    commonDirOverride !== undefined ? commonDirOverride : await getGitCommonDir(realFolder);
  return computeRepoIdSync(realFolder, commonDir);
}

export const computeTempIndexTreeHash = computeWorkingTreeHash;

export async function getWorkingTreeStatus(repoPath: string): Promise<{
  clean: boolean;
  dirtyFiles: string[];
}> {
  const dirtyFiles = await getDirtyFiles(repoPath);
  return {
    clean: dirtyFiles.length === 0,
    dirtyFiles,
  };
}

/**
 * Computes a deterministic git tree hash over the FULL working tree (including untracked,
 * non-ignored files) via a temporary `GIT_INDEX_FILE` without touching `HEAD` or the real index (§6 Engine 4, §7.3).
 */
export async function computeWorkingTreeHash(worktreePath: string): Promise<string> {
  const absWorktree = path.resolve(worktreePath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nyxowl-idx-"));
  const tmpIndex = path.join(tmpDir, "index");

  try {
    // Seed temporary index from HEAD if HEAD exists
    const headRes = await execCommand("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: absWorktree,
      timeoutMs: 10_000,
    });
    const envWithTmpIndex: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
    };

    if (headRes.exitCode === 0) {
      await execCommand("git", ["read-tree", "HEAD"], {
        cwd: absWorktree,
        env: envWithTmpIndex,
        timeoutMs: 10_000,
        throwOnNonZero: true,
      });
    }

    await execCommand("git", ["add", "-A"], {
      cwd: absWorktree,
      env: envWithTmpIndex,
      timeoutMs: 30_000,
      throwOnNonZero: true,
    });

    const writeTreeRes = await execCommand("git", ["write-tree"], {
      cwd: absWorktree,
      env: envWithTmpIndex,
      timeoutMs: 15_000,
      throwOnNonZero: true,
    });

    const treeHash = writeTreeRes.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(treeHash)) {
      throw new NyxError("ERR_INTERNAL", `Invalid tree hash returned by git write-tree: "${treeHash}"`);
    }
    return treeHash;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function getDirtyFiles(repoPath: string): Promise<string[]> {
  const res = await execCommand("git", ["status", "--porcelain", "-uall"], {
    cwd: repoPath,
    timeoutMs: 15_000,
  });
  if (res.exitCode !== 0) {
    return [];
  }
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
}

export async function getHeadCommitHash(repoPath: string): Promise<string> {
  const res = await execCommand("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    timeoutMs: 10_000,
    throwOnNonZero: true,
  });
  return res.stdout.trim();
}

export async function getHeadTreeHash(repoPath: string): Promise<string> {
  const res = await execCommand("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: repoPath,
    timeoutMs: 10_000,
    throwOnNonZero: true,
  });
  return res.stdout.trim();
}

export async function detectBaseBranch(
  repoPath: string,
  configuredBase = "auto",
): Promise<string> {
  if (configuredBase && configuredBase !== "auto") {
    return configuredBase;
  }
  const originHead = await execCommand(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: repoPath, timeoutMs: 5_000 },
  );
  if (originHead.exitCode === 0 && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^origin\//, "");
  }

  const currentBranch = await execCommand("git", [" branch", "--show-current"].map((s) => s.trim()), {
    cwd: repoPath,
    timeoutMs: 5_000,
  });
  if (currentBranch.exitCode === 0 && currentBranch.stdout.trim()) {
    const cur = currentBranch.stdout.trim();
    if (!cur.startsWith("nyx/")) {
      return cur;
    }
  }

  for (const candidate of ["main", "master"]) {
    const check = await execCommand(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      { cwd: repoPath, timeoutMs: 5_000 },
    );
    if (check.exitCode === 0) {
      return candidate;
    }
  }

  return "main";
}

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { execCommand } from "../../../core/exec.ts";
import {
  detectBaseBranch,
  getDirtyFiles,
  getGitCommonDir,
  getHeadCommitHash,
} from "../../../core/git.ts";
import { defineTool } from "../../tool.ts";
import { provisionWorktree } from "./provision.ts";

const SLUG_REGEX = /^[a-z0-9-]{1,48}$/;

function ensureGitInfoExclude(commonDir: string, pattern: string): void {
  const infoDir = path.join(commonDir, "info");
  const excludeFile = path.join(infoDir, "exclude");
  fs.mkdirSync(infoDir, { recursive: true });
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (!lines.includes(pattern)) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(excludeFile, `${existing}${prefix}${pattern}\n`, "utf8");
  }
}

export const worktreeStartInputSchema = z.object({
  taskSlug: z.string().regex(SLUG_REGEX, "taskSlug must match /^[a-z0-9-]{1,48}$/"),
  baseBranch: z.string().optional(),
  worktreeMode: z.enum(["auto", "external", "in-repo"]).optional(),
  includeDirty: z.boolean().optional(),
  repoPath: z.string().optional(),
});

export const worktreeStartOutputSchema = z.object({
  taskSlug: z.string(),
  branch: z.string(),
  rootMode: z.enum(["external", "in-repo"]),
  worktreePath: z.string(),
  baseBranch: z.string(),
  baseSha: z.string(),
  mainCheckoutDirtyFiles: z.number().int(),
  dirtyAppliedCommit: z.string().nullable(),
  provision: z.object({
    linkedEnvFiles: z.array(z.string()),
    installCommand: z.string().nullable(),
    installStatus: z.enum(["installed", "linked-fallback", "skipped", "failed"]),
    installArtifactId: z.string().nullable(),
  }),
});

export const nyxWorktreeStartTool = defineTool({
  name: "nyx_worktree_start",
  description: "Creates an isolated git worktree on nyx/<taskSlug> and provisions .env links and dependencies.",
  annotations: {
    title: "Start Git Worktree",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: worktreeStartInputSchema,
  outputSchema: worktreeStartOutputSchema,
  handler: async (input, ctx) => {
    const commonDir = await getGitCommonDir(ctx.projectPath);
    if (!commonDir) {
      throw new NyxError(
        "ERR_NOT_GIT_REPO",
        `Path "${ctx.projectPath}" is not a git repository. Run nyx_project_bootstrap first.`,
      );
    }

    const mainRepoPath =
      path.basename(commonDir) === ".git" ? path.dirname(commonDir) : ctx.projectPath;

    const baseBranch = await detectBaseBranch(
      mainRepoPath,
      input.baseBranch ?? ctx.config.baseBranch,
    );
    const baseSha = await getHeadCommitHash(mainRepoPath);
    const dirtyFiles = await getDirtyFiles(mainRepoPath);

    const requestedMode = input.worktreeMode ?? ctx.config.worktreeRoot;
    const rootMode: "external" | "in-repo" =
      requestedMode === "in-repo" ? "in-repo" : "external";

    const worktreeRootDir =
      rootMode === "external"
        ? ctx.projectLayout.externalWorktreeRoot
        : path.join(mainRepoPath, ".nyxowl", "worktrees");

    if (rootMode === "in-repo") {
      ensureGitInfoExclude(commonDir, ".nyxowl/");
    }

    fs.mkdirSync(worktreeRootDir, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(worktreeRootDir, input.taskSlug);
    const branchName = `nyx/${input.taskSlug}`;

    if (fs.existsSync(worktreePath)) {
      throw new NyxError(
        "ERR_WORKTREE_EXISTS",
        `Worktree path "${worktreePath}" already exists for slug "${input.taskSlug}"`,
      );
    }

    // Create worktree on nyx/<taskSlug> branching from baseSha (HEAD), never touching uncommitted changes in mainRepoPath (§1.1.2)
    const branchExists = await execCommand(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      { cwd: mainRepoPath },
    );

    const addArgs =
      branchExists.exitCode === 0
        ? ["worktree", "add", worktreePath, branchName]
        : ["worktree", "add", "-b", branchName, worktreePath, baseSha];

    await execCommand("git", addArgs, {
      cwd: mainRepoPath,
      timeoutMs: 30_000,
      throwOnNonZero: true,
    });

    // If --include-dirty was specified and main checkout is dirty, apply dirty state to worktree as first commit without modifying main checkout (§1.1.2)
    let dirtyAppliedCommit: string | null = null;
    if (input.includeDirty && dirtyFiles.length > 0) {
      const diffRes = await execCommand("git", ["diff", "HEAD", "--binary"], {
        cwd: mainRepoPath,
        timeoutMs: 20_000,
      });
      if (diffRes.stdout.trim().length > 0) {
        await execCommand("git", ["apply", "--whitespace=nowarn", "-"], {
          cwd: worktreePath,
          stdin: diffRes.stdout,
          throwOnNonZero: true,
        });
      }
      // Also copy untracked non-ignored files from mainRepoPath
      const untrackedRes = await execCommand(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { cwd: mainRepoPath },
      );
      for (const relFile of untrackedRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        const srcFile = path.join(mainRepoPath, relFile);
        const dstFile = path.join(worktreePath, relFile);
        if (fs.existsSync(srcFile) && fs.statSync(srcFile).isFile()) {
          fs.mkdirSync(path.dirname(dstFile), { recursive: true });
          fs.copyFileSync(srcFile, dstFile);
        }
      }
      await execCommand("git", ["add", "-A"], { cwd: worktreePath, throwOnNonZero: true });
      await execCommand(
        "git",
        ["commit", "-m", "chore: apply uncommitted main checkout changes (--include-dirty)"],
        { cwd: worktreePath, throwOnNonZero: true },
      );
      dirtyAppliedCommit = await getHeadCommitHash(worktreePath);
    }

    const provision = await provisionWorktree(
      mainRepoPath,
      worktreePath,
      ctx.config,
      ctx.db,
      ctx.projectLayout,
    );

    const nowIso = new Date().toISOString();
    ctx.db.withImmediateTransaction(() => {
      ctx.db.db
        .prepare(
          `INSERT INTO worktrees (
             task_slug, branch, root, worktree_path, base_branch, base_sha, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(task_slug) DO UPDATE SET
             branch = excluded.branch,
             root = excluded.root,
             worktree_path = excluded.worktree_path,
             base_branch = excluded.base_branch,
             base_sha = excluded.base_sha,
             status = 'active',
             updated_at = excluded.updated_at`,
        )
        .run(
          input.taskSlug,
          branchName,
          worktreeRootDir,
          worktreePath,
          baseBranch,
          baseSha,
          nowIso,
          nowIso,
        );
    });

    return {
      taskSlug: input.taskSlug,
      branch: branchName,
      rootMode,
      worktreePath,
      baseBranch,
      baseSha,
      mainCheckoutDirtyFiles: dirtyFiles.length,
      dirtyAppliedCommit,
      provision,
    };
  },
});

export const worktreeManageInputSchema = z.object({
  action: z.enum(["list", "sync", "remove"]),
  taskSlug: z.string().optional(),
  force: z.boolean().optional(),
  repoPath: z.string().optional(),
});

export const worktreeManageOutputSchema = z.object({
  action: z.enum(["list", "sync", "remove"]),
  status: z.enum(["ok", "conflict", "removed"]),
  worktrees: z
    .array(
      z.object({
        taskSlug: z.string(),
        branch: z.string(),
        root: z.string(),
        worktreePath: z.string(),
        baseBranch: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
  conflictedFiles: z.array(z.string()).optional(),
  owningRole: z.string().optional(),
  newBaseSha: z.string().optional(),
});

function inferOwningRoleForFiles(files: string[]): string {
  for (const f of files) {
    if (/prisma|migrations|schema|\.sql/i.test(f)) return "nyx-db";
    if (/components|pages|app|ui|\.tsx|\.vue|\.svelte/i.test(f)) return "nyx-ui";
  }
  return "nyx-api";
}

export const nyxWorktreeManageTool = defineTool({
  name: "nyx_worktree_manage",
  description: "Lists, syncs (rebases onto updated base), or removes Nyxowl git worktrees.",
  annotations: {
    title: "Manage Git Worktrees",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: worktreeManageInputSchema,
  outputSchema: worktreeManageOutputSchema,
  handler: async (input, ctx) => {
    const commonDir = await getGitCommonDir(ctx.projectPath);
    if (!commonDir) {
      throw new NyxError("ERR_NOT_GIT_REPO", `Path "${ctx.projectPath}" is not a git repository.`);
    }
    const mainRepoPath =
      path.basename(commonDir) === ".git" ? path.dirname(commonDir) : ctx.projectPath;

    if (input.action === "list") {
      await execCommand("git", ["worktree", "prune"], { cwd: mainRepoPath });
      const rows = ctx.db.db
        .prepare(
          "SELECT task_slug, branch, root, worktree_path, base_branch, status FROM worktrees ORDER BY updated_at DESC",
        )
        .all() as Array<{
        task_slug: string;
        branch: string;
        root: string;
        worktree_path: string;
        base_branch: string;
        status: string;
      }>;

      return {
        action: "list" as const,
        status: "ok" as const,
        worktrees: rows.map((r) => ({
          taskSlug: r.task_slug,
          branch: r.branch,
          root: r.root,
          worktreePath: r.worktree_path,
          baseBranch: r.base_branch,
          status: fs.existsSync(r.worktree_path) ? r.status : "pruned",
        })),
      };
    }

    if (!input.taskSlug) {
      throw new NyxError(
        "ERR_INVALID_INPUT",
        `taskSlug is required for worktree action "${input.action}"`,
      );
    }
    const slug = input.taskSlug;

    const wtRow = ctx.db.db
      .prepare(
        "SELECT task_slug, branch, root, worktree_path, base_branch FROM worktrees WHERE task_slug = ?",
      )
      .get(slug) as
      | {
          task_slug: string;
          branch: string;
          root: string;
          worktree_path: string;
          base_branch: string;
        }
      | undefined;

    if (!wtRow) {
      throw new NyxError(
        "ERR_WORKTREE_NOT_FOUND",
        `Worktree "${slug}" not found in state DB`,
      );
    }

    if (input.action === "sync") {
      // Fetch origin if configured
      await execCommand("git", ["fetch", "--quiet", "origin"], {
        cwd: wtRow.worktree_path,
        timeoutMs: 15_000,
      });

      const rebaseTarget = wtRow.base_branch;
      const rebaseRes = await execCommand("git", ["rebase", rebaseTarget], {
        cwd: wtRow.worktree_path,
        timeoutMs: 30_000,
      });

      if (rebaseRes.exitCode !== 0) {
        const conflictRes = await execCommand(
          "git",
          ["diff", "--name-only", "--diff-filter=U"],
          { cwd: wtRow.worktree_path },
        );
        const conflictedFiles = conflictRes.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);

        // Abort the failed rebase so the worktree stays operable for the owning role
        await execCommand("git", ["rebase", "--abort"], { cwd: wtRow.worktree_path });

        return {
          action: "sync" as const,
          status: "conflict" as const,
          conflictedFiles,
          owningRole: inferOwningRoleForFiles(conflictedFiles),
        };
      }

      const newBaseSha = await getHeadCommitHash(mainRepoPath);
      ctx.db.withImmediateTransaction(() => {
        ctx.db.db
          .prepare("UPDATE worktrees SET base_sha = ?, updated_at = ? WHERE task_slug = ?")
          .run(newBaseSha, new Date().toISOString(), slug);
      });

      return {
        action: "sync" as const,
        status: "ok" as const,
        newBaseSha,
      };
    }

    // action === "remove"
    if (fs.existsSync(wtRow.worktree_path) && !input.force) {
      const dirty = await getDirtyFiles(wtRow.worktree_path);
      if (dirty.length > 0) {
        throw new NyxError(
          "ERR_WORKTREE_DIRTY",
          `Worktree "${slug}" has ${dirty.length} uncommitted file(s). Commit or pass force: true to remove.`,
          { dirtyFiles: dirty },
        );
      }

      // Check for unpushed commits relative to base_branch (unless pushed to origin)
      const unpushed = await execCommand(
        "git",
        ["log", `${wtRow.base_branch}..HEAD`, "--oneline"],
        { cwd: wtRow.worktree_path },
      );
      const remoteBranch = await execCommand(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${wtRow.branch}`],
        { cwd: wtRow.worktree_path },
      );
      if (unpushed.stdout.trim().length > 0 && remoteBranch.exitCode !== 0) {
        throw new NyxError(
          "ERR_WORKTREE_DIRTY",
          `Worktree "${slug}" has unpushed commits on ${wtRow.branch}. Push/PR first or pass force: true.`,
        );
      }
    }

    // Remove shadow slice refs refs/nyxowl/slices/<taskSlug>/*
    const refsRes = await execCommand(
      "git",
      ["for-each-ref", "--format=%(refname)", `refs/nyxowl/slices/${slug}/`],
      { cwd: mainRepoPath },
    );
    for (const ref of refsRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      await execCommand("git", ["update-ref", "-d", ref], { cwd: mainRepoPath });
    }

    if (fs.existsSync(wtRow.worktree_path)) {
      await execCommand("git", ["worktree", "remove", "--force", wtRow.worktree_path], {
        cwd: mainRepoPath,
      });
      if (fs.existsSync(wtRow.worktree_path)) {
        fs.rmSync(wtRow.worktree_path, { recursive: true, force: true });
      }
    }
    await execCommand("git", ["worktree", "prune"], { cwd: mainRepoPath });

    ctx.db.withImmediateTransaction(() => {
      ctx.db.db
        .prepare("UPDATE worktrees SET status = 'removed', updated_at = ? WHERE task_slug = ?")
        .run(new Date().toISOString(), slug);
      ctx.db.db.prepare("DELETE FROM slices WHERE task_slug = ?").run(slug);
    });

    return {
      action: "remove" as const,
      status: "removed" as const,
    };
  },
});

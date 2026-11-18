import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHydrateDigestForHook } from "../../src/cli/hooks/session-start.ts";
import { execCommand } from "../../src/core/exec.ts";
import { computeRepoId } from "../../src/core/git.ts";
import { ensureProjectLayout } from "../../src/core/paths.ts";
import { StateDb } from "../../src/mcp/db/sqlite.ts";
import { nyxContextHydrateTool } from "../../src/mcp/engines/context/index.ts";
import { invokeToolDefinition } from "../../src/mcp/tool.ts";

describe("context hydration ignores worktree rows whose directory is gone", () => {
  let tmpRoot: string;
  let nyxHome: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-hydrate-stale-"));
    nyxHome = path.join(tmpRoot, "nyxhome");
    repoDir = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: repoDir });
    await execCommand("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execCommand("git", ["config", "user.name", "Test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
    await execCommand("git", ["add", "-A"], { cwd: repoDir });
    await execCommand("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function insertWorktree(
    db: StateDb,
    args: {
      slug: string;
      worktreePath: string;
      updatedAt: string;
      status?: string;
    },
  ): void {
    db.db
      .prepare(
        `INSERT INTO worktrees
           (task_slug, branch, root, worktree_path, base_branch, base_sha, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', 'deadbeef', ?, ?, ?)`,
      )
      .run(
        args.slug,
        `nyx/${args.slug}`,
        path.dirname(args.worktreePath),
        args.worktreePath,
        args.status ?? "active",
        "2026-01-01T00:00:00.000Z",
        args.updatedAt,
      );
  }

  async function withDb<T>(fn: (db: StateDb) => T): Promise<T> {
    const repoId = await computeRepoId(repoDir);
    const layout = ensureProjectLayout(repoId, nyxHome);
    const db = new StateDb(layout.stateDbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  it("selects the most recent live row instead of a newer row with a missing directory", async () => {
    const livePath = path.join(tmpRoot, "live-worktree");
    fs.mkdirSync(livePath, { recursive: true });
    const missingPath = path.join(tmpRoot, "deleted-worktree");

    await withDb((db) => {
      insertWorktree(db, {
        slug: "live-task",
        worktreePath: livePath,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      insertWorktree(db, {
        slug: "deleted-task",
        worktreePath: missingPath,
        updatedAt: "2026-02-01T00:00:00.000Z",
      });
    });

    const res = await invokeToolDefinition(
      nyxContextHydrateTool,
      { repoPath: repoDir },
      { nyxHome, defaultProjectPath: repoDir },
    );

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.["activeWorktree"]).toMatchObject({
      taskSlug: "live-task",
      worktreePath: livePath,
    });
  });

  it("reports no active worktree when every active row points at a missing directory", async () => {
    await withDb((db) => {
      insertWorktree(db, {
        slug: "deleted-task",
        worktreePath: path.join(tmpRoot, "deleted-worktree"),
        updatedAt: "2026-02-01T00:00:00.000Z",
      });
    });

    const res = await invokeToolDefinition(
      nyxContextHydrateTool,
      { repoPath: repoDir },
      { nyxHome, defaultProjectPath: repoDir },
    );

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.["activeWorktree"]).toBeNull();
    expect(res.structuredContent?.["currentSlice"]).toBeNull();
  });

  it("keeps the session hook aligned and scopes its slice to the live task", async () => {
    const livePath = path.join(tmpRoot, "live-worktree");
    fs.mkdirSync(livePath, { recursive: true });

    await withDb((db) => {
      insertWorktree(db, {
        slug: "live-task",
        worktreePath: livePath,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      insertWorktree(db, {
        slug: "deleted-task",
        worktreePath: path.join(tmpRoot, "deleted-worktree"),
        updatedAt: "2026-02-01T00:00:00.000Z",
      });
      const insertSlice = db.db.prepare(
        `INSERT INTO slices
           (slice_id, task_slug, seq, label, ref_name, tree_hash, commit_sha, created_at)
         VALUES (?, ?, ?, ?, ?, 'tree', 'commit', '2026-01-01T00:00:00.000Z')`,
      );
      insertSlice.run("slice-live", "live-task", 1, "live slice", "refs/nyxowl/slices/live-task/1");
      insertSlice.run("slice-old", "deleted-task", 9, "old slice", "refs/nyxowl/slices/deleted-task/9");
    });

    const digest = buildHydrateDigestForHook(repoDir, nyxHome);

    expect(digest).toContain("Active Worktree: live-task");
    expect(digest).not.toContain("deleted-task");
    expect(digest).toContain("slice-live");
    expect(digest).not.toContain("slice-old");
  });
});

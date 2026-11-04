import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../tool.ts";

export function normalizeLockPath(filePath: string, baseDir: string): string {
  if (filePath === "__verify__") {
    return "__verify__";
  }
  const absBase = path.resolve(baseDir);
  const absFile = path.resolve(absBase, filePath);
  const rel = path.relative(absBase, absFile).split(path.sep).join("/");
  return rel.startsWith("..") ? absFile : rel || ".";
}

export const lockAcquireInputSchema = z.object({
  filePaths: z.array(z.string().min(1)).min(1),
  ownerRole: z.string().min(1),
  ttlSeconds: z.number().int().min(5).max(3600).default(300),
  worktreePath: z.string().optional(),
});

export const lockAcquireOutputSchema = z.object({
  acquired: z.boolean(),
  lockedPaths: z.array(z.string()),
  expiresAt: z.number().int().nullable(),
  conflicts: z.array(
    z.object({
      filePath: z.string(),
      ownerRole: z.string(),
      expiresAt: z.number().int(),
    }),
  ),
});

export const nyxLockAcquireTool = defineTool({
  name: "nyx_lock_acquire",
  description: "Atomically acquires file locks with TTL for parallel writer isolation.",
  annotations: {
    title: "Acquire File Locks",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: lockAcquireInputSchema,
  outputSchema: lockAcquireOutputSchema,
  handler: async (input, ctx) => {
    const baseDir = input.worktreePath ?? ctx.projectPath;
    const normalizedPaths = [
      ...new Set(input.filePaths.map((p) => normalizeLockPath(p, baseDir))),
    ];
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + input.ttlSeconds;

    return ctx.db.withImmediateTransaction(() => {
      // 1. Reap expired locks
      ctx.db.db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(nowSec);

      // 2. Check for conflicts (including __verify__ mutex semantics §5)
      const allLocks = ctx.db.db
        .prepare("SELECT file_path, owner_role, expires_at FROM locks")
        .all() as Array<{ file_path: string; owner_role: string; expires_at: number }>;

      const conflicts: Array<{ filePath: string; ownerRole: string; expiresAt: number }> = [];

      const requestsVerifyMutex = normalizedPaths.includes("__verify__");
      if (requestsVerifyMutex) {
        for (const held of allLocks) {
          if (held.owner_role !== input.ownerRole) {
            conflicts.push({
              filePath: held.file_path,
              ownerRole: held.owner_role,
              expiresAt: held.expires_at,
            });
          }
        }
      } else {
        const verifyHeld = allLocks.find(
          (l) => l.file_path === "__verify__" && l.owner_role !== input.ownerRole,
        );
        if (verifyHeld) {
          conflicts.push({
            filePath: "__verify__",
            ownerRole: verifyHeld.owner_role,
            expiresAt: verifyHeld.expires_at,
          });
        }
        for (const reqPath of normalizedPaths) {
          const held = allLocks.find(
            (l) => l.file_path === reqPath && l.owner_role !== input.ownerRole,
          );
          if (held) {
            conflicts.push({
              filePath: held.file_path,
              ownerRole: held.owner_role,
              expiresAt: held.expires_at,
            });
          }
        }
      }

      if (conflicts.length > 0) {
        return {
          acquired: false,
          lockedPaths: [],
          expiresAt: null,
          conflicts,
        };
      }

      // 3. Acquire or refresh locks atomically
      const upsertStmt = ctx.db.db.prepare(`
        INSERT INTO locks (file_path, owner_role, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          owner_role = excluded.owner_role,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
      `);

      for (const reqPath of normalizedPaths) {
        upsertStmt.run(reqPath, input.ownerRole, nowSec, expiresAt);
      }

      return {
        acquired: true,
        lockedPaths: normalizedPaths,
        expiresAt,
        conflicts: [],
      };
    });
  },
});

export const lockReleaseInputSchema = z.object({
  filePaths: z.array(z.string().min(1)).optional(),
  ownerRole: z.string().min(1),
  worktreePath: z.string().optional(),
});

export const lockReleaseOutputSchema = z.object({
  releasedCount: z.number().int(),
});

export const nyxLockReleaseTool = defineTool({
  name: "nyx_lock_release",
  description: "Releases file locks held by the specified owner role.",
  annotations: {
    title: "Release File Locks",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: lockReleaseInputSchema,
  outputSchema: lockReleaseOutputSchema,
  handler: async (input, ctx) => {
    const baseDir = input.worktreePath ?? ctx.projectPath;
    return ctx.db.withImmediateTransaction(() => {
      if (!input.filePaths || input.filePaths.length === 0) {
        const res = ctx.db.db
          .prepare("DELETE FROM locks WHERE owner_role = ?")
          .run(input.ownerRole);
        return { releasedCount: Number(res.changes) };
      }

      const normalized = input.filePaths.map((p) => normalizeLockPath(p, baseDir));
      const stmt = ctx.db.db.prepare(
        "DELETE FROM locks WHERE file_path = ? AND owner_role = ?",
      );
      let count = 0;
      for (const p of normalized) {
        const res = stmt.run(p, input.ownerRole);
        count += Number(res.changes);
      }
      return { releasedCount: count };
    });
  },
});

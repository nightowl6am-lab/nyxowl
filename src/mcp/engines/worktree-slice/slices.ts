import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { execCommand } from "../../../core/exec.ts";
import { computeWorkingTreeHash, getHeadCommitHash } from "../../../core/git.ts";
import { generateUlid } from "../../../core/receipts.ts";
import type { StateDb } from "../../db/sqlite.ts";
import { defineTool } from "../../tool.ts";

export async function createShadowCheckpoint(
  db: StateDb,
  worktreePath: string,
  label: string,
  explicitTaskSlug?: string,
): Promise<{
  sliceId: string;
  taskSlug: string;
  seq: number;
  label: string;
  refName: string;
  treeHash: string;
  commitSha: string;
}> {
  const absWt = path.resolve(worktreePath);
  if (!fs.existsSync(absWt)) {
    throw new NyxError("ERR_WORKTREE_NOT_FOUND", `Worktree path "${absWt}" does not exist`);
  }

  const wtRow = db.db
    .prepare("SELECT task_slug FROM worktrees WHERE worktree_path = ?")
    .get(absWt) as { task_slug: string } | undefined;
  const taskSlug = explicitTaskSlug ?? wtRow?.task_slug ?? path.basename(absWt);

  // Snapshot full working tree (including untracked non-ignored files) via temp index (§6 Engine 4)
  const treeHash = await computeWorkingTreeHash(absWt);
  const headSha = await getHeadCommitHash(absWt);

  const commitTreeRes = await execCommand(
    "git",
    ["commit-tree", treeHash, "-p", headSha, "-m", `nyxowl-slice: ${label}`],
    { cwd: absWt, timeoutMs: 15_000, throwOnNonZero: true },
  );
  const commitSha = commitTreeRes.stdout.trim();

  let seq = 1;
  let refName = "";
  const sliceId = generateUlid();
  const nowIso = new Date().toISOString();

  db.withImmediateTransaction(() => {
    const seqRow = db.db
      .prepare("SELECT COALESCE(MAX(seq), 0) as max_seq FROM slices WHERE task_slug = ?")
      .get(taskSlug) as { max_seq: number } | undefined;
    seq = (seqRow?.max_seq ?? 0) + 1;
    refName = `refs/nyxowl/slices/${taskSlug}/${seq}`;

    db.db
      .prepare(
        `INSERT INTO slices (slice_id, task_slug, seq, label, ref_name, tree_hash, commit_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sliceId, taskSlug, seq, label, refName, treeHash, commitSha, nowIso);
  });

  await execCommand("git", ["update-ref", refName, commitSha], {
    cwd: absWt,
    timeoutMs: 10_000,
    throwOnNonZero: true,
  });

  return {
    sliceId,
    taskSlug,
    seq,
    label,
    refName,
    treeHash,
    commitSha,
  };
}

export async function rewindToShadowCheckpoint(
  db: StateDb,
  worktreePath: string,
  sliceIdOrRef: string,
): Promise<{
  sliceId: string;
  taskSlug: string;
  seq: number;
  label: string;
  restoredTreeHash: string;
}> {
  const absWt = path.resolve(worktreePath);
  const sliceRow = db.db
    .prepare(
      "SELECT slice_id, task_slug, seq, label, ref_name, tree_hash FROM slices WHERE slice_id = ? OR ref_name = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(sliceIdOrRef, sliceIdOrRef) as
    | {
        slice_id: string;
        task_slug: string;
        seq: number;
        label: string;
        ref_name: string;
        tree_hash: string;
      }
    | undefined;

  if (!sliceRow) {
    throw new NyxError(
      "ERR_SLICE_NOT_FOUND",
      `Shadow slice "${sliceIdOrRef}" was not found`,
    );
  }

  // Restore files from snapshot treeHash and remove any files that were added after the snapshot,
  // while preserving ignored files (.env* links, node_modules) by NEVER passing -x to git clean (§6 Engine 4)!
  // Step 1: Load CURRENT working tree into index so git read-tree -u -m <targetTree> removes tracked-in-current-but-absent-in-target files
  await execCommand("git", ["add", "-A"], { cwd: absWt, timeoutMs: 20_000, throwOnNonZero: true });
  await execCommand("git", ["read-tree", "--reset", "-u", sliceRow.tree_hash], {
    cwd: absWt,
    timeoutMs: 20_000,
    throwOnNonZero: true,
  });
  await execCommand("git", ["checkout-index", "-a", "-f"], {
    cwd: absWt,
    timeoutMs: 20_000,
    throwOnNonZero: true,
  });
  // Clean any remaining untracked non-ignored directories/files (NO -x!)
  await execCommand("git", ["clean", "-fd"], {
    cwd: absWt,
    timeoutMs: 20_000,
    throwOnNonZero: true,
  });
  // Restore real git index back to HEAD without touching working tree
  await execCommand("git", ["read-tree", "HEAD"], {
    cwd: absWt,
    timeoutMs: 10_000,
    throwOnNonZero: true,
  });

  const restoredTreeHash = await computeWorkingTreeHash(absWt);

  return {
    sliceId: sliceRow.slice_id,
    taskSlug: sliceRow.task_slug,
    seq: sliceRow.seq,
    label: sliceRow.label,
    restoredTreeHash,
  };
}

export const sliceCheckpointInputSchema = z.object({
  worktreePath: z.string().min(1),
  label: z.string().min(1).max(160),
  taskSlug: z.string().optional(),
});

export const sliceCheckpointOutputSchema = z.object({
  sliceId: z.string(),
  taskSlug: z.string(),
  seq: z.number().int(),
  label: z.string(),
  refName: z.string(),
  treeHash: z.string(),
  commitSha: z.string(),
});

export const nyxSliceCheckpointTool = defineTool({
  name: "nyx_slice_checkpoint",
  description: "Snapshots the full working tree (including untracked files) to refs/nyxowl/slices/<slug>/<n>.",
  annotations: {
    title: "Checkpoint Shadow Slice",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: sliceCheckpointInputSchema,
  outputSchema: sliceCheckpointOutputSchema,
  handler: async (input, ctx) => {
    return createShadowCheckpoint(ctx.db, input.worktreePath, input.label, input.taskSlug);
  },
});

export const sliceRewindInputSchema = z.object({
  worktreePath: z.string().min(1),
  sliceId: z.string().min(1),
});

export const sliceRewindOutputSchema = z.object({
  sliceId: z.string(),
  taskSlug: z.string(),
  seq: z.number().int(),
  label: z.string(),
  restoredTreeHash: z.string(),
});

export const nyxSliceRewindTool = defineTool({
  name: "nyx_slice_rewind",
  description: "Rewinds the worktree to a shadow slice snapshot while preserving ignored files (.env, node_modules).",
  annotations: {
    title: "Rewind Shadow Slice",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: sliceRewindInputSchema,
  outputSchema: sliceRewindOutputSchema,
  handler: async (input, ctx) => {
    return rewindToShadowCheckpoint(ctx.db, input.worktreePath, input.sliceId);
  },
});

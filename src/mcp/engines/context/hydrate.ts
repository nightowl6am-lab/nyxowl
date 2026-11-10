import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getDirtyFiles, getGitCommonDir } from "../../../core/git.ts";
import { enforceTokenBudget, estimateTokens } from "../../../core/tokens.ts";
import { defineTool, type ToolExecutionContext } from "../../tool.ts";

export type FolderClassification = "greenfield" | "adopt" | "repo";

export async function classifyProjectFolder(
  projectPath: string,
): Promise<{ folderState: FolderClassification; mainCheckoutDirty: number }> {
  const abs = path.resolve(projectPath);
  if (!fs.existsSync(abs)) {
    return { folderState: "greenfield", mainCheckoutDirty: 0 };
  }
  const commonDir = await getGitCommonDir(abs);
  if (commonDir) {
    const dirty = await getDirtyFiles(abs);
    return { folderState: "repo", mainCheckoutDirty: dirty.length };
  }
  const entries = fs
    .readdirSync(abs)
    .filter((name) => name !== "." && name !== ".." && name !== ".DS_Store");
  if (entries.length === 0) {
    return { folderState: "greenfield", mainCheckoutDirty: 0 };
  }
  return { folderState: "adopt", mainCheckoutDirty: 0 };
}

export async function buildHydrateDigest(ctx: ToolExecutionContext): Promise<{
  repoId: string;
  folderState: FolderClassification;
  mainCheckoutDirty: number;
  dnaSummary: string;
  activeWorktree: { taskSlug: string; branch: string; worktreePath: string; root: string } | null;
  currentSlice: { sliceId: string; label: string; seq: number } | null;
  activeStrikes: number;
  latestHandoff: { completedTask: string; nextTask: string } | null;
  promotedKeys: string[];
  greenReceipts: string[];
  digestMarkdown: string;
  tokenCount: number;
}> {
  const { folderState, mainCheckoutDirty } = await classifyProjectFolder(ctx.projectPath);

  const dnaRow = ctx.db.db
    .prepare("SELECT dna_json FROM dna WHERE repo_id = ?")
    .get(ctx.repoId) as { dna_json: string } | undefined;
  let dnaSummary = "not-extracted";
  if (dnaRow) {
    try {
      const parsed = JSON.parse(dnaRow.dna_json) as {
        primaryStack?: string;
        languages?: string[];
        httpSurface?: boolean;
      };
      dnaSummary = `${parsed.primaryStack ?? "polyglot"} (${(parsed.languages ?? []).join(",") || "unknown"}, http=${Boolean(parsed.httpSurface)})`;
    } catch {
      dnaSummary = "extracted";
    }
  }

  const wtRow = ctx.db.db
    .prepare(
      "SELECT task_slug, branch, worktree_path, root FROM worktrees WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1",
    )
    .get() as
    | { task_slug: string; branch: string; worktree_path: string; root: string }
    | undefined;

  const activeWorktree = wtRow
    ? {
        taskSlug: wtRow.task_slug,
        branch: wtRow.branch,
        worktreePath: wtRow.worktree_path,
        root: wtRow.root,
      }
    : null;

  const sliceRow = wtRow
    ? (ctx.db.db
        .prepare(
          "SELECT slice_id, label, seq FROM slices WHERE task_slug = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(wtRow.task_slug) as { slice_id: string; label: string; seq: number } | undefined)
    : undefined;

  const currentSlice = sliceRow
    ? { sliceId: sliceRow.slice_id, label: sliceRow.label, seq: sliceRow.seq }
    : null;

  const strikeRow = wtRow
    ? (ctx.db.db
        .prepare(
          "SELECT COALESCE(MAX(strike_count), 0) as max_strikes FROM strikes WHERE task_slug = ?",
        )
        .get(wtRow.task_slug) as { max_strikes: number } | undefined)
    : undefined;
  const activeStrikes = strikeRow?.max_strikes ?? 0;

  const handoffRow = ctx.db.db
    .prepare(
      "SELECT completed_task, next_task FROM handoffs ORDER BY id DESC LIMIT 1",
    )
    .get() as { completed_task: string; next_task: string } | undefined;

  const latestHandoff = handoffRow
    ? { completedTask: handoffRow.completed_task, nextTask: handoffRow.next_task }
    : null;

  const promotedRows = ctx.db.db
    .prepare(
      "SELECT DISTINCT key FROM blackboard WHERE trust = 'promoted' ORDER BY id DESC LIMIT 10",
    )
    .all() as Array<{ key: string }>;
  const promotedKeys = promotedRows.map((r) => r.key);

  const receiptRows = ctx.db.db
    .prepare(
      "SELECT kind, status FROM receipts WHERE status IN ('GREEN', 'NA') ORDER BY created_at DESC LIMIT 8",
    )
    .all() as Array<{ kind: string; status: string }>;
  const greenReceipts = receiptRows.map((r) => `${r.kind}:${r.status}`);

  const lines = [
    `# Nyxowl Context Hydrate (${ctx.repoId})`,
    `- **Folder:** ${folderState} (mainCheckoutDirty: ${mainCheckoutDirty} files)`,
    `- **DNA:** ${dnaSummary}`,
    `- **Worktree:** ${activeWorktree ? `${activeWorktree.branch} @ ${activeWorktree.worktreePath}` : "none"}`,
    `- **Slice:** ${currentSlice ? `#${currentSlice.seq} ${currentSlice.label} (${currentSlice.sliceId})` : "none"} | **Strikes:** ${activeStrikes}`,
    `- **Handoff:** ${latestHandoff ? `done="${latestHandoff.completedTask}" -> next="${latestHandoff.nextTask}"` : "none"}`,
    `- **Promoted Keys:** ${promotedKeys.join(", ") || "none"}`,
    `- **Receipts:** ${greenReceipts.join(", ") || "none"}`,
  ];

  const budgeted = enforceTokenBudget(lines.join("\n"), ctx.config.budgets.handoffTokens);
  const digestMarkdown = budgeted.text;
  const tokenCount = estimateTokens(digestMarkdown);

  return {
    repoId: ctx.repoId,
    folderState,
    mainCheckoutDirty,
    dnaSummary,
    activeWorktree,
    currentSlice,
    activeStrikes,
    latestHandoff,
    promotedKeys,
    greenReceipts,
    digestMarkdown,
    tokenCount,
  };
}

export const contextHydrateInputSchema = z.object({
  repoPath: z.string().optional(),
});

export const contextHydrateOutputSchema = z.object({
  repoId: z.string(),
  folderState: z.enum(["greenfield", "adopt", "repo"]),
  mainCheckoutDirty: z.number().int(),
  dnaSummary: z.string(),
  activeWorktree: z
    .object({
      taskSlug: z.string(),
      branch: z.string(),
      worktreePath: z.string(),
      root: z.string(),
    })
    .nullable(),
  currentSlice: z
    .object({
      sliceId: z.string(),
      label: z.string(),
      seq: z.number().int(),
    })
    .nullable(),
  activeStrikes: z.number().int(),
  latestHandoff: z
    .object({
      completedTask: z.string(),
      nextTask: z.string(),
    })
    .nullable(),
  promotedKeys: z.array(z.string()),
  greenReceipts: z.array(z.string()),
  digestMarkdown: z.string(),
  tokenCount: z.number().int(),
});

export const nyxContextHydrateTool = defineTool({
  name: "nyx_context_hydrate",
  description: "Returns a <=400-token digest of DNA, folder, worktree, slice, strikes, and handoff.",
  annotations: {
    title: "Context Hydrate",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: contextHydrateInputSchema,
  outputSchema: contextHydrateOutputSchema,
  handler: async (_input, ctx) => {
    return buildHydrateDigest(ctx);
  },
});

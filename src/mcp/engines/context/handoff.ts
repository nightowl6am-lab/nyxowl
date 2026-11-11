import fs from "node:fs";
import { z } from "zod";
import { buildHandoffDigest } from "../../../core/handoff-compress.ts";
import { assertWithinTokenBudget } from "../../../core/tokens.ts";
import { defineTool } from "../../tool.ts";

export const subagentSummarySchema = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  role: z.string().min(1),
  slice: z.string().min(1),
  filesChanged: z.array(z.string()),
  receipts: z.array(z.string()),
  contractsPublished: z.array(z.string()),
  openIssues: z.array(z.string()),
  nextAction: z.string().min(1),
});

export const taskHandoffInputSchema = z.object({
  completedTask: z.string().min(1),
  filesChanged: z.array(z.string()),
  keyDecisions: z.array(z.string()),
  nextTask: z.string().min(1),
  receipts: z.array(z.string()),
  subagentSummary: subagentSummarySchema.optional(),
  repoPath: z.string().optional(),
});

export const taskHandoffOutputSchema = z.object({
  handoffId: z.number().int(),
  tokenCount: z.number().int(),
  originalTokenCount: z.number().int(),
  compressed: z.boolean(),
  compressionNotes: z.array(z.string()),
  handoffFilePath: z.string(),
  locksReleased: z.number().int(),
  compactionInstruction: z.string(),
  digestMarkdown: z.string(),
});

export const nyxTaskHandoffTool = defineTool({
  name: "nyx_task_handoff",
  description: "Writes a <=400-token task-boundary handoff digest, releases locks, and prepares compaction.",
  annotations: {
    title: "Task Handoff",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: taskHandoffInputSchema,
  outputSchema: taskHandoffOutputSchema,
  handler: async (input, ctx) => {
    if (input.subagentSummary) {
      const summaryJson = JSON.stringify(input.subagentSummary);
      assertWithinTokenBudget(
        summaryJson,
        ctx.config.budgets.subagentSummaryTokens,
        "Subagent Summary (subagent-summary-v1)",
      );
    }

    // The digest is compressed deterministically when over budget instead of
    // rejecting the call: a rejected handoff wastes a turn and leaves the next
    // session without a handoff at all.
    const digest = buildHandoffDigest(
      {
        completedTask: input.completedTask,
        filesChanged: input.filesChanged,
        keyDecisions: input.keyDecisions,
        nextTask: input.nextTask,
        receipts: input.receipts,
        ...(input.subagentSummary ? { subagentSummary: input.subagentSummary } : {}),
      },
      ctx.config.budgets.handoffTokens,
    );

    let handoffId = 0;
    let locksReleased = 0;
    const nowIso = new Date().toISOString();

    ctx.db.withImmediateTransaction(() => {
      const insertRes = ctx.db.db
        .prepare(
          `INSERT INTO handoffs (
             completed_task, files_changed_json, key_decisions_json, next_task,
             receipts_json, digest_markdown, token_count, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.completedTask,
          JSON.stringify(input.filesChanged),
          JSON.stringify(input.keyDecisions),
          input.nextTask,
          JSON.stringify(input.receipts),
          digest.digestMarkdown,
          digest.tokenCount,
          nowIso,
        );
      handoffId = Number(insertRes.lastInsertRowid);

      const delRes = ctx.db.db.prepare("DELETE FROM locks").run();
      locksReleased = Number(delRes.changes);
    });

    fs.writeFileSync(ctx.projectLayout.handoffPath, digest.digestMarkdown + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });

    return {
      handoffId,
      tokenCount: digest.tokenCount,
      originalTokenCount: digest.originalTokenCount,
      compressed: digest.compressed,
      compressionNotes: digest.compressionNotes,
      handoffFilePath: ctx.projectLayout.handoffPath,
      locksReleased,
      compactionInstruction:
        "Context handoff persisted. Safe to compact conversation history and resume via nyx_context_hydrate.",
      digestMarkdown: digest.digestMarkdown,
    };
  },
});

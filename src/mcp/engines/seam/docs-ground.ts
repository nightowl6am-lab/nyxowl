import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { defineTool } from "../../tool.ts";

export const docsGroundInputSchema = z.object({
  topic: z.string().min(2).max(160),
  sourceUrl: z.string().min(5).max(500),
  sanitizedSummary: z.string().min(5).max(1500),
  apiContract: z.string().min(2).max(1500),
  repoPath: z.string().optional(),
});

export const docsGroundOutputSchema = z.object({
  docId: z.number().int(),
  topic: z.string(),
  sourceUrl: z.string(),
  contentHash: z.string(),
  createdAt: z.string(),
});

export const nyxDocsGroundTool = defineTool({
  name: "nyx_docs_ground",
  description: "Pins schema-validated API documentation excerpts whose sourceUrl was fetched via nyx_web_fetch.",
  annotations: {
    title: "Live Documentation Grounding",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: docsGroundInputSchema,
  outputSchema: docsGroundOutputSchema,
  handler: async (input, ctx) => {
    const fetchLog = ctx.db.db
      .prepare(
        "SELECT content_hash FROM web_fetch_log WHERE url = ? ORDER BY id DESC LIMIT 1",
      )
      .get(input.sourceUrl) as { content_hash: string } | undefined;

    if (!fetchLog) {
      throw new NyxError(
        "ERR_BLACKBOARD_CITATION_INVALID",
        `sourceUrl "${input.sourceUrl}" has not been fetched via nyx_web_fetch in this project. Fetch and sanitize the URL first.`,
      );
    }

    const nowIso = new Date().toISOString();
    let docId = 0;

    ctx.db.withImmediateTransaction(() => {
      const res = ctx.db.db
        .prepare(
          `INSERT INTO docs (topic, source_url, sanitized_summary, api_contract, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.topic,
          input.sourceUrl,
          input.sanitizedSummary,
          input.apiContract,
          fetchLog.content_hash,
          nowIso,
        );
      docId = Number(res.lastInsertRowid);
    });

    return {
      docId,
      topic: input.topic,
      sourceUrl: input.sourceUrl,
      contentHash: fetchLog.content_hash,
      createdAt: nowIso,
    };
  },
});

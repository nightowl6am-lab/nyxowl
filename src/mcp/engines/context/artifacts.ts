import fs from "node:fs";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { defineTool } from "../../tool.ts";

export const artifactReadInputSchema = z.object({
  artifactId: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(64).max(16384).optional(),
  repoPath: z.string().optional(),
});

export const artifactReadOutputSchema = z.object({
  artifactId: z.string(),
  kind: z.string(),
  offset: z.number().int(),
  limit: z.number().int(),
  totalBytes: z.number().int(),
  hasMore: z.boolean(),
  chunk: z.string(),
});

export const nyxArtifactReadTool = defineTool({
  name: "nyx_artifact_read",
  description: "Pages through large tool outputs stored in the Nyxowl artifact store.",
  annotations: {
    title: "Read Artifact Page",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: artifactReadInputSchema,
  outputSchema: artifactReadOutputSchema,
  handler: async (input, ctx) => {
    const row = ctx.db.db
      .prepare(
        "SELECT id, kind, file_path, byte_length FROM artifacts WHERE id = ?",
      )
      .get(input.artifactId) as
      | { id: string; kind: string; file_path: string; byte_length: number }
      | undefined;

    if (!row || !fs.existsSync(row.file_path)) {
      throw new NyxError(
        "ERR_ARTIFACT_NOT_FOUND",
        `Artifact "${input.artifactId}" was not found`,
      );
    }

    const fullText = fs.readFileSync(row.file_path, "utf8");
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 3000;
    const chunk = fullText.slice(offset, offset + limit);
    const hasMore = offset + limit < fullText.length;

    return {
      artifactId: row.id,
      kind: row.kind,
      offset,
      limit,
      totalBytes: fullText.length,
      hasMore,
      chunk: ctx.redactor.redact(chunk),
    };
  },
});

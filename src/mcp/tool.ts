import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig, type NyxConfig } from "../core/config.ts";
import { NyxError, toNyxError } from "../core/errors.ts";
import { computeRepoId } from "../core/git.ts";
import { createLogger } from "../core/logger.ts";
import { ensureProjectLayout, type NyxProjectLayout } from "../core/paths.ts";
import { generateUlid } from "../core/receipts.ts";
import { Redactor } from "../core/redact.ts";
import { enforceTokenBudget, estimateTokens } from "../core/tokens.ts";
import { StateDb } from "./db/sqlite.ts";

const logger = createLogger("mcp-tool");

export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolExecutionContext {
  projectPath: string;
  repoId: string;
  projectLayout: NyxProjectLayout;
  db: StateDb;
  config: NyxConfig;
  redactor: Redactor;
  callerRole: string;
  nyxHome?: string | undefined;
}

export interface ToolDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: TInput;
  outputSchema: TOutput;
  handler: (input: z.infer<TInput>, ctx: ToolExecutionContext) => Promise<z.infer<TOutput>> | z.infer<TOutput>;
}

export interface McpToolCallResponse {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Budget precedence (BUG: per-role/tool budgets):
 * tool override > caller-role override > global default.
 */
export function resolveToolOutputBudget(
  budgets: NyxConfig["budgets"],
  toolName: string,
  callerRole: string,
): number {
  const toolOverride = budgets.toolOutputOverrides[toolName];
  if (toolOverride !== undefined) {
    return toolOverride;
  }
  const roleOverride = budgets.roleOutputOverrides[callerRole];
  if (roleOverride !== undefined) {
    return roleOverride;
  }
  return budgets.maxToolOutputTokens;
}

export function defineTool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  def: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  if (def.description.length > 200) {
    throw new NyxError(
      "ERR_INVALID_INPUT",
      `Tool "${def.name}" description exceeds 200 characters (${def.description.length} chars)`,
    );
  }
  return def;
}

export function storeOverflowArtifact(
  db: StateDb,
  projectLayout: NyxProjectLayout,
  kind: string,
  content: string,
): string {
  const artifactId = generateUlid();
  const filePath = path.join(projectLayout.artifactsDir, `${artifactId}.txt`);
  fs.mkdirSync(projectLayout.artifactsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  const byteLength = Buffer.byteLength(content, "utf8");
  const tokenEstimate = estimateTokens(content);

  db.withImmediateTransaction(() => {
    db.db
      .prepare(
        `INSERT INTO artifacts (id, kind, file_path, byte_length, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(artifactId, kind, filePath, byteLength, tokenEstimate, new Date().toISOString());
  });

  return artifactId;
}

export interface ExecuteToolOptions {
  defaultProjectPath?: string;
  nyxHome?: string;
  callerRole?: string;
}

export async function createToolContext(
  rawArgs: unknown,
  options: ExecuteToolOptions = {},
): Promise<ToolExecutionContext> {
  const argsObj =
    rawArgs !== null && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};

  const candidatePath =
    (typeof argsObj["worktreePath"] === "string" && argsObj["worktreePath"]) ||
    (typeof argsObj["repoPath"] === "string" && argsObj["repoPath"]) ||
    (typeof argsObj["projectPath"] === "string" && argsObj["projectPath"]) ||
    options.defaultProjectPath ||
    process.env["NYXOWL_PROJECT"] ||
    process.cwd();

  const projectPath = path.resolve(candidatePath);
  const repoId = await computeRepoId(projectPath);
  const nyxHome = options.nyxHome ?? process.env["NYXOWL_HOME"];
  const projectLayout = ensureProjectLayout(repoId, nyxHome);
  const db = new StateDb(projectLayout.stateDbPath);
  const config = loadConfig({
    projectPath,
    ...(nyxHome !== undefined ? { nyxHome } : {}),
  });
  const redactor = Redactor.fromDirectories([projectPath]);
  const callerRole =
    (typeof argsObj["authorRole"] === "string" && argsObj["authorRole"]) ||
    (typeof argsObj["ownerRole"] === "string" && argsObj["ownerRole"]) ||
    (typeof argsObj["callerRole"] === "string" && argsObj["callerRole"]) ||
    options.callerRole ||
    process.env["NYXOWL_ROLE"] ||
    "nyxowl";

  return {
    projectPath,
    repoId,
    projectLayout,
    db,
    config,
    redactor,
    callerRole,
    nyxHome,
  };
}

export async function invokeToolDefinition(
  tool: ToolDefinition,
  rawArgs: unknown,
  options: ExecuteToolOptions = {},
): Promise<McpToolCallResponse> {
  const startMs = Date.now();
  const argsHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(rawArgs ?? {}))
    .digest("hex")
    .slice(0, 16);

  let ctx: ToolExecutionContext | undefined;
  try {
    ctx = await createToolContext(rawArgs, options);

    const parsedInput = tool.inputSchema.safeParse(rawArgs ?? {});
    if (!parsedInput.success) {
      throw new NyxError(
        "ERR_INVALID_INPUT",
        `Invalid arguments for ${tool.name}: ${parsedInput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }

    const rawResult = await tool.handler(parsedInput.data, ctx);
    const validatedOutput = tool.outputSchema.parse(rawResult);
    const redactedOutput = ctx.redactor.redactObject(validatedOutput) as Record<string, unknown>;

    const serialized = JSON.stringify(redactedOutput, null, 2);
    const budget = resolveToolOutputBudget(ctx.config.budgets, tool.name, ctx.callerRole);
    const budgeted = enforceTokenBudget(serialized, budget);

    let finalText = budgeted.text;
    // structuredContent must stay exactly schema-shaped: no _truncated/_overflowArtifactId
    // keys are ever added, so it always validates against the advertised outputSchema.
    const finalStructured: Record<string, unknown> = redactedOutput;

    if (budgeted.truncated && budgeted.overflowText) {
      // Store the FULL original serialized output (not the truncated preview).
      const artifactId = storeOverflowArtifact(ctx.db, ctx.projectLayout, tool.name, serialized);
      finalText = `${budgeted.text}\n... [TRUNCATED: output for "${tool.name}" exceeded its ${budget}-token budget. Full original output is stored under artifactId="${artifactId}". Call nyx_artifact_read with this artifactId to page the missing portion.]`;
    }

    ctx.db.recordAudit({
      toolName: tool.name,
      role: ctx.callerRole,
      argsHash,
      status: "ok",
      durationMs: Date.now() - startMs,
    });

    return {
      content: [{ type: "text", text: finalText }],
      structuredContent: finalStructured,
    };
  } catch (err) {
    const nyxErr = toNyxError(err);
    const durationMs = Date.now() - startMs;
    logger.warn(`Tool ${tool.name} failed with ${nyxErr.code}`, { message: nyxErr.message });

    if (ctx) {
      try {
        ctx.db.recordAudit({
          toolName: tool.name,
          role: ctx.callerRole,
          argsHash,
          status: "error",
          errorCode: nyxErr.code,
          durationMs,
        });
      } catch {
        // Ignore audit failure
      }
    }

    const redactedMsg = ctx ? ctx.redactor.redact(nyxErr.message) : nyxErr.message;
    const errorPayload = {
      error: true,
      code: nyxErr.code,
      message: redactedMsg,
      ...(nyxErr.details ? { details: ctx ? ctx.redactor.redactObject(nyxErr.details) : nyxErr.details } : {}),
    };

    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(errorPayload) }],
      structuredContent: errorPayload,
    };
  } finally {
    ctx?.db.close();
  }
}

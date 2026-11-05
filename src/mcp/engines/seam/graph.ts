import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "../../../core/exec.ts";
import { computeWorkingTreeHash, getHeadCommitHash } from "../../../core/git.ts";
import {
  ensureReceiptKey,
  generateUlid,
  signReceipt,
  type SeamCoverage,
} from "../../../core/receipts.ts";
import { parseDotEnvEntries } from "../../../core/redact.ts";
import { defineTool, storeOverflowArtifact } from "../../tool.ts";
import {
  extractApiEndpoints,
  extractDbAndOrmModels,
  extractEnvReferences,
  extractFrontendApiCalls,
} from "./extractors/index.ts";

export interface SeamMismatch {
  kind: "db-orm-drift" | "api-client-drift" | "api-field-drift" | "env-drift";
  sourceFile: string;
  targetLayer: string;
  message: string;
}

export function routePathMatches(endpointPath: string, callPath: string): boolean {
  const endpointSegments = endpointPath.split("/").filter(Boolean);
  const callSegments = callPath.split("/").filter(Boolean);

  for (let i = 0; i < endpointSegments.length; i++) {
    const endpointSegment = endpointSegments[i];
    if (endpointSegment === "*") return true;
    const callSegment = callSegments[i];
    if (callSegment === undefined) return false;
    if (endpointSegment !== ":param" && endpointSegment !== callSegment) return false;
  }

  return endpointSegments.length === callSegments.length;
}

function walkAllProjectFiles(
  rootDir: string,
  currentDir = rootDir,
  acc: string[] = [],
): string[] {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === ".nyxowl"
    ) {
      continue;
    }
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkAllProjectFiles(rootDir, full, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(rootDir, full));
    }
  }
  return acc;
}

export const seamCheckInputSchema = z.object({
  worktreePath: z.string().min(1),
});

export const seamCheckOutputSchema = z.object({
  status: z.enum(["GREEN", "RED"]),
  coverage: z.enum(["full", "partial", "none"]),
  receiptId: z.string(),
  treeHash: z.string(),
  checkedLayers: z.array(z.string()),
  uncheckedLayers: z.array(z.string()),
  mismatches: z.array(
    z.object({
      kind: z.enum(["db-orm-drift", "api-client-drift", "api-field-drift", "env-drift"]),
      sourceFile: z.string(),
      targetLayer: z.string(),
      message: z.string(),
    }),
  ),
});

export const nyxSeamCheckTool = defineTool({
  name: "nyx_seam_check",
  description: "Diffs the full-stack seam graph (DB migrations <-> ORM <-> API routes <-> frontend client <-> env keys).",
  annotations: {
    title: "Full-Stack Seam Graph Checker",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: seamCheckInputSchema,
  outputSchema: seamCheckOutputSchema,
  handler: async (input, ctx) => {
    const absWt = path.resolve(input.worktreePath);
    const relFiles = fs.existsSync(absWt) ? walkAllProjectFiles(absWt) : [];

    const dbModels = extractDbAndOrmModels(absWt, relFiles);
    const apiEndpoints = extractApiEndpoints(absWt, relFiles);
    const clientCalls = extractFrontendApiCalls(absWt, relFiles);
    const envRefs = extractEnvReferences(absWt, relFiles);

    const mismatches: SeamMismatch[] = [];
    const checkedLayers: string[] = [];
    const uncheckedLayers: string[] = [];

    // 1. DB SQL migrations <-> ORM models seam
    const sqlModels = dbModels.filter((m) => m.source === "sql");
    const ormModels = dbModels.filter((m) => m.source !== "sql");

    if (sqlModels.length > 0 && ormModels.length > 0) {
      checkedLayers.push("db-orm");
      for (const sqlM of sqlModels) {
        const matchingOrm = ormModels.find((o) => o.tableName === sqlM.tableName);
        if (!matchingOrm) {
          mismatches.push({
            kind: "db-orm-drift",
            sourceFile: sqlM.filePath,
            targetLayer: "orm",
            message: `SQL table "${sqlM.tableName}" in ${sqlM.filePath} has no matching ORM model`,
          });
          continue;
        }
        for (const col of sqlM.fields) {
          if (!matchingOrm.fields.has(col)) {
            mismatches.push({
              kind: "db-orm-drift",
              sourceFile: sqlM.filePath,
              targetLayer: matchingOrm.filePath,
              message: `SQL column "${col}" on table "${sqlM.tableName}" is missing from ORM model in ${matchingOrm.filePath}`,
            });
          }
        }
      }
    } else if (dbModels.length > 0) {
      checkedLayers.push("orm-models");
    } else {
      uncheckedLayers.push("db-orm");
    }

    // 2. API routes <-> Frontend client calls seam
    if (apiEndpoints.length > 0 && clientCalls.length > 0) {
      checkedLayers.push("api-client");
      for (const call of clientCalls) {
        const matchedEndpoint =
          apiEndpoints.find((ep) => ep.path === call.path && ep.method === call.method) ??
          apiEndpoints.find(
            (ep) => ep.method === call.method && routePathMatches(ep.path, call.path),
          );
        if (!matchedEndpoint) {
          mismatches.push({
            kind: "api-client-drift",
            sourceFile: `${call.filePath}:${call.line}`,
            targetLayer: "api",
            message: `Frontend calls ${call.method} ${call.path} at ${call.filePath}:${call.line}, but no matching API route exists`,
          });
          continue;
        }
        if (matchedEndpoint.responseFields.size > 0 && call.expectedFields.size > 0) {
          for (const field of call.expectedFields) {
            if (!matchedEndpoint.responseFields.has(field)) {
              mismatches.push({
                kind: "api-field-drift",
                sourceFile: `${call.filePath}:${call.line}`,
                targetLayer: matchedEndpoint.filePath,
                message: `Frontend accesses response field "${field}" from ${call.method} ${call.path}, but API route in ${matchedEndpoint.filePath} returns { ${[...matchedEndpoint.responseFields].join(", ")} }`,
              });
            }
          }
        }
      }
    } else if (apiEndpoints.length > 0) {
      checkedLayers.push("api-routes");
      uncheckedLayers.push("frontend-client");
    } else {
      uncheckedLayers.push("api-client");
    }

    // 3. Env references <-> .env.example / .env seam
    const declaredEnvKeys = new Set<string>();
    let hasEnvManifest = false;
    for (const envFile of [".env.example", ".env.sample", ".env.template", ".env.defaults", ".env"]) {
      const fullEnv = path.join(absWt, envFile);
      if (fs.existsSync(fullEnv)) {
        hasEnvManifest = true;
        for (const kv of parseDotEnvEntries(fs.readFileSync(fullEnv, "utf8"))) {
          declaredEnvKeys.add(kv.key);
        }
      }
    }

    if (hasEnvManifest && envRefs.length > 0) {
      checkedLayers.push("env-keys");
      for (const ref of envRefs) {
        if (!declaredEnvKeys.has(ref.key)) {
          mismatches.push({
            kind: "env-drift",
            sourceFile: `${ref.filePath}:${ref.line}`,
            targetLayer: ".env.example",
            message: `Code references env key "${ref.key}" at ${ref.filePath}:${ref.line}, which is missing from .env / .env.example`,
          });
        }
      }
    } else {
      uncheckedLayers.push("env-keys");
    }

    // Coverage classification (§6 Engine 3)
    const coverage: SeamCoverage =
      checkedLayers.length === 0
        ? "none"
        : uncheckedLayers.length === 0
          ? "full"
          : "partial";

    const status: "GREEN" | "RED" = mismatches.length === 0 ? "GREEN" : "RED";

    const treeHash = await computeWorkingTreeHash(absWt);
    const baseSha = await getHeadCommitHash(absWt);
    const branchRes = await execCommand("git", ["branch", "--show-current"], { cwd: absWt });
    const branch = branchRes.stdout.trim() || "main";

    const evidenceArtifactId = storeOverflowArtifact(
      ctx.db,
      ctx.projectLayout,
      "seam_check",
      JSON.stringify({ status, coverage, checkedLayers, uncheckedLayers, mismatches }, null, 2),
    );

    const key = ensureReceiptKey(ctx.nyxHome);
    const signed = signReceipt(
      {
        id: generateUlid(),
        kind: "seam",
        status,
        coverage,
        worktree: absWt,
        branch,
        treeHash,
        baseSha,
        commandsHash: crypto.createHash("sha256").update("seam:v1").digest("hex"),
        evidenceArtifactId,
        createdAt: new Date().toISOString(),
      },
      key,
    );

    ctx.db.withImmediateTransaction(() => {
      ctx.db.db
        .prepare(
          `INSERT INTO receipts (
             id, kind, status, coverage, worktree, branch, tree_hash, base_sha,
             commands_hash, evidence_artifact_id, na_justification, created_at, hmac
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          signed.id,
          signed.kind,
          signed.status,
          signed.coverage ?? null,
          signed.worktree,
          signed.branch,
          signed.treeHash,
          signed.baseSha,
          signed.commandsHash,
          signed.evidenceArtifactId,
          signed.createdAt,
          signed.hmac,
        );
    });

    return {
      status,
      coverage,
      receiptId: signed.id,
      treeHash,
      checkedLayers,
      uncheckedLayers,
      mismatches,
    };
  },
});

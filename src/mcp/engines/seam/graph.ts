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
import { listSeamFiles } from "./ignore.ts";
import {
  extractApiEndpoints,
  extractDbAndOrmModels,
  extractEnvReferences,
  extractFrontendApiCalls,
  type EnvReference,
} from "./extractors/index.ts";
import {
  detectUnsupportedDbLayers,
  extractDbQueries,
  extractDbRoutines,
  type DbQueryReference,
} from "./extractors/db-queries.ts";
import { extractServerCandidates, serverCandidateSummary } from "./extractors/server-layers.ts";

export interface SeamMismatch {
  kind:
    | "db-orm-drift"
    | "api-client-drift"
    | "api-field-drift"
    | "db-query-drift"
    | "env-drift";
  sourceFile: string;
  targetLayer: string;
  message: string;
}

export interface UnsupportedSeamLayerEntry {
  layer: string;
  reason: string;
}

/** Hard cap on returned mismatches; larger counts are summarized. */
export const MAX_SEAM_MISMATCHES = 50;

/** Max representative files listed per deduplicated env-drift finding. */
const MAX_ENV_REPRESENTATIVE_FILES = 3;

/**
 * Compares client-side DB query references (Supabase/Prisma/Drizzle/raw SQL)
 * against tables and routines parsed from SQL migrations, producing
 * db-query-drift mismatches for references with no migration backing.
 */
export function detectDbQueryMismatches(
  sqlModels: { tableName: string }[],
  dbRoutineNames: ReadonlySet<string>,
  dbQueries: DbQueryReference[],
): SeamMismatch[] {
  const tableNames = new Set(sqlModels.map((model) => model.tableName));
  const mismatches: SeamMismatch[] = [];
  for (const query of dbQueries) {
    if (query.kind === "table" && !tableNames.has(query.ref)) {
      mismatches.push({
        kind: "db-query-drift",
        sourceFile: `${query.filePath}:${query.line}`,
        targetLayer: "sql-migrations",
        message: `${query.driver} query references table "${query.ref}" at ${query.filePath}:${query.line}, but no SQL migration creates table "${query.ref}"`,
      });
    } else if (query.kind === "rpc" && !dbRoutineNames.has(query.ref)) {
      mismatches.push({
        kind: "db-query-drift",
        sourceFile: `${query.filePath}:${query.line}`,
        targetLayer: "sql-migrations",
        message: `${query.driver} call references rpc "${query.ref}" at ${query.filePath}:${query.line}, but no SQL migration creates function/procedure "${query.ref}"`,
      });
    }
  }
  return mismatches;
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

export const seamCheckInputSchema = z.object({
  worktreePath: z.string().min(1),
});

const seamMismatchSchema = z.object({
  kind: z.enum([
    "db-orm-drift",
    "api-client-drift",
    "api-field-drift",
    "db-query-drift",
    "env-drift",
  ]),
  sourceFile: z.string(),
  targetLayer: z.string(),
  message: z.string(),
});

export const seamCheckOutputSchema = z.object({
  status: z.enum(["GREEN", "RED"]),
  coverage: z.enum(["full", "partial", "none"]),
  receiptId: z.string(),
  treeHash: z.string(),
  checkedLayers: z.array(z.string()),
  uncheckedLayers: z.array(z.string()),
  /** Supported-but-unimplemented layers: detected, not cross-checked. */
  unsupportedLayers: z.array(
    z.object({
      layer: z.string(),
      reason: z.string(),
    }),
  ),
  mismatches: z.array(seamMismatchSchema),
  /** Total mismatches found before the output cap was applied. */
  totalMismatches: z.number().int().nonnegative(),
  /** True when mismatches were capped and a summary entry was appended. */
  truncated: z.boolean(),
});

export const nyxSeamCheckTool = defineTool({
  name: "nyx_seam_check",
  description: "Diffs the full-stack seam graph (DB/ORM/API/client/env), ignoring generated build directories.",
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
    const relFiles = await listSeamFiles(absWt);

    const dbModels = extractDbAndOrmModels(absWt, relFiles);
    const apiEndpoints = extractApiEndpoints(absWt, relFiles);
    const clientCalls = extractFrontendApiCalls(absWt, relFiles);
    const envRefs = extractEnvReferences(absWt, relFiles);
    const dbQueries = extractDbQueries(absWt, relFiles);
    const dbRoutineNames = extractDbRoutines(absWt, relFiles);
    const serverCandidates = extractServerCandidates(absWt, relFiles);
    const unsupportedDbLayers = detectUnsupportedDbLayers(absWt, relFiles);
    const pythonOrmDetected = unsupportedDbLayers.some((entry) =>
      entry.reason.startsWith("Python ORM"),
    );
    const unsupportedLayers = [
      ...unsupportedDbLayers,
      ...serverCandidateSummary(serverCandidates),
    ];

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

    // 2. DB client queries (Supabase .from/.rpc, Prisma, Drizzle, raw SQL) <-> SQL migrations seam
    const sqlMigrationsPresent = sqlModels.length > 0 || dbRoutineNames.size > 0;
    if (sqlMigrationsPresent && dbQueries.length > 0) {
      checkedLayers.push("db-query");
      mismatches.push(
        ...detectDbQueryMismatches(sqlModels, dbRoutineNames, dbQueries),
      );
    } else if (dbQueries.length > 0 && !sqlMigrationsPresent && !pythonOrmDetected) {
      // Query layer is present and supported, but there is nothing to verify
      // against (no SQL migrations) — supported-but-uncheckable, not absent.
      unsupportedLayers.push({
        layer: "db-query",
        reason:
          "DB query references detected but no SQL migrations found (no CREATE TABLE / CREATE FUNCTION in .sql files)",
      });
    }
    // With zero extracted query references there is nothing to compare, so the
    // db-query seam adds neither checked nor unchecked layers; if the query
    // layer exists but is invisible to us (e.g. a Python ORM), it is reported
    // as unsupported instead of silently absent.

    // 3. API routes <-> Frontend client calls seam
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

    // 4. Env references <-> .env.example / .env seam
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
      // One finding per env key: deduplicate repeated references and list a
      // small set of representative files so the report stays bounded even
      // when a key is referenced (or bundled into build output) many times.
      const undeclared = new Map<string, EnvReference[]>();
      for (const ref of envRefs) {
        if (declaredEnvKeys.has(ref.key)) continue;
        const bucket = undeclared.get(ref.key);
        if (bucket) bucket.push(ref);
        else undeclared.set(ref.key, [ref]);
      }
      for (const [key, refs] of undeclared) {
        const representatives = refs
          .slice(0, MAX_ENV_REPRESENTATIVE_FILES)
          .map((ref) => `${ref.filePath}:${ref.line}`);
        const remaining = refs.length - representatives.length;
        mismatches.push({
          kind: "env-drift",
          sourceFile: `${refs[0]?.filePath}:${refs[0]?.line}`,
          targetLayer: ".env.example",
          message: `Code references env key "${key}" at ${representatives.join(", ")}${
            remaining > 0 ? ` (+${remaining} more file(s))` : ""
          }, which is missing from .env / .env.example (${refs.length} occurrence(s))`,
        });
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

    // Bound the report: keep the first MAX_SEAM_MISMATCHES findings and append
    // a summary entry carrying the total count when the list was truncated.
    const totalMismatches = mismatches.length;
    const outputMismatches: SeamMismatch[] =
      mismatches.length > MAX_SEAM_MISMATCHES ? mismatches.slice(0, MAX_SEAM_MISMATCHES) : mismatches;
    const truncated = mismatches.length > MAX_SEAM_MISMATCHES;
    if (truncated) {
      const lastKind =
        outputMismatches[outputMismatches.length - 1]?.kind ?? "env-drift";
      outputMismatches.push({
        kind: lastKind,
        sourceFile: "seam-summary",
        targetLayer: "seam-report",
        message: `Seam report truncated: showing first ${MAX_SEAM_MISMATCHES} of ${totalMismatches} mismatches; ${totalMismatches - MAX_SEAM_MISMATCHES} finding(s) omitted. Rerun after fixing the reported findings to see the rest.`,
      });
    }

    const status: "GREEN" | "RED" = mismatches.length === 0 ? "GREEN" : "RED";

    const treeHash = await computeWorkingTreeHash(absWt);
    const baseSha = await getHeadCommitHash(absWt);
    const branchRes = await execCommand("git", ["branch", "--show-current"], { cwd: absWt });
    const branch = branchRes.stdout.trim() || "main";

    const evidenceArtifactId = storeOverflowArtifact(
      ctx.db,
      ctx.projectLayout,
      "seam_check",
      JSON.stringify(
        {
          status,
          coverage,
          checkedLayers,
          uncheckedLayers,
          unsupportedLayers,
          mismatches: outputMismatches,
          totalMismatches,
          truncated,
        },
        null,
        2,
      ),
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
      unsupportedLayers,
      mismatches: outputMismatches,
      totalMismatches,
      truncated,
    };
  },
});

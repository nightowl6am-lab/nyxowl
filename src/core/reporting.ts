import { z } from "zod";

/**
 * subagent-summary-v1 and orchestrator-report-v1 schemas (see
 * schemas/output/*.schema.json). These are the TS runtime counterparts of the
 * shipped JSON Schemas: strict additionalProperties, receipt objects only, and
 * a non-null prUrlOrPath for the orchestrator report.
 */

export const receiptObjSchema = z.strictObject({
  id: z.string().min(1),
  status: z.string().min(1),
});

export const subagentSummarySchema = z.strictObject({
  status: z.enum(["done", "blocked", "failed"]),
  role: z.string().min(1),
  slice: z.string().min(1),
  filesChanged: z.array(z.string()),
  receipts: z.array(receiptObjSchema),
  contractsPublished: z.array(z.string()),
  openIssues: z.array(z.string()),
  nextAction: z.string().min(1),
});

export type SubagentSummary = z.infer<typeof subagentSummarySchema>;

export const orchestratorReportSchema = z.strictObject({
  worktree: z.string().min(1),
  branch: z.string().min(1),
  slicesCompleted: z.array(z.string()),
  receipts: z.array(receiptObjSchema),
  prUrlOrPath: z.string(),
  nextHumanAction: z.string().min(1),
});

export type OrchestratorReport = z.infer<typeof orchestratorReportSchema>;

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; errors: string[] };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

const SUMMARY_REQUIRED_KEYS = Object.keys(subagentSummarySchema.shape) as string[];
const REPORT_REQUIRED_KEYS = Object.keys(orchestratorReportSchema.shape) as string[];

/**
 * Reports extra and missing top-level keys for a candidate record against a
 * required-key list, so callers get actionable feedback instead of opaque
 * "invalid_type" messages.
 */
export function reportMissingOrExtraKeys(
  value: unknown,
  requiredKeys: readonly string[],
): { missing: string[]; extra: string[] } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { missing: [...requiredKeys], extra: [] };
  }
  const present = new Set(Object.keys(value as Record<string, unknown>));
  const missing = requiredKeys.filter((key) => !present.has(key));
  const extra = [...present].filter((key) => !requiredKeys.includes(key));
  if (missing.length === 0 && extra.length === 0) {
    return null;
  }
  return { missing, extra };
}

function formatZodIssues(value: unknown, schema: z.ZodType): string[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<top-level>";
    return `${path}: ${issue.message}`;
  });
}

/**
 * Validates a subagent-summary-v1 payload. Either returns a discriminated
 * result or throws nothing: callers branch on result.ok.
 */
export function validateSubagentSummary(value: unknown): ValidationResult<SubagentSummary> {
  const errors: string[] = [];

  const keyReport = reportMissingOrExtraKeys(value, SUMMARY_REQUIRED_KEYS);
  if (keyReport) {
    if (keyReport.missing.length > 0) {
      errors.push(`missing keys: ${keyReport.missing.join(", ")}`);
    }
    if (keyReport.extra.length > 0) {
      errors.push(`extra keys: ${keyReport.extra.join(", ")}`);
    }
  }

  errors.push(...formatZodIssues(value, subagentSummarySchema));

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  // formatZodIssues already parsed; re-parse once to extract the typed value.
  const typed = subagentSummarySchema.safeParse(value);
  if (!typed.success) {
    return { ok: false, errors: ["invalid subagent-summary-v1 payload"] };
  }
  return { ok: true, value: typed.data };
}

/**
 * Validates an orchestrator-report-v1 payload. Reports must NOT carry a
 * top-level "status" key (that belongs to subagent summaries only).
 */
export function validateOrchestratorReport(
  value: unknown,
): ValidationResult<OrchestratorReport> {
  const errors: string[] = [];

  if (value !== null && typeof value === "object" && !Array.isArray(value) && "status" in (value as Record<string, unknown>)) {
    errors.push('forbidden top-level key "status" in orchestrator-report-v1 (status belongs to subagent-summary-v1)');
  }

  const keyReport = reportMissingOrExtraKeys(value, REPORT_REQUIRED_KEYS);
  if (keyReport) {
    if (keyReport.missing.length > 0) {
      errors.push(`missing keys: ${keyReport.missing.join(", ")}`);
    }
    if (keyReport.extra.length > 0) {
      errors.push(`extra keys: ${keyReport.extra.join(", ")}`);
    }
  }

  errors.push(...formatZodIssues(value, orchestratorReportSchema));

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const typed = orchestratorReportSchema.safeParse(value);
  if (!typed.success) {
    return { ok: false, errors: ["invalid orchestrator-report-v1 payload"] };
  }
  return { ok: true, value: typed.data };
}

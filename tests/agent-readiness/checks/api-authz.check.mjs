/** Static authorization audit for /:id routes (nyx-api readiness fixture). */

const ROUTE = /(?:router|app)\.(?:get|post|put|patch|delete)\(\s*["'`]([^"'`]*\/:id[^"'`]*)["'`]\s*,([\s\S]*?)(?=\n\s*(?:router|app)\.\w+\(|$)/gi;
const SCOPE_PREDICATE = /\b(?:owner|tenant|user\.id|userId|user_id)\b/i;
const ID_LOOKUP = /\b(?:req\.)?params\.id\b|\bfind(?:One|ById|ByPk)\s*\(/i;

export function auditRoutes(source) {
  const findings = [];
  for (const match of String(source).matchAll(ROUTE)) {
    const route = match[1];
    const handler = match[2] ?? "";
    if (ID_LOOKUP.test(handler) && !SCOPE_PREDICATE.test(handler)) {
      findings.push({
        code: "AUTHZ_MISSING_OWNER_SCOPE",
        route,
        detail: "route reads by id without an owner/tenant predicate",
      });
    }
  }
  return findings;
}

export function run(artifact) {
  const findings = Array.isArray(artifact?.findings) ? artifact.findings : [];
  const errors = [];
  if (!findings.some((finding) => finding?.code === "AUTHZ_MISSING_OWNER_SCOPE")) {
    errors.push("missing AUTHZ_MISSING_OWNER_SCOPE finding");
  }
  return { ok: errors.length === 0, errors };
}

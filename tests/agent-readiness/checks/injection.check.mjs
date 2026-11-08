/** Prompt-injection detection wrapper over the real shield engine. */

import { sanitizeUntrustedContent } from "../../../src/mcp/engines/shield/sanitize.ts";

export function scanInjection(text) {
  return sanitizeUntrustedContent(text, "readiness-fixture");
}

export function run(artifact) {
  const errors = [];
  if (Number(artifact?.riskScore) <= 0) errors.push("riskScore must be positive");
  if (!Array.isArray(artifact?.detectedThreats) || artifact.detectedThreats.length === 0) {
    errors.push("detectedThreats must not be empty");
  }
  return { ok: errors.length === 0, errors };
}

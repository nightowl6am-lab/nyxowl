/** Export/import seam symbol comparison (nyx-architect readiness fixture). */

export function findSeamMismatches({ exports, imports }) {
  const exported = new Set(Array.isArray(exports) ? exports : []);
  const imported = Array.isArray(imports) ? imports : [];
  return [...new Set(imported)].filter((symbol) => !exported.has(symbol)).sort();
}

export function run(artifact) {
  const mismatches = Array.isArray(artifact?.mismatches) ? artifact.mismatches : [];
  const errors = [];
  if (!mismatches.includes("applyPatchV2")) {
    errors.push("mismatches must include applyPatchV2");
  }
  return { ok: errors.length === 0, errors };
}

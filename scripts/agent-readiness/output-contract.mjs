/**
 * Dependency-free output-contract validator for the two Nyxowl JSON envelopes.
 *
 * The JSON schemas under schemas/output/ mirror these rules exactly:
 *   - exact top-level keys (additionalProperties: false)
 *   - scalar fields are strings
 *   - list fields are arrays
 *   - every receipt is an exact { id: string, status: string } object
 */

export const OUTPUT_CONTRACT_KEYS = Object.freeze({
  "orchestrator-report-v1": Object.freeze([
    "worktree",
    "branch",
    "slicesCompleted",
    "receipts",
    "prUrlOrPath",
    "nextHumanAction",
  ]),
  "subagent-summary-v1": Object.freeze([
    "status",
    "role",
    "slice",
    "filesChanged",
    "receipts",
    "contractsPublished",
    "openIssues",
    "nextAction",
  ]),
});

const STRING_FIELDS = Object.freeze({
  "orchestrator-report-v1": Object.freeze(["worktree", "branch", "prUrlOrPath", "nextHumanAction"]),
  "subagent-summary-v1": Object.freeze(["status", "role", "slice", "nextAction"]),
});

const ARRAY_FIELDS = Object.freeze({
  "orchestrator-report-v1": Object.freeze(["slicesCompleted", "receipts"]),
  "subagent-summary-v1": Object.freeze([
    "filesChanged",
    "receipts",
    "contractsPublished",
    "openIssues",
  ]),
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReceipts(value, errors) {
  if (!Array.isArray(value)) return;
  value.forEach((receipt, index) => {
    if (!isPlainObject(receipt)) {
      errors.push(`receipts[${index}] must be an object`);
      return;
    }
    const keys = Object.keys(receipt);
    for (const key of keys) {
      if (key !== "id" && key !== "status") {
        errors.push(`receipts[${index}] has unexpected property "${key}"`);
      }
    }
    if (typeof receipt.id !== "string") {
      errors.push(`receipts[${index}].id must be a string`);
    }
    if (typeof receipt.status !== "string") {
      errors.push(`receipts[${index}].status must be a string`);
    }
  });
}

/**
 * @param {"orchestrator-report-v1" | "subagent-summary-v1"} kind
 * @param {unknown} value
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateOutputContract(kind, value) {
  const errors = [];
  const requiredKeys = OUTPUT_CONTRACT_KEYS[kind];
  if (!requiredKeys) {
    return { ok: false, errors: [`unknown output contract kind "${String(kind)}"`] };
  }
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["value must be a JSON object"] };
  }

  for (const key of Object.keys(value)) {
    if (!requiredKeys.includes(key)) {
      errors.push(`unexpected top-level property "${key}"`);
    }
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      errors.push(`missing required property "${key}"`);
    }
  }

  for (const field of STRING_FIELDS[kind]) {
    if (field in value && typeof value[field] !== "string") {
      errors.push(`${field} must be a string`);
    }
  }
  for (const field of ARRAY_FIELDS[kind]) {
    if (field in value && !Array.isArray(value[field])) {
      errors.push(`${field} must be an array`);
    }
  }
  if ("receipts" in value) {
    validateReceipts(value.receipts, errors);
  }

  return { ok: errors.length === 0, errors };
}

/** Golden receipt/report gate for the nyxowl orchestrator fixture. */

import { validateOutputContract } from "../../../scripts/agent-readiness/output-contract.mjs";

export const GOLDEN_ORCHESTRATOR_REPORT = Object.freeze({
  worktree: "/tmp/opencode/readiness/wt-agent-readiness",
  branch: "wt/agent-readiness-all",
  slicesCompleted: ["contract-matrix", "role-fixtures"],
  receipts: [
    { id: "01J0READINESS000000000000001", status: "verified" },
    { id: "01J0READINESS000000000000002", status: "verified" },
  ],
  prUrlOrPath: "local:wt/agent-readiness-all",
  nextHumanAction: "Review and merge the readiness PR.",
});

export function validateReport(value) {
  const contract = validateOutputContract("orchestrator-report-v1", value);
  if (!contract.ok) return contract;
  if (value.receipts.length === 0) {
    return { ok: false, errors: ["receipts must not be empty"] };
  }
  return { ok: true, errors: [] };
}

export function run(artifact) {
  return validateReport(artifact);
}

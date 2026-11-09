import { describe, expect, it } from "vitest";
import {
  reportMissingOrExtraKeys,
  subagentSummarySchema,
  validateOrchestratorReport,
  validateSubagentSummary,
} from "../../src/core/reporting.ts";

const validSummary = {
  status: "done",
  role: "nyx-api",
  slice: "truncation-budgets-reporting",
  filesChanged: ["src/mcp/tool.ts"],
  receipts: [{ id: "rcpt-1", status: "ok" }],
  contractsPublished: [],
  openIssues: [],
  nextAction: "Merge the slice after verify.",
};

const validReport = {
  worktree: "/home/me/.nyxowl/worktrees/repo/slice",
  branch: "nyx/slice",
  slicesCompleted: ["slice-1"],
  receipts: [{ id: "rcpt-1", status: "ok" }],
  prUrlOrPath: "https://example.test/pr/1",
  nextHumanAction: "Review and merge.",
};

describe("subagent-summary-v1 validation", () => {
  it("accepts a valid summary", () => {
    const result = validateSubagentSummary(validSummary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.role).toBe("nyx-api");
      expect(result.value.receipts).toEqual([{ id: "rcpt-1", status: "ok" }]);
    }
  });

  it("rejects an extra key", () => {
    const bad = { ...validSummary, extraKey: 1 };
    const result = validateSubagentSummary(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("extra keys: extraKey");
    }
    expect(subagentSummarySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing keys", () => {
    const bad = { ...validSummary } as Record<string, unknown>;
    delete bad["nextAction"];
    delete bad["openIssues"];
    const result = validateSubagentSummary(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("openIssues");
      expect(result.errors.join(" ")).toContain("nextAction");
    }
  });

  it("rejects non-{id,status} receipts", () => {
    const result = validateSubagentSummary({
      ...validSummary,
      receipts: [{ id: "rcpt-1", extra: "frozen-fewness" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid status", () => {
    const result = validateSubagentSummary({ ...validSummary, status: "sort-of-done" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("status");
    }
  });

  it("rejects a non-object payload", () => {
    expect(validateSubagentSummary(null).ok).toBe(false);
    expect(validateSubagentSummary("ok string").ok).toBe(false);
  });
});

describe("orchestrator-report-v1 validation", () => {
  it("accepts a valid report", () => {
    const result = validateOrchestratorReport(validReport);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prUrlOrPath).toBe("https://example.test/pr/1");
    }
  });

  it("rejects a null prUrlOrPath", () => {
    const result = validateOrchestratorReport({ ...validReport, prUrlOrPath: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("prUrlOrPath");
    }
  });

  it("rejects the forbidden top-level status key", () => {
    const result = validateOrchestratorReport({ ...validReport, status: "done" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain('forbidden top-level key "status"');
    }
  });

  it("rejects receipts that are not {id,status} pairs", () => {
    const result = validateOrchestratorReport({
      ...validReport,
      receipts: [{ id: 1, status: "ok" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects extra keys and reports them", () => {
    const result = validateOrchestratorReport({ ...validReport, budgets: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("budgets");
    }
  });

  it("rejects string-array violations on slicesCompleted", () => {
    const result = validateOrchestratorReport({
      ...validReport,
      slicesCompleted: [1, 2],
    });
    expect(result.ok).toBe(false);
  });
});

describe("reportMissingOrExtraKeys helper", () => {
  it("reports missing and extra keys", () => {
    const report = reportMissingOrExtraKeys(
      { role: "x", noodle: true },
      ["role", "slice", "nextAction"],
    );
    expect(report).toEqual({ missing: ["slice", "nextAction"], extra: ["noodle"] });
  });

  it("returns null for an exact key match", () => {
    expect(
      reportMissingOrExtraKeys({ role: "x", slice: "y", nextAction: "z" }, [
        "role",
        "slice",
        "nextAction",
      ]),
    ).toBeNull();
  });

  it("treats non-objects as all-missing", () => {
    const report = reportMissingOrExtraKeys(null, ["role"]);
    expect(report).toEqual({ missing: ["role"], extra: [] });
  });
});

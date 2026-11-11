import { describe, expect, it } from "vitest";
import { buildHandoffDigest } from "../../src/core/handoff-compress.ts";

const NEXT_ACTION = "Run nyx_verify_slice, then nyx_seam_check, then open the PR.";

function oversizedInput() {
  return {
    completedTask: "Implemented the evidence-integrity slice across receipts, gates, and dispatch.",
    filesChanged: Array.from({ length: 40 }, (_, index) => `src/module-${index}/file.ts`),
    keyDecisions: Array.from(
      { length: 60 },
      (_, index) =>
        `Decision ${index}: chose deterministic compression stage ${index} for subsystem alpha-${index} without dropping the next action.`,
    ),
    nextTask: NEXT_ACTION,
    receipts: Array.from({ length: 30 }, (_, index) => `receipt-${index}`),
    subagentSummary: {
      status: "done",
      role: "nyx-api",
      slice: "evidence-integrity",
      filesChanged: ["src/api.ts"],
      receipts: ["verify"],
      contractsPublished: [],
      openIssues: ["verify coverage is partial"],
      nextAction: "handoff",
    },
  };
}

describe("handoff digest compression", () => {
  it("leaves a within-budget digest unchanged", () => {
    const result = buildHandoffDigest(
      {
        completedTask: "Small change",
        filesChanged: ["src/a.ts"],
        keyDecisions: ["Keep it simple"],
        nextTask: "Review",
        receipts: ["verify"],
      },
      400,
    );
    expect(result.compressed).toBe(false);
    expect(result.originalTokenCount).toBe(result.tokenCount);
    expect(result.digestMarkdown).not.toContain("**Compressed:**");
  });

  it("compresses an oversized digest under budget and keeps the next action", () => {
    const result = buildHandoffDigest(oversizedInput(), 400);
    expect(result.compressed).toBe(true);
    expect(result.tokenCount).toBeLessThanOrEqual(400);
    expect(result.originalTokenCount).toBeGreaterThan(400);
    expect(result.digestMarkdown).toContain("**Next:**");
    expect(result.digestMarkdown).toContain("Run nyx_verify_slice");
    expect(result.digestMarkdown).toContain("**Compressed:** yes");
  });

  it("is deterministic for the same input and budget", () => {
    const first = buildHandoffDigest(oversizedInput(), 400);
    const second = buildHandoffDigest(oversizedInput(), 400);
    expect(second.digestMarkdown).toBe(first.digestMarkdown);
    expect(second.tokenCount).toBe(first.tokenCount);
  });

  it("records what compression changed", () => {
    const result = buildHandoffDigest(oversizedInput(), 400);
    expect(result.compressionNotes.length).toBeGreaterThan(0);
    expect(result.compressionNotes.join(" ")).toMatch(/budget 400/);
  });
});

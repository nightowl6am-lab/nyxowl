import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeFileSkeleton } from "../../src/mcp/engines/bootstrap-navigator/skeleton.ts";

describe("Step 6 Benchmark — Surgical Symbol Skeleton (>= 80% token reduction)", () => {
  it("achieves >= 80% token reduction across the source corpus", () => {
    const corpusFiles = [
      path.resolve("src/core/config.ts"),
      path.resolve("src/core/redact.ts"),
      path.resolve("src/mcp/engines/probe-exploit/slop/rules.ts"),
      path.resolve("src/mcp/engines/probe-exploit/verify.ts"),
      path.resolve("src/mcp/engines/shield/web-fetch.ts"),
    ];

    let totalOriginalTokens = 0;
    let totalSkeletonTokens = 0;

    for (const file of corpusFiles) {
      expect(fs.existsSync(file)).toBe(true);
      const res = computeFileSkeleton(file);
      expect(res.symbols.length).toBeGreaterThan(0);
      totalOriginalTokens += res.originalTokens;
      totalSkeletonTokens += res.skeletonTokens;
    }

    const overallReduction = (1 - totalSkeletonTokens / totalOriginalTokens) * 100;
    expect(overallReduction).toBeGreaterThanOrEqual(80);
  });
});

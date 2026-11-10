import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import {
  nyxVerifySliceTool,
  verifySliceInputSchema,
} from "../../src/mcp/engines/probe-exploit/verify.ts";
import { stopAllSpawnedProcs } from "../../src/mcp/engines/probe-exploit/proc.ts";
import { invokeToolDefinition } from "../../src/mcp/tool.ts";

/** Cross-platform-ish step that actually takes wall time (~25ms) and exits 0. */
const SLOW_OK_STEP = 'node -e "setTimeout(()=>{}, 25)"';

const NO_CODE_STEPS = { typecheck: null, lint: null, test: null, build: null };

interface PerformanceStep {
  id: string;
  ms: number;
  status: "passed" | "failed" | "not-run";
}

interface VerifyResult {
  status: "GREEN" | "RED";
  failedStep: string | null;
  coverage: "full" | "partial" | "none";
  coverageNotes: string[];
  limitations: string[];
  performance: {
    totalMs: number;
    steps: PerformanceStep[];
    budgetMs: number | null;
    overBudget: boolean;
  };
}

describe("nyx_verify_slice — measured performance evidence (operating standard outcome 8)", () => {
  let tmpRoot: string;
  let nyxHome: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-verify-perf-"));
    nyxHome = path.join(tmpRoot, "nyx-home");
  });

  afterEach(() => {
    stopAllSpawnedProcs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function makeGitRepo(name: string): Promise<string> {
    const repoDir = path.join(tmpRoot, name);
    fs.mkdirSync(repoDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: repoDir, throwOnNonZero: true });
    await execCommand("git", ["config", "user.email", "t@nyx.dev"], { cwd: repoDir });
    await execCommand("git", ["config", "user.name", "T"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
    return repoDir;
  }

  async function commitAll(repoDir: string): Promise<void> {
    await execCommand("git", ["add", "-A"], { cwd: repoDir, throwOnNonZero: true });
    await execCommand("git", ["commit", "-m", "fixture"], {
      cwd: repoDir,
      throwOnNonZero: true,
    });
  }

  it("validates performanceBudgetMs bounds (integer 1..3_600_000)", () => {
    const base = { worktreePath: "/tmp/x", sliceId: "s" };
    expect(verifySliceInputSchema.safeParse({ ...base, performanceBudgetMs: 1 }).success).toBe(true);
    expect(
      verifySliceInputSchema.safeParse({ ...base, performanceBudgetMs: 3_600_000 }).success,
    ).toBe(true);
    for (const bad of [0, -5, 3_600_001, 1.5, "100", null]) {
      expect(
        verifySliceInputSchema.safeParse({ ...base, performanceBudgetMs: bad }).success,
      ).toBe(false);
    }
    // Optional: absent is fine.
    expect(verifySliceInputSchema.safeParse(base).success).toBe(true);
  });

  it(
    "measures per-step wall time on GREEN with no budget (budget=not-stated)",
    async () => {
      const repoDir = await makeGitRepo("perf-green");
      await commitAll(repoDir);

      const res = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "perf-green-slice",
          commandsOverride: {
            ...NO_CODE_STEPS,
            typecheck: SLOW_OK_STEP,
            build: SLOW_OK_STEP,
          },
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as unknown as VerifyResult;

      expect(data.status).toBe("GREEN");
      expect(data.failedStep).toBeNull();

      const perf = data.performance;
      expect(perf.budgetMs).toBeNull();
      expect(perf.overBudget).toBe(false);
      // Both configured step ids appear, in canonical order, with non-negative ms.
      expect(perf.steps.map((s) => s.id)).toEqual(["typecheck", "build"]);
      for (const s of perf.steps) {
        expect(s.status).toBe("passed");
        expect(s.ms).toBeGreaterThanOrEqual(0);
      }
      // Total is at least the sum of the measured step times.
      const sum = perf.steps.reduce((acc, s) => acc + s.ms, 0);
      expect(perf.totalMs).toBeGreaterThanOrEqual(sum);

      // The coverage note carries the durations and the not-stated budget.
      const note = data.coverageNotes.find((n) => n.startsWith("configured-step: durations"));
      expect(note).toBeTruthy();
      expect(note!).toContain("typecheck=");
      expect(note!).toContain("build=");
      expect(note!).toContain(`total=${perf.totalMs}ms`);
      expect(note!).toContain("budget=not-stated");
      // No invented budget limitation on the happy path.
      expect(data.limitations.some((l) => l.includes("budget"))).toBe(false);
    },
    30_000,
  );

  it(
    "downgrades full coverage to partial and records the limitation when the budget is exceeded",
    async () => {
      const repoDir = await makeGitRepo("perf-over-budget");
      await commitAll(repoDir);

      const baseInput = {
        worktreePath: repoDir,
        sliceId: "perf-over-budget-slice",
        commandsOverride: {
          ...NO_CODE_STEPS,
          typecheck: SLOW_OK_STEP,
          build: SLOW_OK_STEP,
          e2e: 'node -e "process.exit(0)"',
        },
      };

      // Control: without a budget this run would claim full coverage.
      const control = await invokeToolDefinition(
        nyxVerifySliceTool,
        baseInput,
        { defaultProjectPath: repoDir, nyxHome },
      );
      const controlData = control.structuredContent as unknown as VerifyResult;
      expect(controlData.status).toBe("GREEN");
      expect(controlData.coverage).toBe("full");
      expect(controlData.performance.overBudget).toBe(false);

      // With a 1ms budget the same run is over budget: still GREEN (the owner
      // decides), but full coverage is downgraded to partial.
      const res = await invokeToolDefinition(
        nyxVerifySliceTool,
        { ...baseInput, performanceBudgetMs: 1 },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as unknown as VerifyResult;

      expect(data.status).toBe("GREEN");
      expect(data.failedStep).toBeNull();
      expect(data.performance.budgetMs).toBe(1);
      expect(data.performance.overBudget).toBe(true);
      expect(data.coverage).toBe("partial");
      expect(data.coverage).not.toBe("full");
      // Limitation names measured vs budget.
      expect(
        data.limitations.some(
          (l) =>
            l.includes("budget") &&
            l.includes(`${data.performance.totalMs}ms`) &&
            l.includes("1ms"),
        ),
      ).toBe(true);
      // The durations note states the supplied budget.
      const note = data.coverageNotes.find((n) => n.startsWith("configured-step: durations"));
      expect(note).toBeTruthy();
      expect(note!).toContain("budget=1ms");
    },
    30_000,
  );

  it(
    "reports RED with the failed step status and zero-ms not-run steps",
    async () => {
      const repoDir = await makeGitRepo("perf-red");
      await commitAll(repoDir);

      const res = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "perf-red-slice",
          commandsOverride: {
            ...NO_CODE_STEPS,
            lint: 'node -e "process.exit(1)"',
            test: SLOW_OK_STEP,
          },
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as unknown as VerifyResult;

      expect(data.status).toBe("RED");
      expect(data.failedStep).toBe("lint");

      const perf = data.performance;
      expect(perf.overBudget).toBe(false);
      expect(perf.budgetMs).toBeNull();
      const lint = perf.steps.find((s) => s.id === "lint");
      expect(lint).toBeTruthy();
      expect(lint!.status).toBe("failed");
      expect(lint!.ms).toBeGreaterThanOrEqual(0);
      // The short-circuited step never ran: not-run with no measured time.
      const test = perf.steps.find((s) => s.id === "test");
      expect(test).toBeTruthy();
      expect(test!.status).toBe("not-run");
      expect(test!.ms).toBe(0);

      // The durations note is present on the RED path too.
      const note = data.coverageNotes.find((n) => n.startsWith("configured-step: durations"));
      expect(note).toBeTruthy();
      expect(note!).toContain("lint=");
      expect(note!).toContain("test=");
    },
    30_000,
  );
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import { nyxVerifySliceTool } from "../../src/mcp/engines/probe-exploit/verify.ts";
import { invokeToolDefinition } from "../../src/mcp/tool.ts";

const NO_CODE_STEPS = { typecheck: null, lint: null, test: null, build: null };
const OK_STEP = 'node -e "process.exit(0)"';

interface VerifyData {
  status: "GREEN" | "RED";
  coverage: "full" | "partial" | "none";
  scope: "full" | "narrowed" | "not-applicable";
  failureClass: "none" | "config" | "environment" | "code";
  failureEvidence: string[];
  coverageNotes: string[];
  limitations: string[];
  preflight: {
    scope: string;
    selection: string[];
    steps: Array<{ step: string; command: string; timeoutMs: number; prerequisites: unknown[] }>;
    blocked: Array<{ step: string; class: string; reason: string }>;
  };
}

describe("nyx_verify_slice preflight, scope, and failure classification", () => {
  let tmpRoot: string;
  let nyxHome: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-verify-preflight-"));
    nyxHome = path.join(tmpRoot, "nyx-home");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function makeRepo(name: string): Promise<string> {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: dir, throwOnNonZero: true });
    await execCommand("git", ["config", "user.email", "t@nyx.dev"], { cwd: dir });
    await execCommand("git", ["config", "user.name", "T"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
    await execCommand("git", ["add", "-A"], { cwd: dir, throwOnNonZero: true });
    await execCommand("git", ["commit", "-m", "fixture"], { cwd: dir, throwOnNonZero: true });
    return dir;
  }

  function writeVerifyConfig(dir: string, verify: Record<string, unknown>): void {
    const configDir = path.join(dir, ".nyxowl");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ version: 1, verify }, null, 2),
    );
  }

  it("records a resolved preflight plan before executing", async () => {
    const dir = await makeRepo("plan");
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "plan",
        commandsOverride: { ...NO_CODE_STEPS, typecheck: OK_STEP, build: OK_STEP },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as unknown as VerifyData;
    expect(data.status).toBe("GREEN");
    expect(data.preflight.scope).toBe("full");
    expect(data.preflight.selection).toEqual(["typecheck", "build"]);
    expect(data.preflight.steps.map((step) => step.step)).toEqual(["typecheck", "build"]);
    for (const step of data.preflight.steps) {
      expect(step.command.length).toBeGreaterThan(0);
      expect(step.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("never reports full coverage for an explicitly narrowed run", async () => {
    const dir = await makeRepo("narrowed");
    writeVerifyConfig(dir, { scope: "narrowed", scopeSteps: ["typecheck"] });
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "narrowed",
        commandsOverride: {
          ...NO_CODE_STEPS,
          typecheck: OK_STEP,
          e2e: OK_STEP,
        },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as unknown as VerifyData;
    expect(data.status).toBe("GREEN");
    expect(data.scope).toBe("narrowed");
    expect(data.coverage).toBe("partial");
    expect(data.coverageNotes.join("\n")).toContain("scope:narrowed");
    expect(data.coverageNotes.join("\n")).toContain("typecheck");
    expect(data.limitations.join("\n")).toContain("not full verification");
  });

  it("fails closed when a narrowed scope selects zero steps", async () => {
    const dir = await makeRepo("narrowed-empty");
    writeVerifyConfig(dir, { scope: "narrowed", scopeSteps: [] });
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "narrowed-empty",
        commandsOverride: { ...NO_CODE_STEPS, typecheck: OK_STEP },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { code: string }).code).toBe("ERR_VERIFY_PRECONDITION");
  });

  it("fails closed before executing when a package script is missing", async () => {
    const dir = await makeRepo("missing-script");
    const marker = path.join(dir, "executed.marker");
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "missing-script",
        commandsOverride: {
          ...NO_CODE_STEPS,
          typecheck: `npm run definitely-missing-script && touch ${marker}`,
        },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { code: string }).code).toBe("ERR_VERIFY_PRECONDITION");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("turns a state mismatch into ERR_ENV_STATE_MISMATCH, not a code failure", async () => {
    const dir = await makeRepo("state-mismatch");
    writeVerifyConfig(dir, { state: { requirePaths: ["seeded.state"] } });
    const missing = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "state-mismatch",
        commandsOverride: { ...NO_CODE_STEPS, typecheck: OK_STEP },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(missing.isError).toBe(true);
    expect((missing.structuredContent as { code: string }).code).toBe(
      "ERR_ENV_STATE_MISMATCH",
    );

    const dir2 = await makeRepo("state-mismatch-forbidden");
    fs.writeFileSync(path.join(dir2, "stale.state"), "old\n");
    writeVerifyConfig(dir2, { state: { forbidPaths: ["stale.state"] } });
    const forbidden = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir2,
        sliceId: "state-mismatch-forbidden",
        commandsOverride: { ...NO_CODE_STEPS, typecheck: OK_STEP },
      },
      { defaultProjectPath: dir2, nyxHome },
    );
    expect(forbidden.isError).toBe(true);
    expect((forbidden.structuredContent as { code: string }).code).toBe(
      "ERR_ENV_STATE_MISMATCH",
    );
  });

  it("runs when declared state preconditions are met", async () => {
    const dir = await makeRepo("state-met");
    fs.writeFileSync(path.join(dir, "seeded.state"), "ready\n");
    writeVerifyConfig(dir, {
      state: { requirePaths: ["seeded.state"], forbidPaths: ["stale.state"] },
    });
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "state-met",
        commandsOverride: { ...NO_CODE_STEPS, typecheck: OK_STEP },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as unknown as VerifyData).status).toBe("GREEN");
  });

  it("classifies a missing command as an environment failure", async () => {
    const dir = await makeRepo("class-environment");
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "class-environment",
        commandsOverride: { ...NO_CODE_STEPS, typecheck: "nyx-definitely-missing-command" },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as unknown as VerifyData;
    expect(data.status).toBe("RED");
    expect(data.failureClass).toBe("environment");
    expect(data.failureEvidence.join(" ")).toContain("exitCode=127");
    expect(data.limitations.join("\n")).toContain("failure classification: environment");
  });

  it("classifies an intentional non-zero test command as a code failure", async () => {
    const dir = await makeRepo("class-code");
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "class-code",
        commandsOverride: {
          ...NO_CODE_STEPS,
          test: 'node -e "process.exit(1)"',
        },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as unknown as VerifyData;
    expect(data.status).toBe("RED");
    expect(data.failureClass).toBe("code");
  });

  it("fails closed when an estimated duration exceeds the configured limit", async () => {
    const dir = await makeRepo("duration-limit");
    writeVerifyConfig(dir, { maxStepDurationMs: 1 });
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      {
        worktreePath: dir,
        sliceId: "duration-limit",
        commandsOverride: { ...NO_CODE_STEPS, build: OK_STEP },
      },
      { defaultProjectPath: dir, nyxHome },
    );
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { code: string }).code).toBe("ERR_VERIFY_PRECONDITION");
  });
});

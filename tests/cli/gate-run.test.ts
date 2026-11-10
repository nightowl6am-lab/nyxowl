import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGateRunCli, type GateRunDeps } from "../../src/cli/gate-run.ts";
import { writeServerRuntimeMarker } from "../../src/core/server-runtime.ts";
import { ALL_NYX_TOOLS } from "../../src/mcp/server.ts";

const HEAD_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const ENTRY_MTIME = 3_000;
const SOURCE_MTIME = 1_000;
const HEAD_MTIME = 500;

let tmpRoot: string;
let nyxHome: string;
let worktree: string;
let entryPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-gate-run-"));
  nyxHome = path.join(tmpRoot, "home");
  worktree = path.join(tmpRoot, "worktree");
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "index.ts"), "export const x = 1;\n", "utf8");
  entryPath = path.join(tmpRoot, "dist", "cli", "index.js");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "// compiled entry\n", "utf8");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDeps(): GateRunDeps {
  return {
    nyxHome,
    entryPath,
    getEntryMtimeMs: () => ENTRY_MTIME,
    getSourceLatestMtimeMs: () => SOURCE_MTIME,
    resolveGitState: async () => ({ head: HEAD_SHA, tree: TREE_SHA, headTimeMs: HEAD_MTIME }),
  };
}

function writeFreshMarker(overrides: { toolCount?: number; entryPath?: string } = {}): void {
  writeServerRuntimeMarker(
    {
      pid: process.pid,
      version: "1.0.0",
      toolCount: overrides.toolCount ?? ALL_NYX_TOOLS.length,
      entryPath: overrides.entryPath ?? entryPath,
      startedAt: new Date().toISOString(),
      projectPath: worktree,
    },
    nyxHome,
  );
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

interface InfoPayload {
  version: string;
  toolCount: number;
  entryPath: string;
  marker: { toolCount: number; entryPath: string } | null;
  worktreeHead: string | null;
  worktreeTree: string | null;
  distMtimeMs: number | null;
  sourceLatestMtimeMs: number | null;
  stale: boolean;
  staleReasons: string[];
}

interface ToolPayload {
  tool: string;
  isError: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown> | null;
}

describe("gate-run --info", () => {
  it("exits 0 and reports fresh for a matching marker and build", async () => {
    writeFreshMarker();

    const res = await runGateRunCli(["--info", "--worktree", worktree], makeDeps());

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    const info = parseJson<InfoPayload>(res.stdout);
    expect(info.stale).toBe(false);
    expect(info.staleReasons).toEqual([]);
    expect(info.version).toBeTruthy();
    expect(info.toolCount).toBe(ALL_NYX_TOOLS.length);
    expect(info.entryPath).toBe(entryPath);
    expect(info.marker?.entryPath).toBe(entryPath);
    expect(info.worktreeHead).toBe(HEAD_SHA);
    expect(info.worktreeTree).toBe(TREE_SHA);
    expect(info.distMtimeMs).toBe(ENTRY_MTIME);
    expect(info.sourceLatestMtimeMs).toBe(SOURCE_MTIME);
  });

  it("exits 1 for a stale build and names the reasons", async () => {
    writeFreshMarker({ toolCount: ALL_NYX_TOOLS.length - 1 });

    const res = await runGateRunCli(["--info", "--worktree", worktree], makeDeps());

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("stale");
    const info = parseJson<InfoPayload>(res.stdout);
    expect(info.stale).toBe(true);
    expect(info.staleReasons.join(" ")).toContain("tool count");
  });

  it("exits 0 under --allow-stale while still reporting stale=true", async () => {
    const res = await runGateRunCli(
      ["--info", "--allow-stale", "--worktree", worktree],
      makeDeps(),
    );

    expect(res.exitCode).toBe(0);
    const info = parseJson<InfoPayload>(res.stdout);
    expect(info.stale).toBe(true);
    expect(info.staleReasons).toContain("runtime marker missing");
  });
});

describe("gate-run --tool", () => {
  it("invokes nyx_model_preflight in-process and prints the resolved model", async () => {
    const res = await runGateRunCli(
      [
        "--tool",
        "nyx_model_preflight",
        "--args",
        '{"role":"nyx-api"}',
        "--worktree",
        worktree,
      ],
      makeDeps(),
    );

    expect(res.exitCode).toBe(0);
    const payload = parseJson<ToolPayload>(res.stdout);
    expect(payload.tool).toBe("nyx_model_preflight");
    expect(payload.isError).toBe(false);
    expect(payload.structuredContent?.["resolved"]).toBe("opencode-go/glm-5.3-flash#high");
  });

  it("warn-but-runs on a stale build by default", async () => {
    const res = await runGateRunCli(
      ["--tool", "nyx_model_preflight", "--args", '{"role":"nyx-probe"}', "--worktree", worktree],
      makeDeps(),
    );

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("stale");
    const payload = parseJson<ToolPayload>(res.stdout);
    expect(payload.structuredContent?.["resolved"]).toBe("opencode-go/glm-5.3-flash#high");
  });

  it("refuses to run with --require-fresh when the build is stale", async () => {
    const res = await runGateRunCli(
      [
        "--tool",
        "nyx_model_preflight",
        "--args",
        '{"role":"nyx-api"}',
        "--require-fresh",
        "--worktree",
        worktree,
      ],
      makeDeps(),
    );

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Refusing to run");
    expect(res.stderr).toContain("runtime marker missing");
  });

  it("exits 1 for an unknown tool", async () => {
    const res = await runGateRunCli(
      ["--tool", "nyx_not_a_tool", "--worktree", worktree],
      makeDeps(),
    );

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Unknown Nyxowl tool "nyx_not_a_tool"');
  });
});

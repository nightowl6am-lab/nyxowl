import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { invokeToolDefinition, type ToolDefinition } from "../../src/mcp/tool.ts";
import { bootstrapNavigatorEngineTools } from "../../src/mcp/engines/bootstrap-navigator/index.ts";
import { blackboardEngineTools } from "../../src/mcp/engines/blackboard/index.ts";
import { contextEngineTools } from "../../src/mcp/engines/context/index.ts";
import { probeExploitEngineTools } from "../../src/mcp/engines/probe-exploit/index.ts";
import { seamEngineTools } from "../../src/mcp/engines/seam/index.ts";
import { shieldEngineTools } from "../../src/mcp/engines/shield/index.ts";
import { testwriterEngineTools } from "../../src/mcp/engines/testwriter/index.ts";
import { worktreeSliceEngineTools } from "../../src/mcp/engines/worktree-slice/index.ts";
import { EXPECTED_AGENTS, EXPECTED_NYX_TOOL_NAMES } from "./expected.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_DIR = path.join(ROOT, "tests", "agent-readiness", "base");
const FIXTURES_DIR = path.join(ROOT, "tests", "agent-readiness", "fixtures");

interface Fixture {
  agent: string;
  expectedNyTools: string[];
}

const TOOL_MAP = new Map<string, ToolDefinition>(
  [
    ...bootstrapNavigatorEngineTools,
    ...blackboardEngineTools,
    ...contextEngineTools,
    ...probeExploitEngineTools,
    ...seamEngineTools,
    ...shieldEngineTools,
    ...testwriterEngineTools,
    ...worktreeSliceEngineTools,
  ].map((tool) => [tool.name, tool]),
);

const SLOT_FILES: Record<string, string> = {
  "nyx-architect": "src/applyPatch.ts",
  "nyx-designer": "src/component.tsx",
  "nyx-api": "src/routes.ts",
  "nyx-ui": "src/component.tsx",
};

const TRACE_SYMBOLS: Record<string, string> = {
  "nyx-api": "router",
  "nyx-db": "rollbackPlan",
  "nyx-probe": "flakyValue",
};

let tmpRoot = "";
let repoDir = "";
let nyxHome = "";
let server: http.Server | undefined;
let baseUrl = "";
const savedEnv: Record<string, string | undefined> = {};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nyxowl Readiness",
      GIT_AUTHOR_EMAIL: "readiness@example.com",
      GIT_COMMITTER_NAME: "Nyxowl Readiness",
      GIT_COMMITTER_EMAIL: "readiness@example.com",
    },
  });
}

function readFixture(agentId: string): Fixture {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, `${agentId}.json`), "utf8"),
  ) as Fixture;
}

function argsFor(agentId: string, toolName: string): Record<string, unknown> {
  switch (toolName) {
    case "context_hydrate":
      return { repoPath: repoDir };
    case "dna_get":
      return { repoPath: repoDir };
    case "sanitize_untrusted":
      return {
        content: fs.readFileSync(path.join(BASE_DIR, "fixtures", "injection.txt"), "utf8").trim(),
        sourceUrl: "fixture:injection",
      };
    case "blackboard_read":
      return { category: "product", repoPath: repoDir };
    case "symbol_skeleton":
      return { filePath: path.join(repoDir, SLOT_FILES[agentId] ?? "src/applyPatch.ts"), repoPath: repoDir };
    case "trace_symbol":
      return { symbolName: TRACE_SYMBOLS[agentId] ?? "router", repoPath: repoDir };
    case "seam_check":
      return { worktreePath: repoDir };
    case "env_inspect":
      return { worktreePath: repoDir };
    case "debug_isolate":
      return {
        stackTraceOrError: fs.readFileSync(path.join(BASE_DIR, "stacktrace.txt"), "utf8").trim(),
        worktreePath: repoDir,
      };
    case "worktree_manage":
      return { action: "list", repoPath: repoDir };
    case "slop_check":
      return { worktreePath: repoDir, scope: "full" };
    case "exploit_probe":
      return {
        targetUrlOrHandler: `${baseUrl}/invoices/1`,
        worktreePath: repoDir,
        vectors: ["authz-idor"],
      };
    case "testwriter_job":
      return { jobId: "READINESS-BOGUS-000" };
    default:
      throw new Error(`no conformance args for ${toolName}`);
  }
}

describe("agent readiness: in-process tool conformance", () => {
  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-conformance-"));
    repoDir = path.join(tmpRoot, "repo");
    nyxHome = path.join(tmpRoot, "nyxowl-home");
    fs.cpSync(BASE_DIR, repoDir, { recursive: true });
    git(["init", "-q"], repoDir);
    git(["add", "-A"], repoDir);
    git(["commit", "-qm", "fixture"], repoDir);

    savedEnv["NYXOWL_HOME"] = process.env["NYXOWL_HOME"];
    savedEnv["TW_INSTALL_ROOT"] = process.env["TW_INSTALL_ROOT"];
    savedEnv["TW_WORKSPACE_ROOT"] = process.env["TW_WORKSPACE_ROOT"];
    process.env["NYXOWL_HOME"] = nyxHome;
    process.env["TW_INSTALL_ROOT"] = path.join(nyxHome, "test-writer");
    process.env["TW_WORKSPACE_ROOT"] = path.join(tmpRoot, "tw-jobs");

    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "1", owner_id: "another-tenant", total_cents: 4200 }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("loopback fixture server did not bind a port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    for (const key of ["NYXOWL_HOME", "TW_INSTALL_ROOT", "TW_WORKSPACE_ROOT"]) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("schema-verifies all 38 tools without executing them", () => {
    expect(TOOL_MAP.size).toBe(38);
    const names = [...TOOL_MAP.keys()].map((name) =>
      name.startsWith("nyx_") ? name.slice("nyx_".length) : name,
    );
    expect([...names].sort()).toEqual([...EXPECTED_NYX_TOOL_NAMES].sort());
    for (const tool of TOOL_MAP.values()) {
      expect(typeof tool.handler, `${tool.name} handler`).toBe("function");
      expect(z.toJSONSchema(tool.inputSchema).type, `${tool.name} input schema`).toBe("object");
    }
  });

  it("executes only the 13 fixture-expected tools with their prompt shapes", async () => {
    for (const expected of EXPECTED_AGENTS) {
      const fixture = readFixture(expected.id);
      for (const toolName of fixture.expectedNyTools) {
        const tool = TOOL_MAP.get(`nyx_${toolName}`);
        expect(tool, `${expected.id}: missing tool nyx_${toolName}`).toBeDefined();
        if (!tool) continue;
        const result = await invokeToolDefinition(tool, argsFor(expected.id, toolName), {
          nyxHome,
          defaultProjectPath: repoDir,
          callerRole: expected.id,
        });
        if (toolName === "testwriter_job") {
          expect(result.isError, `${expected.id}: testwriter_job must fail closed`).toBe(true);
          expect(result.structuredContent?.["error"]).toBe(true);
          expect(typeof result.structuredContent?.["code"]).toBe("string");
          continue;
        }
        expect(
          result.isError,
          `${expected.id}/${toolName}: ${JSON.stringify(result.structuredContent)}`,
        ).toBeFalsy();
        expect(result.structuredContent, `${expected.id}/${toolName} structured output`).toBeTypeOf(
          "object",
        );
      }
    }
  });
});

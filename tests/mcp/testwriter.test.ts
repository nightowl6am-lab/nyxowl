import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAndCompileAgentFile, ROLE_ALLOWED_NYX_TOOLS } from "../../src/cli/compiler.ts";
import { generateOpenCodeHostPackage } from "../../src/cli/adapters/opencode.ts";
import { ALL_NYX_TOOLS, createNyxMcpServer } from "../../src/mcp/server.ts";
import { nyxTestwriterPrepareTool } from "../../src/mcp/engines/testwriter/tools.ts";
import { createToolContext } from "../../src/mcp/tool.ts";
import {
  buildWrapperArgv,
  installRoot,
  normalizeJobInputs,
  runProcess,
  runWrapperJson,
  runWrapperText,
  sanitizeFeedback,
  sha256Text,
  stagedTestPath,
  validateJobId,
  wrapperPath,
  workspaceRoot,
} from "../../src/mcp/engines/testwriter/broker.ts";

const spawnControl = vi.hoisted(() => ({
  calls: [] as unknown[][],
  handler: null as null | ((args: unknown[]) => unknown),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnControl.calls.push(args);
      if (spawnControl.handler) {
        const mocked = spawnControl.handler(args);
        if (mocked) return mocked;
      }
      return (actual.spawn as (...a: unknown[]) => ChildProcess)(...args);
    },
  };
});

function brokerCalls(): unknown[][] {
  return spawnControl.calls.filter((args) => {
    const executable = String(args[0] ?? "");
    const name = path.basename(executable);
    return name === "tw-status" || name === "tw-gate" || name === "tw-new-job";
  });
}

function brokerSpawnCount(): number {
  return brokerCalls().length;
}

function installWrapper(root: string, name: string, mode: number): string {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, name);
  fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode });
  fs.chmodSync(target, mode);
  return target;
}

function capturedArgv(callIndex: number): string[] {
  const call = brokerCalls()[callIndex];
  if (!call) return [];
  const executable = String(call[0] ?? "");
  const rest = (call[1] ?? []) as string[];
  return [executable, ...rest];
}

function fakeChildProcess(stdout: string, stderr: string, code: number): ChildProcess {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  const out = new EventEmitter();
  const err = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & {
    write: () => boolean;
    end: () => void;
  };
  stdin.write = () => true;
  stdin.end = () => {
    // No-op: the fake wrapper already produced its output.
  };

  child.stdout = out as unknown as ChildProcess["stdout"];
  child.stderr = err as unknown as ChildProcess["stderr"];
  child.stdin = stdin as unknown as ChildProcess["stdin"];
  child.kill = () => true;

  setImmediate(() => {
    if (stdout.length > 0) out.emit("data", Buffer.from(stdout, "utf8"));
    if (stderr.length > 0) err.emit("data", Buffer.from(stderr, "utf8"));
    child.emit("close", code);
  });

  return child;
}

describe("Test-Writer broker and tools", () => {
  let tmpRoot: string;
  let nyxHome: string;
  let repoPath: string;
  let client: Client;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-testwriter-"));
    nyxHome = path.join(tmpRoot, "home");
    repoPath = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    spawnControl.calls = [];
    spawnControl.handler = null;
    vi.stubEnv("TW_WORKSPACE_ROOT", path.join(tmpRoot, "tw-jobs"));

    const server = createNyxMcpServer({ defaultProjectPath: repoPath, nyxHome });
    client = new Client({ name: "nyx-testwriter-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    spawnControl.handler = null;
    await client.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("validates job ids and confines staged tests to the workspace", () => {
    expect(validateJobId("J1")).toBe("J1");
    expect(() => validateJobId("../J1")).toThrow(/Invalid Test-Writer job id/);
    expect(() => validateJobId("")).toThrow(/Invalid Test-Writer job id/);
    expect(() => validateJobId("A".repeat(41))).toThrow(/Invalid Test-Writer job id/);

    const staged = stagedTestPath("J1");
    expect(staged.startsWith(path.join(tmpRoot, "tw-jobs"))).toBe(true);
    expect(staged.endsWith(path.join("tests", "test_J1.py"))).toBe(true);
  });

  it("builds a direct wrapper argv with no caller-controlled executable", () => {
    const install = path.join(tmpRoot, "install");
    vi.stubEnv("TW_INSTALL_ROOT", install);
    expect(buildWrapperArgv("gate", ["J1"])).toEqual([
      path.join(install, "bin", "tw-gate"),
      "J1",
    ]);
  });

  it("sanitizes grader feedback to the known key set and strips nested forbidden data", () => {
    const sanitized = sanitizeFeedback({
      verdict: "PROVEN",
      reason: "detector_fails_vulnerable_passes_fixed",
      hint: "hint text",
      counts: { passed: 1 },
      stdout: "raw",
      stderr: "raw",
      canary: "secret",
      variant: "v1",
      mutant: "m1",
      test_traceback: "trace",
      nested_safe: { canary: "nested-secret" },
      unknown_key: "drop me",
    });

    expect(sanitized).toMatchObject({
      verdict: "PROVEN",
      reason: "detector_fails_vulnerable_passes_fixed",
      hint: "hint text",
      counts: { passed: 1 },
    });
    expect(sanitized).not.toHaveProperty("stdout");
    expect(sanitized).not.toHaveProperty("stderr");
    expect(sanitized).not.toHaveProperty("canary");
    expect(sanitized).not.toHaveProperty("variant");
    expect(sanitized).not.toHaveProperty("mutant");
    expect(sanitized).not.toHaveProperty("unknown_key");
    expect(JSON.stringify(sanitized)).not.toContain("nested-secret");
  });

  it("normalizes applicability for stack, status, and approved Python jobs", () => {
    const node = normalizeJobInputs({ status: "approved", targetStack: "node" });
    expect(node.applicable).toBe(false);
    expect(node.reason).toBe("UNSUPPORTED_STACK");

    const closed = normalizeJobInputs({ status: "closed", targetStack: "python" });
    expect(closed.applicable).toBe(false);
    expect(closed.reason).toBe("JOB_CLOSED");

    const approved = normalizeJobInputs({ status: "approved", targetStack: "python" });
    expect(approved.applicable).toBe(true);
    expect(approved.reason).toBeNull();
  });

  it("registers all seven Test-Writer tools and compiles exact per-role scopes", async () => {
    const names = ALL_NYX_TOOLS.map((tool) => tool.name);
    expect(ALL_NYX_TOOLS.length).toBe(38);
    for (const name of [
      "nyx_testwriter_job",
      "nyx_testwriter_write",
      "nyx_testwriter_lint",
      "nyx_testwriter_gate",
      "nyx_testwriter_finish",
      "nyx_testwriter_status",
      "nyx_testwriter_prepare",
    ]) {
      expect(names).toContain(name);
    }

    const list = await client.listTools();
    for (const tool of list.tools) {
      expect(tool.description!.length).toBeLessThanOrEqual(200);
    }

    const agent = parseAndCompileAgentFile({
      filePath: path.join(process.cwd(), "agents", "subagents", "nyx-testwriter.md"),
      maxPromptTokens: 1200,
      pkgRoot: process.cwd(),
    });
    expect(agent.contract.host_tools).toEqual({
      read: "deny",
      edit: "deny",
      write: "deny",
      bash: "deny",
      webfetch: "deny",
    });
    expect(agent.contract.nyx_tools).toEqual([
      "testwriter_job",
      "testwriter_write",
      "testwriter_lint",
      "testwriter_gate",
      "testwriter_finish",
    ]);
    expect(agent.skillLoaded).toBe(false);
    expect(agent.skillPath.endsWith(path.join("nyx-testwriter", "SKILL.md"))).toBe(true);
    expect(ROLE_ALLOWED_NYX_TOOLS["nyxowl"]).toContain("testwriter_prepare");
    expect(ROLE_ALLOWED_NYX_TOOLS["nyxowl"]).toContain("testwriter_status");
  });

  it("fails closed with ERR_TESTWRITER_UNAVAILABLE before spawning when the runtime is absent", async () => {
    const emptyInstall = path.join(tmpRoot, "empty-install");
    fs.mkdirSync(emptyInstall, { recursive: true });
    vi.stubEnv("TW_INSTALL_ROOT", emptyInstall);

    const res = await client.callTool({
      name: "nyx_testwriter_job",
      arguments: { jobId: "J1" },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { code: string }).code).toBe("ERR_TESTWRITER_UNAVAILABLE");
    expect((res.structuredContent as { message: string }).message).toMatch(/install/i);
    expect(brokerSpawnCount()).toBe(0);
  });

  it("rejects invalid prepare refs and specs missing required headings before the broker", async () => {
    const badRefs = await client.callTool({
      name: "nyx_testwriter_prepare",
      arguments: {
        jobId: "J2",
        repoPath,
        vulnerableRef: "not-a-sha",
        patchedRef: "1".repeat(40),
        module: "pkg.module",
        function: "check",
        fixOrigin: "upstream",
        specMarkdown: "## Claim\nBENIGN: ok\n",
      },
    });
    expect(badRefs.isError).toBe(true);
    expect((badRefs.structuredContent as { code: string }).code).toBe("ERR_INVALID_INPUT");

    const missingHeading = await client.callTool({
      name: "nyx_testwriter_prepare",
      arguments: {
        jobId: "J2",
        repoPath,
        vulnerableRef: "a".repeat(40),
        patchedRef: "b".repeat(40),
        module: "pkg.module",
        function: "check",
        fixOrigin: "upstream",
        specMarkdown: "## Claim\nBENIGN: ok\n",
      },
    });
    expect(missingHeading.isError).toBe(true);
    expect((missingHeading.structuredContent as { code: string }).code).toBe("ERR_INVALID_INPUT");
    expect(brokerSpawnCount()).toBe(0);
  });

  it("rejects oversized staged content and path-traversal job ids before the runtime", async () => {
    const oversized = await client.callTool({
      name: "nyx_testwriter_write",
      arguments: { jobId: "J3", content: "a".repeat(51201) },
    });
    expect(oversized.isError).toBe(true);
    expect((oversized.structuredContent as { code: string }).code).toBe("ERR_FILE_TOO_LARGE");

    const traversal = await client.callTool({
      name: "nyx_testwriter_status",
      arguments: { jobId: "../J3" },
    });
    expect(traversal.isError).toBe(true);
    expect((traversal.structuredContent as { code: string }).code).toBe("ERR_INVALID_INPUT");
    expect(brokerSpawnCount()).toBe(0);
  });

  it("never returns broker stdout, stderr, canary, variant, or mutant fields", async () => {
    const wrapperRoot = path.join(tmpRoot, "mock-install");
    fs.mkdirSync(path.join(wrapperRoot, "bin"), { recursive: true });
    fs.writeFileSync(path.join(wrapperRoot, "bin", "tw-status"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);
    spawnControl.handler = (args) => {
      if (!path.basename(String(args[0] ?? "")).startsWith("tw-")) return null;
      return fakeChildProcess(
        JSON.stringify({
          status: "approved",
          targetStack: "python",
          spec: "spec",
          interface: "interface",
          helper_api: "helper",
          detector: {},
          budget: {},
          stdout: "raw stdout",
          stderr: "raw stderr",
          canary: "canary-secret",
          variant: "variant-secret",
          mutant: "mutant-secret",
        }),
        "",
        0,
      );
    };

    const res = await client.callTool({
      name: "nyx_testwriter_job",
      arguments: { jobId: "J4" },
    });
    expect(res.isError).toBeFalsy();
    const payload = res.structuredContent as Record<string, unknown>;
    expect(payload).not.toHaveProperty("stdout");
    expect(payload).not.toHaveProperty("stderr");
    expect(payload).not.toHaveProperty("canary");
    expect(payload).not.toHaveProperty("variant");
    expect(payload).not.toHaveProperty("mutant");
    expect(JSON.stringify(payload)).not.toContain("canary-secret");
    expect(JSON.stringify(payload)).not.toContain("variant-secret");
    expect(JSON.stringify(payload)).not.toContain("mutant-secret");
    expect(brokerSpawnCount()).toBe(1);
  });

  it("stages a write through the tw-status wrapper as the owner and persists a 0600 test", async () => {
    const wrapperRoot = path.join(tmpRoot, "write-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);
    spawnControl.handler = () =>
      fakeChildProcess(JSON.stringify({ status: "approved" }), "", 0);

    const content = "def test_probe():\n    assert True\n";
    const res = await client.callTool({
      name: "nyx_testwriter_write",
      arguments: { jobId: "J5", content },
    });
    expect(res.isError).toBeFalsy();
    const payload = res.structuredContent as { jobId: string; sha256: string; bytes: number };
    expect(payload.jobId).toBe("J5");
    expect(payload.sha256).toBe(sha256Text(content));
    expect(payload.bytes).toBe(Buffer.byteLength(content, "utf8"));

    const staged = stagedTestPath("J5");
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readFileSync(staged, "utf8")).toBe(content);
    expect(fs.statSync(staged).mode & 0o777).toBe(0o600);

    const argv = capturedArgv(0);
    expect(argv[0]).toBe(path.join(wrapperRoot, "bin", "tw-status"));
    expect(argv).toContain("J5");
    expect(argv).not.toContain("/usr/bin/sudo");
    expect(argv.join(" ")).not.toContain("tw-grader");
  });

  it("tightens an existing staged-test directory to 0700 before writing", async () => {
    const wrapperRoot = path.join(tmpRoot, "tighten-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);
    spawnControl.handler = () =>
      fakeChildProcess(JSON.stringify({ status: "approved" }), "", 0);

    const staged = stagedTestPath("J9");
    const testsDir = path.dirname(staged);
    fs.mkdirSync(testsDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(testsDir, 0o755);
    expect(fs.statSync(testsDir).mode & 0o777).toBe(0o755);

    const res = await client.callTool({
      name: "nyx_testwriter_write",
      arguments: { jobId: "J9", content: "def test_probe():\n    assert True\n" },
    });
    expect(res.isError).toBeFalsy();
    expect(fs.statSync(testsDir).mode & 0o777).toBe(0o700);
  });

  it("reads status and report directly through the owner wrapper and returns the verdict", async () => {
    const wrapperRoot = path.join(tmpRoot, "status-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);
    spawnControl.handler = () =>
      fakeChildProcess(
        JSON.stringify({
          status: "closed",
          verdict: "PROVEN",
          reason: null,
          flags: [],
          attempts_used: 2,
        }),
        "",
        0,
      );

    const res = await client.callTool({
      name: "nyx_testwriter_status",
      arguments: { jobId: "J6", report: true },
    });
    expect(res.isError).toBeFalsy();
    const payload = res.structuredContent as {
      status: string;
      verdict: string | null;
      attemptsUsed: number;
      report?: string;
    };
    expect(payload.status).toBe("closed");
    expect(payload.verdict).toBe("PROVEN");
    expect(payload.attemptsUsed).toBe(2);
    expect(payload.report).toContain("PROVEN");
    const statusArgv = capturedArgv(0);
    const reportArgv = capturedArgv(1);
    expect(statusArgv[0]).toBe(path.join(wrapperRoot, "bin", "tw-status"));
    expect(reportArgv[0]).toBe(path.join(wrapperRoot, "bin", "tw-status"));
    expect(reportArgv).toContain("--report");
    for (const argv of [statusArgv, reportArgv]) {
      expect(argv).not.toContain("/usr/bin/sudo");
      expect(argv.join(" ")).not.toContain("tw-grader");
    }
  });

  it("spawns brokered wrappers in a detached process group", async () => {
    const wrapperRoot = path.join(tmpRoot, "detached-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);
    spawnControl.handler = () =>
      fakeChildProcess(JSON.stringify({ status: "approved", targetStack: "python" }), "", 0);

    await client.callTool({ name: "nyx_testwriter_job", arguments: { jobId: "J7" } });

    const options = brokerCalls()[0]?.[2] as
      | { detached?: boolean; env?: Record<string, string> }
      | undefined;
    expect(options?.detached).toBe(true);
    const spawnEnv = options ? options["env"] : undefined;
    expect(spawnEnv?.["TW_WORKSPACE_ROOT"]).toBe(path.join(tmpRoot, "tw-jobs"));
    expect(spawnEnv?.["PATH"]).toBe("/usr/local/bin:/usr/bin:/bin");
  });

  it("rejects a present but non-executable wrapper before spawning", async () => {
    const wrapperRoot = path.join(tmpRoot, "nonexec-install");
    installWrapper(wrapperRoot, "tw-status", 0o600);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);

    const res = await client.callTool({
      name: "nyx_testwriter_job",
      arguments: { jobId: "J8" },
    });
    expect(res.isError).toBe(true);
    expect(["ERR_TESTWRITER_UNAVAILABLE", "ERR_EXEC_FAILED"]).toContain(
      (res.structuredContent as { code: string }).code,
    );
    expect(brokerSpawnCount()).toBe(0);
  });

  it("returns advisoryFlags in status and feedback", async () => {
    const wrapperRoot = path.join(tmpRoot, "advisory-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);
    spawnControl.handler = () =>
      fakeChildProcess(
        JSON.stringify({
          status: "closed",
          verdict: "PROVEN",
          reason: null,
          flags: [],
          advisoryFlags: ["INJECTION_SUSPECTED"],
          attemptsUsed: 1,
        }),
        "",
        0,
      );

    return client
      .callTool({ name: "nyx_testwriter_status", arguments: { jobId: "J10" } })
      .then((res) => {
        expect(res.isError).toBeFalsy();
        const payload = res.structuredContent as { advisoryFlags: string[] };
        expect(payload.advisoryFlags).toEqual(["INJECTION_SUSPECTED"]);
        const sanitized = sanitizeFeedback({ advisoryFlags: ["SPEC_INSUFFICIENT"] });
        expect(sanitized["advisoryFlags"]).toEqual(["SPEC_INSUFFICIENT"]);
      });
  });

  it("rejects an unsupported finish flag before spawning the wrapper", async () => {
    return client
      .callTool({
        name: "nyx_testwriter_finish",
        arguments: { jobId: "J11", notes: "notes", flags: ["NOT_ALLOWED"] },
      })
      .then((res) => {
        expect(res.isError).toBe(true);
        expect((res.structuredContent as { code: string }).code).toBe("ERR_INVALID_INPUT");
        expect(brokerSpawnCount()).toBe(0);
      });
  });

  it("registers exactly seven Test-Writer tools and exposes exactly five to the subagent", () => {
    const testwriterTools = ALL_NYX_TOOLS.map((tool) => tool.name).filter((name) =>
      name.startsWith("nyx_testwriter_"),
    );
    expect(testwriterTools).toHaveLength(7);
    expect(new Set(testwriterTools).size).toBe(7);

    const agent = parseAndCompileAgentFile({
      filePath: path.join(process.cwd(), "agents", "subagents", "nyx-testwriter.md"),
      maxPromptTokens: 1200,
      pkgRoot: process.cwd(),
    });
    expect(agent.contract.nyx_tools).toHaveLength(5);
    expect(agent.contract.nyx_tools.map((tool) => `nyx_${tool}`).sort()).toEqual(
      [
        "nyx_testwriter_finish",
        "nyx_testwriter_gate",
        "nyx_testwriter_job",
        "nyx_testwriter_lint",
        "nyx_testwriter_write",
      ].sort(),
    );
  });

  it("generates deny-by-default OpenCode permissions for the Test-Writer subagent", () => {
    const isoHome = path.join(tmpRoot, "iso-home");
    const pkg = generateOpenCodeHostPackage({
      nyxowlHome: isoHome,
      projectPath: repoPath,
      pkgRoot: process.cwd(),
    });
    const config = JSON.parse(fs.readFileSync(pkg.configPath, "utf8")) as {
      agents: Record<
        string,
        { permissions: Array<{ action: string; resource: string; effect: string }> }
      >;
    };
    const agentConfig = config.agents["nyx-testwriter"];
    expect(agentConfig).toBeDefined();
    const permissions = agentConfig!.permissions;

    // OpenCode v2 permissions are ordered and last-match-wins. Resolve the
    // effective effect for an action by replaying the rules in order, where "*"
    // matches any action and a trailing "*" is a prefix wildcard.
    const actionMatches = (pattern: string, action: string): boolean => {
      if (pattern === "*") return true;
      if (pattern.endsWith("*")) return action.startsWith(pattern.slice(0, -1));
      return pattern === action;
    };
    const resolve = (action: string): string => {
      let effect = "ask";
      for (const rule of permissions) {
        if (rule.resource === "*" && actionMatches(rule.action, action)) {
          effect = rule.effect;
        }
      }
      return effect;
    };

    // A wildcard deny is forbidden: live QA showed OpenCode drops the allowed
    // MCP tools from the model's tool surface when one is present.
    const wildcardDeny = permissions.findIndex(
      (rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny",
    );
    expect(wildcardDeny, "no wildcard deny rule may be generated").toBe(-1);

    const nyxowlDeny = permissions.findIndex(
      (rule) => rule.action === "nyxowl_*" && rule.resource === "*" && rule.effect === "deny",
    );
    const firstAllow = permissions.findIndex(
      (rule) => rule.effect === "allow" && rule.action.startsWith("nyxowl_"),
    );
    expect(nyxowlDeny).toBeGreaterThanOrEqual(0);
    expect(firstAllow).toBeGreaterThan(nyxowlDeny);

    // Explicit host-action denies, in order, before the nyxowl_* deny.
    const hostDenyActions = [
      "read",
      "edit",
      "glob",
      "grep",
      "shell",
      "webfetch",
      "websearch",
      "subagent",
      "skill",
      "question",
      "external_directory",
      "experimental_image_generate",
      "execute",
    ] as const;
    const hostDenyIndexes = hostDenyActions.map((action) =>
      permissions.findIndex(
        (rule) => rule.action === action && rule.resource === "*" && rule.effect === "deny",
      ),
    );
    hostDenyIndexes.forEach((index, position) => {
      expect(index, `${hostDenyActions[position]} deny rule must exist`).toBeGreaterThanOrEqual(0);
      expect(index, `${hostDenyActions[position]} deny must precede nyxowl_* deny`).toBeLessThan(
        nyxowlDeny,
      );
      if (position > 0) {
        expect(index, `${hostDenyActions[position]} deny must follow order`).toBeGreaterThan(
          hostDenyIndexes[position - 1]!,
        );
      }
    });

    // The OpenCode resource-listing actions must stay undennied in config so the
    // five nyxowl_nyx_testwriter_* MCP tools remain exposed to the model. The
    // plugin hook enforces the per-agent boundary instead.
    for (const action of ["opencode_list_mcp_resources", "opencode_read_mcp_resource"]) {
      expect(
        permissions.some((rule) => rule.action === action && rule.effect === "deny"),
        `${action} must not be denied in config`,
      ).toBe(false);
    }

    const deniedActions = [
      ...hostDenyActions,
      "nyxowl_nyx_blackboard_read",
      "nyxowl_nyx_worktree_start",
    ];
    for (const action of deniedActions) {
      expect(resolve(action), `${action} must be denied by last-match-wins`).toBe("deny");
    }

    const allowedActions = [
      "nyxowl_nyx_testwriter_finish",
      "nyxowl_nyx_testwriter_gate",
      "nyxowl_nyx_testwriter_job",
      "nyxowl_nyx_testwriter_lint",
      "nyxowl_nyx_testwriter_write",
    ];
    for (const action of allowedActions) {
      expect(resolve(action), `${action} must stay allowed`).toBe("allow");
    }

    // The plugin hook is the second layer: config exposes the five MCP tools,
    // and the hook denies every other action for this agent at runtime.
    const pluginCode = fs.readFileSync(path.join(pkg.pluginPath, "index.js"), "utf8");
    for (const action of allowedActions) {
      expect(pluginCode, `plugin must allowlist ${action}`).toContain(action);
    }
    expect(pluginCode).toContain("nyx-testwriter");
    expect(pluginCode).toContain("five tools");
    const allowlistCheckIndex = pluginCode.indexOf("TESTWRITER_ACTIONS.has(action)");
    const readEarlyReturnIndex = pluginCode.indexOf('action === "read" && !isSecretPath');
    expect(allowlistCheckIndex).toBeGreaterThanOrEqual(0);
    expect(readEarlyReturnIndex).toBeGreaterThanOrEqual(0);
    expect(
      allowlistCheckIndex,
      "the Test-Writer allowlist must run before the read early return",
    ).toBeLessThan(readEarlyReturnIndex);
  });

  it("uses a two-phase tool-snapshot filter for the Test-Writer boundary", () => {
    const isoHome = path.join(tmpRoot, "snapshot-home");
    const pkg = generateOpenCodeHostPackage({
      nyxowlHome: isoHome,
      projectPath: repoPath,
      pkgRoot: process.cwd(),
    });
    const pluginCode = fs.readFileSync(path.join(pkg.pluginPath, "index.js"), "utf8");

    expect(pluginCode).toContain("TESTWRITER_DENY_TOOLS");
    for (const name of [
      "opencode_models",
      "opencode_session_move",
      "opencode_session_rename",
      "opencode_worktree_create",
      "opencode_worktree_list",
    ]) {
      expect(pluginCode, `plugin must denylist host tool ${name}`).toContain(name);
    }
    expect(pluginCode).toContain("TESTWRITER_TOOL_SUFFIXES");
    for (const suffix of [
      "testwriter_job",
      "testwriter_write",
      "testwriter_lint",
      "testwriter_gate",
      "testwriter_finish",
    ]) {
      expect(pluginCode, `plugin must suffix-match ${suffix}`).toContain(suffix);
    }
    expect(pluginCode).not.toContain("TESTWRITER_TOOL_NAMES");
    expect(pluginCode).toContain('event.agent === "nyx-testwriter"');
    expect(pluginCode).toContain("event.tools");
    expect(pluginCode).toContain("Array.isArray(event.tools)");
    expect(pluginCode).toContain("restrictTools");
    expect(pluginCode).toContain("isAllowedTool");
    expect(pluginCode).toContain("isDeniedTool");
    expect(pluginCode).toContain("const hasAllowed");
    expect(pluginCode).toContain("if (hasAllowed)");
    expect(pluginCode).toContain("splice");

    // Object branch: allowlist phase deletes non-allowed keys, denylist phase
    // deletes only the five bypassing native tools.
    expect(pluginCode).toContain(
      "if (!isAllowedTool(name) && !isAllowedTool(tools[name])) delete tools[name];",
    );
    expect(pluginCode).toContain("if (TESTWRITER_DENY_TOOLS.has(name)) delete tools[name];");
    // Array branch mirrors the same phases.
    expect(pluginCode).toContain("if (isDeniedTool(tools[i])) tools.splice(i, 1);");
    expect(pluginCode).toContain('ctx.session.hook("context", hydrateSession)');
    expect(pluginCode).toContain('ctx.session.hook("context", restrictTools)');
  });
});

describe("Test-Writer broker failure and cap branches", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-testwriter-broker-"));
    spawnControl.calls = [];
    spawnControl.handler = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    spawnControl.handler = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function streamChild(options: {
    stdout?: Buffer[];
    stderr?: Buffer[];
    code?: number;
    pid?: number;
    stdinError?: boolean;
  }): ChildProcess {
    const child = new EventEmitter() as EventEmitter & ChildProcess;
    const out = new EventEmitter();
    const err = new EventEmitter();
    const stdin = new EventEmitter() as EventEmitter & {
      write: () => boolean;
      end: () => void;
    };
    stdin.write = () => true;
    stdin.end = () => undefined;
    child.stdout = out as unknown as ChildProcess["stdout"];
    child.stderr = err as unknown as ChildProcess["stderr"];
    child.stdin = stdin as unknown as ChildProcess["stdin"];
    if (options.pid !== undefined) {
      Object.assign(child, { pid: options.pid });
    }
    child.kill = () => true;
    setImmediate(() => {
      for (const chunk of options.stdout ?? []) out.emit("data", chunk);
      for (const chunk of options.stderr ?? []) err.emit("data", chunk);
      if (options.stdinError) stdin.emit("error", new Error("EPIPE"));
      child.emit("close", options.code ?? 0);
    });
    return child;
  }

  function errorChild(code: string): ChildProcess {
    const child = new EventEmitter() as EventEmitter & ChildProcess;
    const stdin = new EventEmitter() as EventEmitter & {
      write: () => boolean;
      end: () => void;
    };
    stdin.write = () => true;
    stdin.end = () => undefined;
    child.stdin = stdin as unknown as ChildProcess["stdin"];
    child.kill = () => true;
    setImmediate(() => {
      child.emit("error", Object.assign(new Error("spawn failed"), { code }));
    });
    return child;
  }

  it("resolves install and workspace roots from environment overrides", () => {
    vi.stubEnv("TW_INSTALL_ROOT", "/tmp/custom-tw");
    vi.stubEnv("TW_WORKSPACE_ROOT", "/tmp/custom-jobs");
    expect(installRoot()).toBe("/tmp/custom-tw");
    expect(workspaceRoot()).toBe("/tmp/custom-jobs");
    expect(wrapperPath("gate")).toBe("/tmp/custom-tw/bin/tw-gate");
    expect(wrapperPath("status")).toBe("/tmp/custom-tw/bin/tw-status");
    expect(wrapperPath("newJob")).toBe("/tmp/custom-tw/bin/tw-new-job");

    vi.unstubAllEnvs();
    vi.stubEnv("NYXOWL_HOME", "/tmp/nyx-home");
    expect(installRoot()).toBe(path.join("/tmp/nyx-home", "test-writer"));
  });

  it("rejects non-string job ids", () => {
    expect(() => validateJobId(42 as unknown as string)).toThrow(/Invalid Test-Writer job id/);
  });

  it("fails closed when the wrapper path is a directory or missing", async () => {
    const root = path.join(tmpRoot, "dir-install");
    fs.mkdirSync(path.join(root, "bin", "tw-gate"), { recursive: true });
    vi.stubEnv("TW_INSTALL_ROOT", root);
    await expect(runWrapperJson("gate", ["J1"], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_TESTWRITER_UNAVAILABLE",
    });

    vi.stubEnv("TW_INSTALL_ROOT", path.join(tmpRoot, "absent"));
    await expect(runWrapperText("gate", ["J1"], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_TESTWRITER_UNAVAILABLE",
    });
  });

  it("classifies missing, ENOTDIR, directory, and non-executable targets", async () => {
    const plainFile = path.join(tmpRoot, "plain-file");
    fs.writeFileSync(plainFile, "x");

    await expect(
      runProcess([path.join(tmpRoot, "missing-bin")], { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "ERR_TESTWRITER_UNAVAILABLE" });

    await expect(
      runProcess([path.join(plainFile, "child")], { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "ERR_TESTWRITER_UNAVAILABLE" });

    await expect(runProcess([tmpRoot], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_EXEC_FAILED",
    });

    const nonExec = path.join(tmpRoot, "non-exec");
    fs.writeFileSync(nonExec, "#!/bin/sh\n", { mode: 0o600 });
    await expect(runProcess([nonExec], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_EXEC_FAILED",
    });
  });

  it("maps synchronous spawn ENOENT and other failures", async () => {
    const root = path.join(tmpRoot, "spawn-install");
    const executable = installWrapper(root, "tw-gate", 0o700);

    spawnControl.handler = () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    await expect(runProcess([executable], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_TESTWRITER_UNAVAILABLE",
    });

    spawnControl.handler = () => {
      throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    };
    await expect(runProcess([executable], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_EXEC_FAILED",
    });
  });

  it("maps asynchronous child error events", async () => {
    const root = path.join(tmpRoot, "error-install");
    const executable = installWrapper(root, "tw-gate", 0o700);

    spawnControl.handler = () => errorChild("ENOENT");
    await expect(runProcess([executable], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_TESTWRITER_UNAVAILABLE",
    });

    spawnControl.handler = () => errorChild("EACCES");
    await expect(runProcess([executable], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_EXEC_FAILED",
    });
  });

  it("times out and kills both pid-less and process-group children", async () => {
    const root = path.join(tmpRoot, "timeout-install");
    const executable = installWrapper(root, "tw-gate", 0o700);

    spawnControl.handler = () => {
      const child = new EventEmitter() as EventEmitter & ChildProcess;
      child.kill = () => true;
      return child;
    };
    await expect(runProcess([executable], { timeoutMs: 10 })).rejects.toMatchObject({
      code: "ERR_EXEC_TIMEOUT",
    });

    spawnControl.handler = () => {
      const child = new EventEmitter() as EventEmitter & ChildProcess;
      Object.assign(child, { pid: 999_999_999 });
      child.kill = () => true;
      return child;
    };
    await expect(runProcess([executable], { timeoutMs: 10 })).rejects.toMatchObject({
      code: "ERR_EXEC_TIMEOUT",
    });
  });

  it("truncates stdout at the 1 MiB cap and reports oversized JSON output", async () => {
    const root = path.join(tmpRoot, "stdout-cap-install");
    const _executable = installWrapper(root, "tw-gate", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", root);
    expect(_executable).toContain("tw-gate");
    const cap = 1024 * 1024;

    spawnControl.handler = () =>
      streamChild({
        stdout: [Buffer.alloc(cap + 10, 0x61), Buffer.from("overflow")],
        code: 0,
      });
    await expect(
      runWrapperJson("gate", ["J1"], { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "ERR_FILE_TOO_LARGE" });

    spawnControl.handler = () =>
      streamChild({ stdout: [Buffer.alloc(cap + 1, 0x61)], code: 0 });
    await expect(runWrapperText("gate", ["J1"], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_FILE_TOO_LARGE",
    });
  });

  it("truncates stderr at the 64 KiB cap", async () => {
    const root = path.join(tmpRoot, "stderr-cap-install");
    const executable = installWrapper(root, "tw-gate", 0o700);

    spawnControl.handler = () =>
      streamChild({
        stderr: [Buffer.alloc(70 * 1024, 0x62), Buffer.from("more")],
        stdout: [Buffer.from('{"ok":true}')],
        code: 0,
      });
    const result = await runProcess([executable], { timeoutMs: 1000 });
    expect(result.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBe(64 * 1024);
    expect(result.code).toBe(0);
  });

  it("handles stdin errors and absent stdin without failing the wrapper", async () => {
    const root = path.join(tmpRoot, "stdin-install");
    const executable = installWrapper(root, "tw-gate", 0o700);

    spawnControl.handler = () =>
      streamChild({ stdout: [Buffer.from("{}")], code: 0, stdinError: true });
    await expect(runProcess([executable], { timeoutMs: 1000, input: "x" })).resolves.toMatchObject({
      code: 0,
    });

    spawnControl.handler = () => {
      const child = new EventEmitter() as EventEmitter & ChildProcess;
      child.kill = () => true;
      setImmediate(() => child.emit("close", 0));
      return child;
    };
    await expect(runProcess([executable], { timeoutMs: 1000, input: "x" })).resolves.toMatchObject({
      code: 0,
    });
  });

  it("parses non-zero JSON stdout, rejects non-JSON, arrays, and invalid JSON", async () => {
    const root = path.join(tmpRoot, "json-install");
    installWrapper(root, "tw-gate", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", root);

    spawnControl.handler = () =>
      streamChild({ stdout: [Buffer.from('{"error":"validation"}')], code: 2 });
    await expect(runWrapperJson("gate", ["J1"], { timeoutMs: 1000 })).resolves.toEqual({
      error: "validation",
    });

    spawnControl.handler = () => streamChild({ stdout: [Buffer.from("boom")], code: 2 });
    await expect(runWrapperJson("gate", ["J1"], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_EXEC_FAILED",
    });

    spawnControl.handler = () => streamChild({ stdout: [Buffer.from("[1,2]")], code: 0 });
    await expect(runWrapperJson("gate", ["J1"], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_TESTWRITER_PROTOCOL",
    });

    spawnControl.handler = () => streamChild({ stdout: [Buffer.from("not json")], code: 0 });
    await expect(runWrapperJson("gate", ["J1"], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_TESTWRITER_PROTOCOL",
    });

    spawnControl.handler = () =>
      streamChild({ stdout: [Buffer.from("report text")], code: 3 });
    await expect(runWrapperText("gate", ["J1"], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ERR_EXEC_FAILED",
    });
  });

  it("sanitizes only known keys, caps strings, and drops cyclic or forbidden values", () => {
    expect(sanitizeFeedback(null)).toEqual({});
    expect(sanitizeFeedback([])).toEqual({});
    expect(sanitizeFeedback("raw")).toEqual({});

    expect(sanitizeFeedback({ hint: undefined, counts: { passed: 1 } })).toEqual({
      counts: { passed: 1 },
    });

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(sanitizeFeedback({ counts: cyclic, verdict: "PROVEN" })).toEqual({
      verdict: "PROVEN",
    });

    expect(sanitizeFeedback({ verdict: "STDOUT leak" })).toEqual({});

    const capped = sanitizeFeedback({
      verdict: "v".repeat(600),
      reason: "r".repeat(1100),
      hint: "h".repeat(2100),
      message: "m".repeat(2100),
      test_traceback: "t".repeat(20_100),
    }) as Record<string, string>;
    expect(capped["verdict"]).toHaveLength(500);
    expect(capped["reason"]).toHaveLength(1000);
    expect(capped["hint"]).toHaveLength(2000);
    expect(capped["message"]).toHaveLength(2000);
    expect(capped["test_traceback"]).toHaveLength(20_000);
  });

  it("normalizes aliases, running jobs, and rejects oversized job inputs", () => {
    expect(normalizeJobInputs(null)).toMatchObject({
      status: "missing",
      reason: "JOB_MISSING",
      applicable: false,
    });
    expect(normalizeJobInputs([])).toMatchObject({ reason: "JOB_MISSING" });
    expect(normalizeJobInputs({})).toMatchObject({ reason: "JOB_MISSING" });

    const running = normalizeJobInputs({
      job_id: "J1",
      status: "RUNNING",
      target_stack: "python3",
      spec_markdown: "spec",
      interface_markdown: "iface",
      helper_api: "helper",
    });
    expect(running).toMatchObject({
      jobId: "J1",
      applicable: true,
      reason: null,
      targetStack: "python3",
      spec: "spec",
      interface: "iface",
      helperApi: "helper",
      detector: null,
      budget: null,
    });

    expect(
      normalizeJobInputs({ status: "approved", targetStack: "PYTHON" }).applicable,
    ).toBe(true);
    expect(
      normalizeJobInputs({ status: "approved", targetStack: "" }).reason,
    ).toBe("UNSUPPORTED_STACK");
    expect(normalizeJobInputs({ status: "queued", targetStack: "python" }).reason).toBe(
      "JOB_NOT_OPEN",
    );

    expect(() =>
      normalizeJobInputs({ status: "approved", targetStack: "python", spec: "x".repeat(200_001) }),
    ).toThrow(/Job spec exceeds 200000 bytes/);
    expect(() =>
      normalizeJobInputs({
        status: "approved",
        targetStack: "python",
        interface: "x".repeat(100_001),
      }),
    ).toThrow(/Job interface exceeds 100000 bytes/);
    expect(() =>
      normalizeJobInputs({
        status: "approved",
        targetStack: "python",
        helperApi: "x".repeat(50_001),
      }),
    ).toThrow(/Job helper API exceeds 50000 bytes/);
  });
});

describe("Test-Writer tool validation and wrapper response branches", () => {
  let tmpRoot: string;
  let nyxHome: string;
  let repoPath: string;
  let client: Client;

  const validSpec =
    "## Claim\nclaim\n## Intended behavior\nbehavior\n## Rejection behavior\nreject\n## Entry point\nentry\n## Benign example\nBENIGN: ok\n## Detector\ndetector\n";

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-testwriter-tools-"));
    nyxHome = path.join(tmpRoot, "home");
    repoPath = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    spawnControl.calls = [];
    spawnControl.handler = null;
    vi.stubEnv("TW_WORKSPACE_ROOT", path.join(tmpRoot, "tw-jobs"));

    const server = createNyxMcpServer({ defaultProjectPath: repoPath, nyxHome });
    client = new Client({ name: "nyx-testwriter-tools-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    spawnControl.handler = null;
    await client.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function prepareArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      jobId: "P1",
      repoPath,
      vulnerableRef: "a".repeat(40),
      patchedRef: "b".repeat(40),
      module: "pkg.module",
      function: "check",
      fixOrigin: "upstream",
      specMarkdown: validSpec,
      ...overrides,
    };
  }

  async function errorCode(promise: ReturnType<typeof client.callTool>): Promise<string> {
    const res = await promise;
    expect(res.isError).toBe(true);
    return (res.structuredContent as { code: string }).code;
  }

  it("rejects non-object wrapper output and missing staged tests", async () => {
    const wrapperRoot = path.join(tmpRoot, "protocol-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    installWrapper(wrapperRoot, "tw-gate", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);

    spawnControl.handler = () => fakeChildProcess("[1,2]", "", 0);
    expect(
      await errorCode(client.callTool({ name: "nyx_testwriter_job", arguments: { jobId: "T1" } })),
    ).toBe("ERR_TESTWRITER_PROTOCOL");

    expect(
      await errorCode(client.callTool({ name: "nyx_testwriter_lint", arguments: { jobId: "T2" } })),
    ).toBe("ERR_TESTWRITER_TEST_MISSING");
  });

  it("rejects writes for non-writable jobs and malformed UTF-16 content", async () => {
    const wrapperRoot = path.join(tmpRoot, "write-guard-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);
    spawnControl.handler = () =>
      fakeChildProcess(JSON.stringify({ status: "closed" }), "", 0);

    expect(
      await errorCode(
        client.callTool({
          name: "nyx_testwriter_write",
          arguments: { jobId: "T3", content: "def test_x():\n    pass\n" },
        }),
      ),
    ).toBe("ERR_INVALID_INPUT");

    spawnControl.handler = () =>
      fakeChildProcess(JSON.stringify({ status: "approved" }), "", 0);
    expect(
      await errorCode(
        client.callTool({
          name: "nyx_testwriter_write",
          arguments: { jobId: "T4", content: "\uD800" },
        }),
      ),
    ).toBe("ERR_INVALID_INPUT");
  });

  it("rejects oversized finish notes", async () => {
    expect(
      await errorCode(
        client.callTool({
          name: "nyx_testwriter_finish",
          arguments: { jobId: "T5", notes: "n".repeat(4097), flags: [] },
        }),
      ),
    ).toBe("ERR_FILE_TOO_LARGE");
  });

  it("validates prepare repo paths, module, function, spec, and pythonPath", async () => {
    const cases: Array<Record<string, unknown>> = [
      { repoPath: "relative/path" },
      { repoPath: path.join(tmpRoot, "does-not-exist") },
      { module: "1bad" },
      { module: "pkg-module" },
      { function: "bad-name" },
      { specMarkdown: "## Claim\nBENIGN: ok\n" },
      { specMarkdown: validSpec.replace("BENIGN: ok\n", "") },
      { pythonPath: Array.from({ length: 21 }, () => "pkg") },
      { pythonPath: [""] },
      { pythonPath: ["/absolute"] },
      { pythonPath: ["win\\path"] },
      { pythonPath: ["pkg/../escape"] },
    ];
    fs.writeFileSync(path.join(tmpRoot, "plain.txt"), "not a directory");
    for (const overrides of cases) {
      expect(
        await errorCode(
          client.callTool({
            name: "nyx_testwriter_prepare",
            arguments: prepareArgs(overrides),
          }),
        ),
        Object.keys(overrides).join(","),
      ).toBe("ERR_INVALID_INPUT");
    }

    expect(
      await errorCode(
        client.callTool({
          name: "nyx_testwriter_prepare",
          arguments: prepareArgs({ specMarkdown: "x".repeat(200_001) }),
        }),
      ),
    ).toBe("ERR_FILE_TOO_LARGE");

    // The tool context cannot be created with a file as the project path, so
    // exercise the repoPath regular-file guard through the handler directly.
    const ctx = await createToolContext(
      { repoPath },
      { defaultProjectPath: repoPath, nyxHome },
    );
    try {
      await expect(
        nyxTestwriterPrepareTool.handler(
          prepareArgs({ repoPath: path.join(tmpRoot, "plain.txt") }) as never,
          ctx,
        ),
      ).rejects.toMatchObject({ code: "ERR_INVALID_INPUT" });
    } finally {
      ctx.db.close();
    }
  });

  it("normalizes status aliases, numeric strings, and non-array flags", async () => {
    const wrapperRoot = path.join(tmpRoot, "status-alias-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);

    spawnControl.handler = () =>
      fakeChildProcess(
        JSON.stringify({
          status: "running",
          verdict: "",
          reason: "",
          flags: "not-an-array",
          advisoryFlags: 7,
          attempts: "7",
        }),
        "",
        0,
      );
    const res = await client.callTool({
      name: "nyx_testwriter_status",
      arguments: { jobId: "T6" },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: "running",
      verdict: null,
      reason: null,
      flags: [],
      advisoryFlags: [],
      attemptsUsed: 7,
    });
    expect(res.structuredContent).not.toHaveProperty("report");

    spawnControl.handler = () =>
      fakeChildProcess(JSON.stringify({ status: "running", attempts: "nope" }), "", 0);
    const zero = await client.callTool({
      name: "nyx_testwriter_status",
      arguments: { jobId: "T7", report: false },
    });
    expect((zero.structuredContent as { attemptsUsed: number }).attemptsUsed).toBe(0);
    expect(zero.structuredContent).not.toHaveProperty("report");
  });

  it("runs lint, gate, finish, write, and prepare through wrappers", async () => {
    const wrapperRoot = path.join(tmpRoot, "success-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    installWrapper(wrapperRoot, "tw-gate", 0o700);
    installWrapper(wrapperRoot, "tw-new-job", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);

    const staged = stagedTestPath("T8");
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, "def test_ok():\n    assert True\n");

    spawnControl.handler = (args) => {
      const executable = path.basename(String(args[0] ?? ""));
      const argv = (args[1] ?? []) as string[];
      if (executable === "tw-new-job") {
        return fakeChildProcess(JSON.stringify({ id: "RETURNED1" }), "", 0);
      }
      if (executable === "tw-status") {
        return fakeChildProcess(JSON.stringify({ status: "running" }), "", 0);
      }
      if (argv.includes("--lint-only")) {
        return fakeChildProcess(
          JSON.stringify({ ok: true, violations: [{ rule: "x" }], stdout: "leak" }),
          "",
          0,
        );
      }
      if (argv.includes("--finish")) {
        return fakeChildProcess(
          JSON.stringify({ verdict: "PROVEN", reason: "ok", canary: "secret" }),
          "",
          0,
        );
      }
      return fakeChildProcess(
        JSON.stringify({ verdict: "PROVEN", counts: { passed: 1 }, stderr: "leak" }),
        "",
        0,
      );
    };

    const lint = await client.callTool({
      name: "nyx_testwriter_lint",
      arguments: { jobId: "T8" },
    });
    expect(lint.isError).toBeFalsy();
    expect(lint.structuredContent).toMatchObject({ ok: true });
    expect((lint.structuredContent as { violations: unknown[] }).violations).toHaveLength(1);
    expect(lint.structuredContent).not.toHaveProperty("stdout");

    const gate = await client.callTool({
      name: "nyx_testwriter_gate",
      arguments: { jobId: "T8" },
    });
    expect(gate.structuredContent).toMatchObject({ verdict: "PROVEN", counts: { passed: 1 } });
    expect(gate.structuredContent).not.toHaveProperty("stderr");

    const finish = await client.callTool({
      name: "nyx_testwriter_finish",
      arguments: { jobId: "T8", notes: "done", flags: ["INJECTION_SUSPECTED"] },
    });
    expect(finish.structuredContent).toMatchObject({ verdict: "PROVEN", reason: "ok" });
    expect(finish.structuredContent).not.toHaveProperty("canary");

    const write = await client.callTool({
      name: "nyx_testwriter_write",
      arguments: { jobId: "T9", content: "def test_new():\n    pass\n" },
    });
    expect(write.isError).toBeFalsy();
    expect((write.structuredContent as { jobId: string }).jobId).toBe("T9");

    const prepared = await client.callTool({
      name: "nyx_testwriter_prepare",
      arguments: prepareArgs(),
    });
    expect(prepared.isError).toBeFalsy();
    expect((prepared.structuredContent as { jobId: string }).jobId).toBe("RETURNED1");

    spawnControl.handler = () => fakeChildProcess("{}", "", 0);
    const fallback = await client.callTool({
      name: "nyx_testwriter_prepare",
      arguments: prepareArgs({ jobId: "P2" }),
    });
    expect((fallback.structuredContent as { jobId: string }).jobId).toBe("P2");

    spawnControl.handler = () =>
      fakeChildProcess(JSON.stringify({ id: "../bad" }), "", 0);
    expect(
      await errorCode(
        client.callTool({
          name: "nyx_testwriter_prepare",
          arguments: prepareArgs({ jobId: "P3" }),
        }),
      ),
    ).toBe("ERR_INVALID_INPUT");
  });
});

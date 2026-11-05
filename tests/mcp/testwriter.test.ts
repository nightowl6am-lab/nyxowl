import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAndCompileAgentFile, ROLE_ALLOWED_NYX_TOOLS } from "../../src/cli/compiler.ts";
import { ALL_NYX_TOOLS, createNyxMcpServer } from "../../src/mcp/server.ts";
import {
  buildGraderArgv,
  normalizeJobInputs,
  sanitizeFeedback,
  sha256Text,
  stagedTestPath,
  validateJobId,
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
    return (
      executable === "/usr/bin/sudo" ||
      executable.includes("tw-status") ||
      executable.includes("tw-gate") ||
      executable.includes("tw-new-job")
    );
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

  it("builds the fixed grader argv with no caller-controlled executable", () => {
    vi.stubEnv("TW_INSTALL_ROOT", "/opt/test-writer");
    expect(buildGraderArgv("gate", ["J1"])).toEqual([
      "/usr/bin/sudo",
      "-n",
      "-u",
      "tw-grader",
      "/opt/test-writer/bin/tw-gate",
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
      includeConditionalAll: true,
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
    expect(agent.claudeToolsAllowlist).toEqual([
      "mcp__nyxowl__nyx_testwriter_job",
      "mcp__nyxowl__nyx_testwriter_write",
      "mcp__nyxowl__nyx_testwriter_lint",
      "mcp__nyxowl__nyx_testwriter_gate",
      "mcp__nyxowl__nyx_testwriter_finish",
    ]);
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
      if (args[0] !== "/usr/bin/sudo") return null;
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

  it("stages a write through tw-status as tw-grader and persists a 0600 test", async () => {
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
    expect(argv.slice(0, 4)).toEqual(["/usr/bin/sudo", "-n", "-u", "tw-grader"]);
    expect(argv.some((arg) => arg.includes("tw-status"))).toBe(true);
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

  it("reads status and report as tw-grader and returns the grader verdict", async () => {
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
    expect(capturedArgv(0)).toContain("tw-grader");
    expect(capturedArgv(1)).toContain("tw-grader");
  });

  it("spawns brokered wrappers in a detached process group", async () => {
    const wrapperRoot = path.join(tmpRoot, "detached-install");
    installWrapper(wrapperRoot, "tw-status", 0o700);
    vi.stubEnv("TW_INSTALL_ROOT", wrapperRoot);
    spawnControl.handler = () =>
      fakeChildProcess(JSON.stringify({ status: "approved", targetStack: "python" }), "", 0);

    await client.callTool({ name: "nyx_testwriter_job", arguments: { jobId: "J7" } });

    const options = brokerCalls()[0]?.[2] as { detached?: boolean } | undefined;
    expect(options?.detached).toBe(true);
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
});

#!/usr/bin/env node
// M6 parent end-to-end evidence: a real stdio MCP client against this worktree.
//
// The runner builds the fixture repository, installs the worktree runtime into
// a temporary install root, starts `node dist/cli/bin.js mcp`, and drives the
// real prepare -> add variants -> approve -> job -> write -> lint -> gate ->
// finish -> status flow.  It uses only temporary roots, no network, no secret,
// and no production path.  Missing dist, bubblewrap, or the runtime venv prints
// `M6_PARENT_E2E: SKIP` and exits 2.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST_BIN = path.join(ROOT, "dist", "cli", "bin.js");
const FIXTURES = path.join(ROOT, "test-writer", "fixtures");
const AGENT_FILE = path.join(ROOT, "agents", "subagents", "nyx-testwriter.md");
const ENV = process["env"];

function skip(reason) {
  console.log(`M6_PARENT_E2E: SKIP (${reason})`);
  process.exit(2);
}

function venvPython() {
  const configured = ENV["TW_VENV_PYTHON"];
  return configured ?? path.join(os.homedir(), ".nyxowl", "test-writer", "venv", "bin", "python");
}

function runOwner(install, name, args, env) {
  return String(
    execFileSync(path.join(install, "bin", name), args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function parseSubagentTools() {
  const text = fs.readFileSync(AGENT_FILE, "utf8");
  const tools = [];
  let inTools = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^nyx_tools:/.test(line)) {
      inTools = true;
      continue;
    }
    if (inTools) {
      const match = /^\s*-\s+(\S+)\s*$/.exec(line);
      if (match) {
        tools.push(`nyx_${match[1]}`);
        continue;
      }
      if (line.trim() !== "") inTools = false;
    }
  }
  return tools;
}

if (!fs.existsSync(DIST_BIN)) skip("dist/cli/bin.js is missing; run npm run build");
if (!fs.existsSync("/usr/bin/bwrap")) skip("/usr/bin/bwrap is missing");
const venv = venvPython();
if (!fs.existsSync(venv)) skip(`runtime venv interpreter is missing: ${venv}`);
try {
  execFileSync(venv, ["-c", "import pytest, hypothesis"], { stdio: "ignore" });
} catch {
  skip("runtime venv lacks pytest/hypothesis");
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "m6-parent-e2e-"));
let client;
let passed = false;
try {
  const repo = path.join(temp, "repo");
  execFileSync("python3", [path.join(FIXTURES, "build_fixtures.py"), "--out", repo], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });

  const install = path.join(temp, "install");
  const store = path.join(install, "store");
  const workspace = path.join(temp, "workspace");
  const tmp = path.join(temp, "tmp");
  const nyxHome = path.join(temp, "nyxowl-home");
  for (const dir of [workspace, tmp, nyxHome]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const baseEnv = {
    PATH: ENV["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: ENV["HOME"] ?? os.homedir(),
    LANG: ENV["LANG"] ?? "C.UTF-8",
    NYXOWL_HOME: nyxHome,
    TW_INSTALL_ROOT: install,
    TW_STORE_ROOT: store,
    TW_TMP_ROOT: tmp,
    TW_WORKSPACE_ROOT: workspace,
    TW_VENV_PYTHON: venv,
  };
  const installed = String(
    execFileSync("bash", [path.join(ROOT, "test-writer", "bootstrap", "install-user.sh")], {
      env: baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    }),
  );
  assert.ok(installed.includes("USER_INSTALL: PASS"), "runtime install did not pass");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_BIN, "mcp"],
    env: baseEnv,
    stderr: "pipe",
  });
  client = new Client({ name: "m6-parent-e2e", version: "1.0.0" });
  await client.connect(transport);

  const list = await client.listTools();
  const names = list.tools.map((tool) => tool.name);
  assert.equal(names.length, 38, `expected 38 tools, got ${names.length}`);
  const testwriterTools = names.filter((name) => name.startsWith("nyx_testwriter_"));
  assert.equal(testwriterTools.length, 7, `expected 7 Test-Writer tools, got ${testwriterTools.length}`);
  const subagentTools = parseSubagentTools();
  assert.equal(subagentTools.length, 5, `expected 5 subagent tools, got ${subagentTools.length}`);
  for (const tool of subagentTools) {
    assert.ok(names.includes(tool), `subagent tool ${tool} is not registered`);
  }
  assert.ok(names.includes("nyx_testwriter_prepare"));
  assert.ok(names.includes("nyx_testwriter_status"));

  const j1 = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "jobs", "j1", "job.json"), "utf8"),
  );
  const jobId = `m6-parent-e2e-${process.pid}`;
  const prepared = await client.callTool({
    name: "nyx_testwriter_prepare",
    arguments: {
      jobId,
      repoPath: repo,
      vulnerableRef: j1.vulnerable_ref,
      patchedRef: j1.patched_ref,
      module: j1.module,
      function: j1.function,
      fixOrigin: j1.fix_origin,
      specMarkdown: j1.spec_markdown,
      pythonPath: j1.python_path,
    },
  });
  assert.ok(!prepared.isError, `prepare failed: ${JSON.stringify(prepared)}`);

  runOwner(install, "tw-add-variant", [
    jobId,
    "--kind",
    "still_vulnerable",
    "--ref",
    j1.variants.still_vulnerable_ref,
    "--repo",
    repo,
  ], baseEnv);
  runOwner(install, "tw-add-variant", [
    jobId,
    "--kind",
    "fixed_differently",
    "--ref",
    j1.variants.fixed_differently_ref,
    "--repo",
    repo,
  ], baseEnv);
  const approved = runOwner(install, "tw-approve", [jobId], baseEnv);
  assert.ok(approved.includes(`APPROVED ${jobId}`), "approval did not pass");

  const job = await client.callTool({ name: "nyx_testwriter_job", arguments: { jobId } });
  assert.ok(!job.isError, `job read failed: ${JSON.stringify(job)}`);
  const jobPayload = job.structuredContent;
  assert.equal(jobPayload.applicable, true);
  assert.ok(String(jobPayload.spec).includes("## Claim"));
  assert.ok(String(jobPayload.interface).includes("signature:"));
  assert.ok(String(jobPayload.helperApi).includes("detector.check"));
  const jobText = JSON.stringify(jobPayload);
  for (const fragment of [
    j1.variants.still_vulnerable_ref,
    j1.variants.fixed_differently_ref,
    "src-still-vulnerable.tar",
    "src-fixed-differently.tar",
    install,
    store,
    workspace,
  ]) {
    assert.ok(!jobText.includes(fragment), `job response leaked ${fragment}`);
  }

  const source = fs.readFileSync(path.join(FIXTURES, "jobs", "j1", "test_proof.py"), "utf8");
  const written = await client.callTool({
    name: "nyx_testwriter_write",
    arguments: { jobId, content: source },
  });
  assert.ok(!written.isError, `write failed: ${JSON.stringify(written)}`);

  const lint = await client.callTool({ name: "nyx_testwriter_lint", arguments: { jobId } });
  assert.ok(!lint.isError, `lint failed: ${JSON.stringify(lint)}`);
  assert.equal(lint.structuredContent.ok, true);

  const gate = await client.callTool({ name: "nyx_testwriter_gate", arguments: { jobId } });
  assert.ok(!gate.isError, `gate failed: ${JSON.stringify(gate)}`);
  const gatePayload = gate.structuredContent;
  assert.equal(gatePayload.verdict, "PROVEN", JSON.stringify(gatePayload));
  assert.equal(gatePayload.closed, true);

  const finished = await client.callTool({
    name: "nyx_testwriter_finish",
    arguments: {
      jobId,
      notes: "M6 parent E2E completed; advisory flag is scripted evidence.",
      flags: ["INJECTION_SUSPECTED"],
    },
  });
  assert.ok(!finished.isError, `finish failed: ${JSON.stringify(finished)}`);
  const finishPayload = finished.structuredContent;
  assert.equal(finishPayload.verdict, "PROVEN");
  assert.deepEqual(finishPayload.advisoryFlags, ["INJECTION_SUSPECTED"]);

  const status = await client.callTool({
    name: "nyx_testwriter_status",
    arguments: { jobId, report: true },
  });
  assert.ok(!status.isError, `status failed: ${JSON.stringify(status)}`);
  const statusPayload = status.structuredContent;
  assert.equal(statusPayload.verdict, "PROVEN");
  assert.deepEqual(statusPayload.advisoryFlags, ["INJECTION_SUSPECTED"]);
  assert.ok(String(statusPayload.report).includes("## Limits"));
  for (const fragment of ["def decode(", "TOP SECRET"]) {
    assert.ok(
      !String(statusPayload.report).includes(fragment),
      `report leaked target source fragment ${fragment}`,
    );
  }

  const badId = await client.callTool({
    name: "nyx_testwriter_job",
    arguments: { jobId: "../bad" },
  });
  assert.equal(badId.isError, true);
  assert.equal(badId.structuredContent.code, "ERR_INVALID_INPUT");

  let closedWriteRefused = false;
  try {
    await client.callTool({
      name: "nyx_testwriter_write",
      arguments: { jobId, content: "def test_x():\n    assert True\n" },
    });
  } catch {
    // The write tool's strict output schema makes the SDK raise the refusal
    // instead of returning a structured error; either way the write is denied.
    closedWriteRefused = true;
  }
  assert.equal(closedWriteRefused, true);

  passed = true;
} catch (error) {
  console.error(error);
  if (error && typeof error === "object") {
    if (error.stdout) console.error(`stdout: ${String(error.stdout)}`);
    if (error.stderr) console.error(`stderr: ${String(error.stderr)}`);
  }
} finally {
  if (client) {
    try {
      await client.close();
    } catch {
      // The transport may already be closed after a failed request.
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });
}

if (passed) {
  console.log("M6_PARENT_E2E: PASS");
} else {
  console.log("M6_PARENT_E2E: FAIL");
  process.exitCode = 1;
}

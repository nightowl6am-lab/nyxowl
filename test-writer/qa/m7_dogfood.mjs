#!/usr/bin/env node
// PR A real-use dogfood: a temporary Git repo driven through the real stdio MCP
// server (`node dist/cli/bin.js mcp`) with a temporary NYXOWL_HOME.
//
// The flow is dna -> external worktree -> real code fix + test -> real `npm test`
// through package.json -> seam/slop receipts -> loopback exploit probe -> local
// PR gate with four receipts -> allowlisted dependency check.  No network,
// remote service, secret, or production root is used.  Missing dist, bubblewrap,
// or the runtime venv prints `PR_A_DOGFOOD: SKIP` and exits 2.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST_BIN = path.join(ROOT, "dist", "cli", "bin.js");
const ENV = process["env"];
const VECTORS = [
  "authz-idor",
  "sqli-xss",
  "cors",
  "mass-assignment",
  "rate-limit",
  "secret-leak",
];

const steps = [];

function record(step, status, detail = "") {
  steps.push({ step, status, detail });
}

function skip(reason) {
  console.log(`PR_A_DOGFOOD: SKIP (${reason})`);
  process.exit(2);
}

function venvPython() {
  const configured = ENV["TW_VENV_PYTHON"];
  return configured ?? path.join(os.homedir(), ".nyxowl", "test-writer", "venv", "bin", "python");
}

function git(cwd, args) {
  return String(
    execFileSync("git", ["-C", cwd, ...args], {
      env: ENV,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-a-dogfood-"));
let client;
let server;
let passed = false;

async function call(name, args, label) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = Array.isArray(result.content)
      ? result.content.map((item) => item.text ?? "").join("\n")
      : JSON.stringify(result);
    throw new Error(`${label}: tool returned an error: ${text}`);
  }
  if (!result.structuredContent) {
    throw new Error(`${label}: tool returned no structuredContent`);
  }
  return result.structuredContent;
}

try {
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  writeFile(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        name: "pr-a-dogfood",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFile(
    path.join(repo, "src", "mathutil.js"),
    "export function add(a, b) {\n  return a - b;\n}\n",
  );
  writeFile(
    path.join(repo, "test", "mathutil.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "../src/mathutil.js";',
      "",
      'test("add sums two numbers", () => {',
      "  assert.equal(add(2, 3), 5);",
      "});",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(repo, ".nyxowl", "config.json"),
    JSON.stringify(
      {
        provision: { install: "off" },
        github: { mode: "local" },
        deps: { allow: ["left-pad"] },
      },
      null,
      2,
    ) + "\n",
  );
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "PR A Dogfood"]);
  git(repo, ["config", "user.email", "dogfood@example.invalid"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "chore: seed dogfood repository"]);
  record("temp-git-repo", "PASS", repo);

  const nyxHome = path.join(temp, "nyxowl-home");
  fs.mkdirSync(nyxHome, { recursive: true, mode: 0o700 });
  const baseEnv = {
    PATH: ENV["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: ENV["HOME"] ?? os.homedir(),
    LANG: ENV["LANG"] ?? "C.UTF-8",
    NYXOWL_HOME: nyxHome,
    NYXOWL_PROJECT: repo,
    TW_VENV_PYTHON: venv,
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_BIN, "mcp"],
    env: baseEnv,
    stderr: "pipe",
  });
  client = new Client({ name: "pr-a-dogfood", version: "1.0.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const required of [
    "nyx_dna_extract",
    "nyx_worktree_start",
    "nyx_verify_slice",
    "nyx_seam_check",
    "nyx_slop_check",
    "nyx_exploit_probe",
    "nyx_worktree_pr",
    "nyx_dep_guard",
  ]) {
    assert.ok(names.includes(required), `${required} is not registered`);
  }
  record("mcp-connect", "PASS", `${names.length} tools`);

  const dna = await call("nyx_dna_extract", { repoPath: repo, refresh: true }, "dna");
  assert.ok(dna.dna, "dna payload is missing");
  assert.equal(dna.dna.primaryStack, "javascript-node");
  assert.equal(dna.dna.commands.test, "npm run test");
  assert.equal(dna.dna.httpSurface, false);
  record("nyx_dna_extract", "PASS", `${dna.dna.primaryStack}; test=${dna.dna.commands.test}`);

  const taskSlug = `pr-a-dogfood-${process.pid}`;
  const started = await call(
    "nyx_worktree_start",
    { taskSlug, repoPath: repo, worktreeMode: "external" },
    "worktree_start",
  );
  assert.equal(started.rootMode, "external");
  assert.equal(started.branch, `nyx/${taskSlug}`);
  assert.equal(started.baseBranch, "main");
  assert.equal(started.provision.installStatus, "skipped");
  assert.ok(fs.existsSync(started.worktreePath), "worktree path is missing");
  const worktreePath = started.worktreePath;
  record("nyx_worktree_start", "PASS", `${started.rootMode}; install=${started.provision.installStatus}`);

  writeFile(
    path.join(worktreePath, "src", "mathutil.js"),
    "export function add(a, b) {\n  return a + b;\n}\n",
  );
  writeFile(
    path.join(worktreePath, "test", "mathutil.regression.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "../src/mathutil.js";',
      "",
      'test("add handles zero", () => {',
      "  assert.equal(add(-1, 1), 0);",
      "});",
      "",
    ].join("\n"),
  );
  git(worktreePath, ["add", "-A"]);
  git(worktreePath, ["commit", "-q", "-m", "fix: make add sum its arguments"]);
  record("worktree-fix-and-commit", "PASS", "src/mathutil.js + regression test");

  const verified = await call(
    "nyx_verify_slice",
    { worktreePath, sliceId: "slice-1", taskSlug },
    "verify_slice",
  );
  assert.equal(verified.status, "GREEN", JSON.stringify(verified));
  assert.equal(verified.failedStep, null);
  assert.ok(verified.receiptId);
  assert.ok(
    String(verified.summaryOutput).includes("(test)"),
    `verify did not report a test step: ${verified.summaryOutput}`,
  );
  const projectDir = fs.readdirSync(path.join(nyxHome, "projects"))[0];
  assert.ok(projectDir, "project state directory is missing");
  const verifyEvidence = fs.readFileSync(
    path.join(nyxHome, "projects", projectDir, "artifacts", `${verified.evidenceArtifactId}.txt`),
    "utf8",
  );
  assert.ok(
    verifyEvidence.includes("npm run test"),
    `verify evidence did not run npm test: ${verifyEvidence}`,
  );
  assert.ok(
    verifyEvidence.includes("pass 2"),
    `verify evidence did not report two passing tests: ${verifyEvidence}`,
  );
  record("nyx_verify_slice", "PASS", `receipt ${verified.receiptId.slice(0, 8)}; real npm run test`);

  const seam = await call("nyx_seam_check", { worktreePath }, "seam_check");
  assert.equal(seam.status, "GREEN", JSON.stringify(seam));
  assert.ok(seam.receiptId);
  record("nyx_seam_check", "PASS", `coverage=${seam.coverage}`);

  const slop = await call(
    "nyx_slop_check",
    { worktreePath, scope: "diff" },
    "slop_check",
  );
  assert.equal(slop.status, "GREEN", JSON.stringify(slop));
  assert.ok(slop.receiptId);
  record("nyx_slop_check", "PASS", `blocking=${slop.blockingCount}`);

  server = http.createServer((request, response) => {
    response.statusCode = 404;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("not found\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "loopback server has no port");
  const target = `http://127.0.0.1:${address.port}/`;

  const exploit = await call(
    "nyx_exploit_probe",
    { targetUrlOrHandler: target, worktreePath, vectors: VECTORS },
    "exploit_probe",
  );
  assert.equal(exploit.status, "GREEN", JSON.stringify(exploit));
  assert.equal(exploit.findings.length, VECTORS.length);
  for (const finding of exploit.findings) {
    assert.equal(finding.vulnerable, false, `${finding.vector} reported vulnerable`);
  }
  await new Promise((resolve) => server.close(resolve));
  server = undefined;
  record("nyx_exploit_probe", "PASS", `${exploit.findings.length} vectors GREEN`);

  const pr = await call(
    "nyx_worktree_pr",
    {
      taskSlug,
      title: "PR A dogfood fix add()",
      summary: "Real-use dogfood slice: fix add() and add a regression test.",
    },
    "worktree_pr",
  );
  assert.equal(pr.mode, "local", JSON.stringify(pr));
  assert.equal(pr.verifiedReceipts.length, 4, JSON.stringify(pr.verifiedReceipts));
  const kinds = new Set(pr.verifiedReceipts.map((receipt) => receipt.kind));
  for (const kind of ["verify", "seam", "slop", "exploit"]) {
    assert.ok(kinds.has(kind), `missing ${kind} receipt`);
  }
  for (const receipt of pr.verifiedReceipts) {
    assert.ok(["GREEN", "NA"].includes(receipt.status), JSON.stringify(receipt));
  }
  assert.ok(pr.localPrFilePath && fs.existsSync(pr.localPrFilePath), "local PR file is missing");
  record(
    "nyx_worktree_pr",
    "PASS",
    `mode=${pr.mode}; ${pr.verifiedReceipts.map((r) => `${r.kind}:${r.status}`).join(", ")}`,
  );

  const dep = await call(
    "nyx_dep_guard",
    { packages: ["left-pad"], ecosystem: "npm", repoPath: repo },
    "dep_guard",
  );
  assert.equal(dep.allApproved, true, JSON.stringify(dep));
  assert.equal(dep.results.length, 1);
  assert.equal(dep.results[0].approved, true);
  assert.deepEqual(dep.results[0].findings, []);
  record("nyx_dep_guard", "PASS", "left-pad allowlisted offline");

  passed = true;
} catch (error) {
  record("failure", "FAIL", error instanceof Error ? error.message : String(error));
  console.error(error);
  if (error && typeof error === "object") {
    if (error.stdout) console.error(`stdout: ${String(error.stdout)}`);
    if (error.stderr) console.error(`stderr: ${String(error.stderr)}`);
  }
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (client) {
    try {
      await client.close();
    } catch {
      // The transport may already be closed after a failed request.
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("step | status | detail");
for (const step of steps) {
  console.log(`${step.step} | ${step.status} | ${step.detail}`);
}

if (passed) {
  console.log("PR_A_DOGFOOD: PASS");
} else {
  console.log("PR_A_DOGFOOD: FAIL");
  process.exitCode = 1;
}

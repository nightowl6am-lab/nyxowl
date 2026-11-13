#!/usr/bin/env node
// PR D real-repository dogfood: clone a tracked-only real repository, then drive
// the whole slice through the real stdio MCP server (`node dist/cli/bin.js mcp`)
// with a temporary NYXOWL_HOME.
//
// Flow per target: clone -> no-.env assertion -> config -> real DNA -> external
// worktree -> real new unit test committed in the worktree -> verify with the
// target's real DNA test command -> seam -> slop -> loopback exploit probe ->
// four-receipt local PR -> allowlisted dependency check -> worktree removal.
//
// There is no install, network, sudo, root, secret read, or commandsOverride.
// The optional primary target is provided by NYXOWL_DOGFOOD_REPO; nyxowl-self is always the fallback.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST_BIN = path.join(ROOT, "dist", "cli", "bin.js");
const ENV = process["env"];
const TEMP_BASE = "/tmp/opencode";
const VECTORS = [
  "authz-idor",
  "sqli-xss",
  "cors",
  "mass-assignment",
  "rate-limit",
  "secret-leak",
];
const DOGFOOD_TOOLS = [
  "nyx_dna_extract",
  "nyx_worktree_start",
  "nyx_verify_slice",
  "nyx_seam_check",
  "nyx_slop_check",
  "nyx_exploit_probe",
  "nyx_worktree_pr",
  "nyx_dep_guard",
];
const TEST_SOURCE = [
  'import { describe, expect, it } from "vitest";',
  "",
  'describe("slice5 dogfood", () => {',
  '  it("keeps arithmetic stable", () => {',
  "    expect(1 + 1).toBe(2);",
  "  });",
  "});",
  "",
].join("\n");

function dogfoodConfig(dependency) {
  return (
    JSON.stringify(
      {
        provision: { install: "off", linkEnv: false },
        github: { mode: "local" },
        deps: { allow: [dependency] },
        budgets: { maxToolOutputTokens: 50000 },
      },
      null,
      2,
    ) + "\n"
  );
}

const EXTERNAL_DOGFOOD_REPO = ENV["NYXOWL_DOGFOOD_REPO"];
const TARGETS = [
  ...(EXTERNAL_DOGFOOD_REPO
    ? [{
        name: ENV["NYXOWL_DOGFOOD_NAME"] ?? "private-production-repo",
        source: EXTERNAL_DOGFOOD_REPO,
        testFile: ENV["NYXOWL_DOGFOOD_TEST_FILE"] ?? "apps/web/tests/unit/slice5-dogfood.test.ts",
        dependency: ENV["NYXOWL_DOGFOOD_DEPENDENCY"] ?? "zod",
        nodeModules(source) {
          const rels = ["node_modules", "apps/web/node_modules"];
          const packagesDir = path.join(source, "packages");
          if (fs.existsSync(packagesDir)) {
            for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              const rel = path.join("packages", entry.name, "node_modules");
              if (fs.existsSync(path.join(source, rel))) rels.push(rel);
            }
          }
          return rels;
        },
      }]
    : []),
  {
    name: "nyxowl-self",
    source: ROOT,
    testFile: "tests/unit/slice5-dogfood.test.ts",
    dependency: "zod",
    nodeModules() {
      return ["node_modules"];
    },
  },
];

function venvPython() {
  const configured = ENV["TW_VENV_PYTHON"];
  return configured ?? path.join(os.homedir(), ".nyxowl", "test-writer", "venv", "bin", "python");
}

function git(cwd, args) {
  const prefix = cwd ? ["-C", cwd] : [];
  return String(
    execFileSync("git", [...prefix, ...args], {
      env: ENV,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function flatten(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function oneLine(value) {
  return flatten(value).slice(0, 400);
}

function envPathIsSecret(filePath) {
  const base = filePath.split("/").pop() ?? filePath;
  // `.env.example` is an allowed placeholder; every other .env/.env.* path aborts.
  return /^\.env($|\.)/.test(base) && base !== ".env.example";
}

function assertNoTrackedEnv(clone) {
  assert.equal(fs.existsSync(path.join(clone, ".env")), false, "clone has an untracked .env file");
  const tracked = git(clone, ["ls-files"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const envPaths = tracked.filter(envPathIsSecret);
  assert.equal(envPaths.length, 0, "clone tracks a .env or .env.* secret file");
}

function linkTree(src, dst) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      linkTree(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  try {
    fs.linkSync(src, dst);
  } catch {
    // Different filesystem: fall back to a real copy.
    fs.copyFileSync(src, dst);
  }
}

function linkNodeModules(source, worktreePath, rels) {
  for (const rel of rels) {
    const src = path.join(source, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(worktreePath, rel);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // Hardlink-clone the ignored dependency tree. Turbopack refuses symlinked
    // workspace node_modules that resolve outside the project root, so a
    // symlinked directory is not enough for a real Next.js build.
    linkTree(src, dst);
  }
}

async function runTarget(spec) {
  const steps = [];
  const outcome = {
    name: spec.name,
    steps,
    passed: false,
    failure: null,
    testCommand: null,
    receipts: null,
  };
  let client;
  let server;
  let temp;
  let currentStep = "startup";

  function record(step, status, detail = "") {
    steps.push({ step, status, detail: oneLine(detail) });
  }

  async function call(name, args, label) {
    // Use the raw tools/call request so an error payload is surfaced verbatim.
    // The SDK's callTool validates structuredContent even on isError results,
    // which masks the real tool error when the tool declares an output schema.
    const result = await client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
    );
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
    currentStep = "source-check";
    if (!fs.existsSync(spec.source)) {
      throw new Error(`source checkout is missing: ${spec.source}`);
    }
    const inside = git(spec.source, ["rev-parse", "--is-inside-work-tree"]).trim();
    if (inside !== "true") {
      throw new Error(`source is not a git work tree: ${spec.source}`);
    }
    record("source-check", "PASS", spec.source);

    currentStep = "clone";
    fs.mkdirSync(TEMP_BASE, { recursive: true, mode: 0o700 });
    temp = fs.mkdtempSync(path.join(TEMP_BASE, `m7-real-dogfood-${spec.name}-`));
    const clone = path.join(temp, "repo");
    git(undefined, ["clone", "--local", "--no-hardlinks", "--quiet", spec.source, clone]);
    record("clone", "PASS", "tracked-only local clone");
    assertNoTrackedEnv(clone);
    record("no-env", "PASS", "no .env file and no tracked .env/.env.* secret path");

    currentStep = "config";
    git(clone, ["config", "user.name", "Slice5 Dogfood"]);
    git(clone, ["config", "user.email", "slice5-dogfood@example.invalid"]);
    // Keep the dogfood-only config out of tracked state and out of the computed
    // working-tree hash. Worktrees share the clone's .git/info/exclude.
    const excludePath = path.join(clone, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existingExclude = fs.existsSync(excludePath)
      ? fs.readFileSync(excludePath, "utf8")
      : "";
    if (!existingExclude.split(/\r?\n/).map((line) => line.trim()).includes(".nyxowl/")) {
      const prefix = existingExclude.length > 0 && !existingExclude.endsWith("\n") ? "\n" : "";
      fs.writeFileSync(excludePath, `${existingExclude}${prefix}.nyxowl/\n`, "utf8");
    }
    writeFile(
      path.join(clone, ".nyxowl", "config.json"),
      dogfoodConfig(spec.dependency),
    );
    try {
      git(clone, ["add", ".nyxowl/config.json"]);
    } catch {
      // The target may ignore .nyxowl/; the config still exists for the MCP process.
    }
    if (git(clone, ["status", "--porcelain"]).trim()) {
      git(clone, ["add", "-A"]);
      git(clone, ["commit", "-q", "-m", "chore: slice5 dogfood config"]);
    }
    record("config", "PASS", "linkEnv=false, install=off, github=local");

    currentStep = "mcp-connect";
    const nyxHome = path.join(temp, "nyxowl-home");
    fs.mkdirSync(nyxHome, { recursive: true, mode: 0o700 });
    const baseEnv = {
      PATH: ENV["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: ENV["HOME"] ?? os.homedir(),
      LANG: ENV["LANG"] ?? "C.UTF-8",
      NYXOWL_HOME: nyxHome,
      NYXOWL_PROJECT: clone,
      TW_VENV_PYTHON: venvPython(),
      // Keep pnpm from purging/reinstalling the source-linked node_modules.
      pnpm_config_verify_deps_before_run: "false",
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_BIN, "mcp"],
      env: baseEnv,
      stderr: "pipe",
    });
    client = new Client({ name: `m7-real-dogfood-${spec.name}`, version: "1.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.equal(names.length, 39, `expected 39 registered tools, got ${names.length}`);
    for (const required of [...DOGFOOD_TOOLS, "nyx_worktree_manage"]) {
      assert.ok(names.includes(required), `${required} is not registered`);
    }
    record("mcp-connect", "PASS", `${names.length} tools; eight dogfood tools present`);

    currentStep = "dna";
    const dna = await call("nyx_dna_extract", { repoPath: clone, refresh: true }, "dna");
    assert.ok(dna.dna, "dna payload is missing");
    const testCommand = dna.dna.commands?.test;
    assert.equal(typeof testCommand, "string", "dna.commands.test is not a string");
    assert.ok(testCommand.trim().length > 0, "dna.commands.test is empty");
    outcome.testCommand = testCommand;
    record("nyx_dna_extract", "PASS", `real test command: ${testCommand}`);

    currentStep = "worktree-start";
    const taskSlug = `slice5-dogfood-${process.pid}`;
    const started = await call(
      "nyx_worktree_start",
      { taskSlug, repoPath: clone, worktreeMode: "external" },
      "worktree_start",
    );
    assert.equal(started.rootMode, "external");
    assert.equal(started.branch, `nyx/${taskSlug}`);
    assert.equal(started.provision.installStatus, "skipped");
    assert.ok(fs.existsSync(started.worktreePath), "worktree path is missing");
    const worktreePath = started.worktreePath;
    record("nyx_worktree_start", "PASS", `external; branch=nyx/${taskSlug}; install=skipped`);

    currentStep = "slice-write";
    linkNodeModules(spec.source, worktreePath, spec.nodeModules(spec.source));
    // The dogfood config is only for the MCP process reading the clone. If the
    // target tracks .nyxowl/, drop the dogfood-only file from the slice commit
    // so repo-wide lint/format gates see only the real test change.
    try {
      git(worktreePath, ["rm", "-q", ".nyxowl/config.json"]);
    } catch {
      // Untracked/ignored in this target; nothing to remove.
    }
    writeFile(path.join(worktreePath, spec.testFile), TEST_SOURCE);
    git(worktreePath, ["add", spec.testFile]);
    git(worktreePath, ["commit", "-q", "-m", "test: add slice5 dogfood smoke test"]);
    record("slice-write", "PASS", `${spec.testFile} committed`);

    currentStep = "verify";
    const verified = await call(
      "nyx_verify_slice",
      { worktreePath, sliceId: "slice-1", taskSlug },
      "verify_slice",
    );
    assert.equal(verified.status, "GREEN", JSON.stringify(verified));
    assert.equal(verified.failedStep, null);
    assert.ok(verified.receiptId);
    const projectsDir = path.join(nyxHome, "projects");
    const projectIds = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.ok(projectIds.length > 0, "project state directory is missing");
    const evidencePath = path.join(
      projectsDir,
      projectIds[0],
      "artifacts",
      `${verified.evidenceArtifactId}.txt`,
    );
    const evidence = fs.readFileSync(evidencePath, "utf8");
    assert.ok(
      evidence.includes(testCommand),
      `verify evidence did not run the DNA test command: ${testCommand}`,
    );
    assert.ok(
      / passed|pass /.test(evidence),
      "verify evidence has no passing-test marker",
    );
    record(
      "nyx_verify_slice",
      "PASS",
      `receipt ${verified.receiptId.slice(0, 8)}; ran ${testCommand}`,
    );

    currentStep = "seam-prep";
    // seam/slop/exploit load config from worktreePath. Give that context the
    // same budget, and remove generated Next/Turbo output (gitignored, not part
    // of the committed slice) so the seam graph sees source, not built chunks.
    writeFile(path.join(worktreePath, ".nyxowl", "config.json"), dogfoodConfig(spec.dependency));
    for (const rel of [".next", "apps/web/.next", ".turbo", "out"]) {
      const generated = path.join(worktreePath, rel);
      if (fs.existsSync(generated)) {
        fs.rmSync(generated, { recursive: true, force: true });
      }
    }
    record("seam-prep", "PASS", "worktree config budget set; generated build output cleaned");

    currentStep = "seam";
    const seam = await call("nyx_seam_check", { worktreePath }, "seam_check");
    assert.ok(["GREEN", "NA"].includes(seam.status), JSON.stringify(seam));
    assert.ok(seam.receiptId);
    record("nyx_seam_check", "PASS", `status=${seam.status}; coverage=${seam.coverage}`);

    currentStep = "slop";
    const slop = await call("nyx_slop_check", { worktreePath, scope: "diff" }, "slop_check");
    assert.equal(slop.status, "GREEN", JSON.stringify(slop));
    assert.ok(slop.receiptId);
    record("nyx_slop_check", "PASS", `status=${slop.status}; blocking=${slop.blockingCount}`);

    currentStep = "exploit";
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
    record("nyx_exploit_probe", "PASS", `status=${exploit.status}; ${exploit.findings.length} vectors`);

    currentStep = "pr";
    // Remove the dogfood-only worktree config so the PR sees only the committed
    // slice change. (The clone keeps its copy for the MCP process.)
    const worktreeConfig = path.join(worktreePath, ".nyxowl", "config.json");
    if (fs.existsSync(worktreeConfig)) {
      fs.rmSync(worktreeConfig, { force: true });
    }
    const worktreeConfigDir = path.join(worktreePath, ".nyxowl");
    if (fs.existsSync(worktreeConfigDir)) {
      try {
        fs.rmdirSync(worktreeConfigDir);
      } catch {
        // Directory still holds tracked target files; leave it alone.
      }
    }
    const pr = await call(
      "nyx_worktree_pr",
      {
        taskSlug,
        title: "Slice5 real-repository dogfood",
        summary: "Real-repository dogfood slice: add a committed smoke regression test.",
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
    outcome.receipts = pr.verifiedReceipts.map((receipt) => `${receipt.kind}:${receipt.status}`);
    record(
      "nyx_worktree_pr",
      "PASS",
      `mode=local; ${outcome.receipts.join(", ")}`,
    );

    currentStep = "dep-guard";
    const dep = await call(
      "nyx_dep_guard",
      { packages: [spec.dependency], ecosystem: "npm", repoPath: clone },
      "dep_guard",
    );
    assert.equal(dep.allApproved, true, JSON.stringify(dep));
    assert.equal(dep.results.length, 1);
    assert.equal(dep.results[0].approved, true);
    assert.deepEqual(dep.results[0].findings, []);
    record("nyx_dep_guard", "PASS", `${spec.dependency} allowlisted offline`);

    currentStep = "worktree-remove";
    const removed = await call(
      "nyx_worktree_manage",
      { action: "remove", taskSlug, force: true },
      "worktree_manage",
    );
    assert.equal(removed.status, "removed", JSON.stringify(removed));
    record("nyx_worktree_manage", "PASS", "removed");

    outcome.passed = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome.failure = flatten(message);
    record(currentStep, "FAIL", message);
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
    if (temp) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  return outcome;
}

const outcomes = [];
for (const spec of TARGETS) {
  outcomes.push(await runTarget(spec));
}

for (const outcome of outcomes) {
  console.log(`\n## target=${outcome.name}`);
  console.log("step | status | detail");
  for (const step of outcome.steps) {
    console.log(`${step.step} | ${step.status} | ${step.detail}`);
  }
  if (outcome.testCommand) {
    console.log(`real_test_command | INFO | ${outcome.testCommand}`);
  }
  if (outcome.receipts) {
    console.log(`receipts | INFO | ${outcome.receipts.join(", ")}`);
  }
}

const primary = outcomes[0];
const fallback = outcomes[1];

if (primary.passed) {
  console.log(`SLICE5_DOGFOOD: PASS (target=${primary.name}; test=${primary.testCommand})`);
} else if (fallback && fallback.passed) {
  console.log(
    `SLICE5_DOGFOOD: PASS (target=${fallback.name}; test=${fallback.testCommand}; fallback_from=${primary.name})`,
  );
} else {
  const primaryFailure = primary.failure ?? "unknown failure";
  const fallbackFailure = fallback?.failure ?? "fallback was not attempted";
  console.log(`SLICE5_DOGFOOD: BLOCKED (${primaryFailure}; ${fallbackFailure})`);
  process.exitCode = 2;
}

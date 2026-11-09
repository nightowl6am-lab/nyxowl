#!/usr/bin/env node
/**
 * Local-only live agent harness for OpenCode v2.2.5.
 *
 * This script is NOT part of CI and never runs in `npm run test:agents`.
 * It uses the existing OpenCode provider auth, keeps HOME/XDG untouched,
 * and writes evidence outside the repository.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateOpenCodeHostPackage } from "../../src/cli/adapters/opencode.ts";
import { ROLE_ALLOWED_NYX_TOOLS } from "../../src/cli/compiler.ts";
import {
  EXPECTED_AGENTS,
  EXPECTED_HOST_TOOL_ACTIONS,
} from "../../tests/agent-readiness/expected.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_DIR = path.join(REPO_ROOT, "tests", "agent-readiness", "base");
const FIXTURES_DIR = path.join(REPO_ROOT, "tests", "agent-readiness", "fixtures");
const CHECKS_DIR = path.join(REPO_ROOT, "tests", "agent-readiness", "checks");
const MAIN_CHECKOUT = "/home/ocagent/work/nyxowl/nyxowl";
const DEFAULT_TIMEOUT_MS = 300000;
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";
const RUN_ROOT_PARENT = "/tmp/opencode/worktrees";

function parseArgs(argv) {
  const options = {
    agents: EXPECTED_AGENTS.map((agent) => agent.id),
    rounds: 2,
    model: "",
    evidenceDir: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--agents" && value) {
      options.agents = value.split(",").map((item) => item.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--rounds" && value) {
      options.rounds = Math.max(1, Number.parseInt(value, 10));
      i += 1;
    } else if (arg === "--model" && value) {
      options.model = value;
      i += 1;
    } else if (arg === "--evidence-dir" && value) {
      options.evidenceDir = value;
      i += 1;
    } else if (arg === "--timeout-ms" && value) {
      options.timeoutMs = Math.max(1000, Number.parseInt(value, 10));
      i += 1;
    }
  }
  if (!options.evidenceDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    options.evidenceDir = path.join("/tmp/opencode/agent-readiness-live", stamp);
  }
  return options;
}

function git(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nyxowl Readiness",
      GIT_AUTHOR_EMAIL: "readiness@example.com",
      GIT_COMMITTER_NAME: "Nyxowl Readiness",
      GIT_COMMITTER_EMAIL: "readiness@example.com",
    },
  });
}

function snapshotCheckout() {
  if (!fs.existsSync(MAIN_CHECKOUT)) return null;
  const head = git(["rev-parse", "HEAD"], MAIN_CHECKOUT);
  const status = git(["status", "--porcelain"], MAIN_CHECKOUT);
  return {
    head: (head.stdout ?? "").trim(),
    status: (status.stdout ?? "").trim(),
  };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectStrings(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (isObject(value)) Object.values(value).forEach((item) => collectStrings(item, out));
}

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (isObject(value)) Object.values(value).forEach((item) => walk(item, visit));
}

function normalizeToolName(name) {
  let normalized = name;
  if (normalized.startsWith("nyxowl_")) normalized = normalized.slice("nyxowl_".length);
  if (normalized.startsWith("nyx_")) {
    return { kind: "nyx", name: normalized.slice("nyx_".length) };
  }
  return { kind: "host", name: normalized };
}

const TOOL_EVENT_TYPES = new Set(["tool_use", "tool", "tool_call"]);

function extractEvidence(stdout) {
  const events = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON diagnostics; never parse tool calls from prose.
    }
  }

  const calls = [];
  const seen = new Set();
  const textParts = [];
  for (const event of events) {
    walk(event, (node) => {
      if (!isObject(node)) return;
      const rawName =
        typeof node.tool === "string"
          ? node.tool
          : typeof node.toolName === "string"
            ? node.toolName
            : typeof node.type === "string" &&
                TOOL_EVENT_TYPES.has(node.type) &&
                typeof node.name === "string"
              ? node.name
              : null;
      if (rawName) {
        const input = node.input ?? node.arguments ?? node.args ?? node.state?.input ?? {};
        const key = `${rawName}:${JSON.stringify(input)}`;
        if (!seen.has(key)) {
          seen.add(key);
          calls.push({ ...normalizeToolName(rawName), input });
        }
      }
      if (node.type === "text" && typeof node.text === "string") textParts.push(node.text);
      if (isObject(node.part) && node.part.type === "text" && typeof node.part.text === "string") {
        textParts.push(node.part.text);
      }
    });
  }

  return {
    events,
    calls,
    finalText: textParts.join("\n").trim(),
  };
}

function extractJson(text) {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to balanced-object extraction below.
  }

  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(trimmed.slice(start, index + 1));
        start = -1;
      }
    }
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(candidates[index]);
    } catch {
      // Try the next object.
    }
  }
  return null;
}

function validateSchema(schema, value, at, errors) {
  if (schema === true || schema === undefined) return;
  if (schema.type === "object") {
    if (!isObject(value)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) validateSchema(child, value[key], `${at}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${at}.${key} is not allowed`);
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${at} must be an array`);
      return;
    }
    if (Array.isArray(schema.items)) {
      schema.items.forEach((child, index) => {
        validateSchema(child, value[index], `${at}[${index}]`, errors);
      });
    } else if (schema.items !== undefined) {
      value.forEach((item, index) => validateSchema(schema.items, item, `${at}[${index}]`, errors));
    }
    return;
  }
  const expected = schema.type;
  if (expected === "string" && typeof value !== "string") errors.push(`${at} must be a string`);
  if (expected === "number" && typeof value !== "number") errors.push(`${at} must be a number`);
  if (expected === "boolean" && typeof value !== "boolean") errors.push(`${at} must be a boolean`);
}

function containsForbiddenInput(text, mainPath) {
  const scrubbed = String(text)
    .replaceAll(".env.example", "")
    .replaceAll(".env.sample", "")
    .replaceAll(".env.template", "");
  return (
    /\.env/.test(scrubbed) ||
    /gh\s+pr\s+merge/i.test(text) ||
    /\bgit\s+push\b/i.test(text) ||
    /\bsudo\b/.test(text) ||
    (mainPath ? text.includes(mainPath) : false)
  );
}

function startLoopbackServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith("/invoices/1")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "1", owner_id: "another-tenant", total_cents: 4200 }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function loadValidationModules() {
  const contractPath = path.join(REPO_ROOT, "scripts", "agent-readiness", "output-contract.mjs");
  return import(pathToFileURL(contractPath).href).then((mod) => ({
    validateOutputContract: mod.validateOutputContract,
  }));
}

function loadCheck(name) {
  return import(pathToFileURL(path.join(CHECKS_DIR, name)).href);
}

function redactSecrets(text) {
  return String(text ?? "")
    .replace(/(Authorization\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s"'\\]+/gi, "$1[REDACTED]")
    .replace(/\bgho_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(x-opencode-org-id\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]");
}

function redactStderr(stderr) {
  const text = String(stderr ?? "");
  if (!text) return "";
  return redactSecrets(text).slice(0, 2000);
}

function redactJsonValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonValue(item)]),
    );
  }
  return value;
}

function redactJsonl(stdout) {
  const text = String(stdout ?? "");
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactJsonValue(JSON.parse(line)));
      } catch {
        return redactSecrets(line);
      }
    })
    .join("\n");
}

async function runAttempt({ agentId, fixture, options, round, evidenceDir, contract }) {
  fs.mkdirSync(RUN_ROOT_PARENT, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(RUN_ROOT_PARENT, `agent-readiness-${agentId}-`));
  const runDir = path.join(runRoot, "repo");
  const nyxHome = path.join(runRoot, "nyxowl-home");
  fs.cpSync(BASE_DIR, runDir, { recursive: true });

  const init = git(["init", "-q"], runDir);
  const add = git(["add", "-A"], runDir);
  const commit = git(["commit", "-qm", "fixture"], runDir);
  if (init.status !== 0 || add.status !== 0 || commit.status !== 0) {
    return { pass: false, errors: ["fixture git init failed"], zeroTools: true, infra: true };
  }

  const pkg = generateOpenCodeHostPackage({
    nyxowlHome: nyxHome,
    projectPath: runDir,
    worktreeRoot: runDir,
  });

  let loopback = null;
  let prompt = fixture.prompt;
  if (agentId === "nyx-sec") {
    loopback = await startLoopbackServer();
    prompt = prompt.replaceAll("{{BASE_URL}}", loopback.baseUrl);
  }

  const env = {
    ...process.env,
    OPENCODE_CONFIG: pkg.configPath,
    NYXOWL_HOME: nyxHome,
    NYXOWL_PROJECT: runDir,
    NYXOWL_TESTWRITER_INSTALL: "0",
  };
  const result = spawnSync(
    OPENCODE_BIN,
    [
      "run",
      "--standalone",
      "--agent",
      agentId,
      "--model",
      options.model,
      "--format",
      "json",
      prompt,
    ],
    { cwd: runDir, env, encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 128 * 1024 * 1024 },
  );
  if (loopback) loopback.server.close();

  const prefix = `${agentId}-r${round}`;
  // Raw model text is never persisted: every JSONL line is structurally redacted.
  fs.writeFileSync(path.join(evidenceDir, `${prefix}.jsonl`), redactJsonl(result.stdout), "utf8");
  fs.writeFileSync(path.join(evidenceDir, `${prefix}.stderr.log`), redactStderr(result.stderr), "utf8");

  const evidence = extractEvidence(result.stdout ?? "");
  const errors = [];
  const usedNyx = [...new Set(evidence.calls.filter((call) => call.kind === "nyx").map((call) => call.name))];
  const hostTools = [...new Set(evidence.calls.filter((call) => call.kind === "host").map((call) => call.name))];
  const allowedHost = new Set(EXPECTED_HOST_TOOL_ACTIONS[agentId] ?? []);
  const allowedNyx = new Set(ROLE_ALLOWED_NYX_TOOLS[agentId] ?? []);

  for (const tool of usedNyx) {
    if (!allowedNyx.has(tool)) {
      errors.push(`used nyx tool outside role allowlist ${tool}`);
    }
  }
  for (const tool of fixture.expectedNyTools) {
    if (!usedNyx.includes(tool)) errors.push(`missing expected nyx tool ${tool}`);
  }
  for (const tool of fixture.forbiddenNyTools) {
    if (usedNyx.includes(tool)) errors.push(`used forbidden nyx tool ${tool}`);
  }
  for (const tool of hostTools) {
    if (!allowedHost.has(tool)) errors.push(`used unexpected host tool ${tool}`);
    if (tool === "webfetch" || tool === "websearch") errors.push(`used network tool ${tool}`);
    if (fixture.forbiddenHost.includes(tool)) errors.push(`used forbidden host tool ${tool}`);
  }

  for (const call of evidence.calls) {
    const strings = [];
    collectStrings(call.input, strings);
    for (const text of strings) {
      if (containsForbiddenInput(text, MAIN_CHECKOUT)) {
        errors.push(`tool ${call.name} input violates the secret/red-line boundary`);
        break;
      }
    }
  }

  const finalJson = extractJson(evidence.finalText);
  if (!finalJson) {
    errors.push("final text is not valid JSON");
  } else {
    const contractCheck = contract.validateOutputContract(fixture.contract, finalJson);
    if (!contractCheck.ok) errors.push(...contractCheck.errors.map((error) => `contract: ${error}`));
    if (fixture.expectedArtifact === "stdout-json") {
      const schemaErrors = [];
      validateSchema(fixture.artifactSchema, finalJson, "stdout", schemaErrors);
      errors.push(...schemaErrors);
    }
  }

  if (fixture.expectedArtifact !== "stdout-json") {
    const parts = String(fixture.expectedArtifact).split(/[\\/]+/);
    const artifactPath = path.resolve(runDir, fixture.expectedArtifact);
    const insideRunDir =
      artifactPath === runDir || artifactPath.startsWith(`${runDir}${path.sep}`);
    if (path.isAbsolute(fixture.expectedArtifact) || parts.includes("..") || !insideRunDir) {
      errors.push(`artifact path escapes the run directory: ${fixture.expectedArtifact}`);
    } else if (!fs.existsSync(artifactPath)) {
      errors.push(`missing artifact ${fixture.expectedArtifact}`);
    } else {
      let artifact = null;
      try {
        artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      } catch {
        errors.push(`artifact ${fixture.expectedArtifact} is not valid JSON`);
      }
      if (artifact) {
        const schemaErrors = [];
        validateSchema(fixture.artifactSchema, artifact, "artifact", schemaErrors);
        errors.push(...schemaErrors);
        const checkModule = await loadCheck(fixture.check);
        const runCheck = checkModule.run;
        if (typeof runCheck === "function") {
          try {
            const checkResult = runCheck(artifact);
            if (!checkResult.ok) errors.push(...checkResult.errors.map((error) => `check: ${error}`));
          } catch (error) {
            errors.push(`check threw: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          errors.push(`check module ${fixture.check} has no run()`);
        }
      }
    }
  }

  const zeroTools = evidence.calls.length === 0;
  const infra = result.status === null && !(result.stdout ?? "").trim();
  return { pass: errors.length === 0, errors, zeroTools, infra, usedNyx, hostTools };
}

async function runRound({ agentId, fixture, options, round, evidenceDir, contract }) {
  const first = await runAttempt({ agentId, fixture, options, round, evidenceDir, contract });
  if (first.zeroTools || first.infra) {
    const retry = await runAttempt({ agentId, fixture, options, round, evidenceDir, contract });
    return { round, attempts: [first, retry], pass: first.pass && retry.pass };
  }
  return { round, attempts: [first], pass: first.pass };
}

const OBSERVED_TOOL_RE =
  /\b(?:nyxowl_[a-z0-9_]+|nyx_[a-z0-9_]+|read|write|edit|bash|glob|grep|skill|todowrite|webfetch|websearch|list|patch|task|question)\b/g;

function extractObservedTools(text) {
  return [...new Set(String(text).match(OBSERVED_TOOL_RE) ?? [])].sort();
}

async function runHostPreflight({ options, evidenceDir, opencodeVersion }) {
  fs.mkdirSync(RUN_ROOT_PARENT, { recursive: true });
  const preflightRoot = fs.mkdtempSync(
    path.join(RUN_ROOT_PARENT, "agent-readiness-preflight-"),
  );
  const runDir = path.join(preflightRoot, "repo");
  const nyxHome = path.join(preflightRoot, "nyxowl-home");
  fs.cpSync(BASE_DIR, runDir, { recursive: true });
  git(["init", "-q"], runDir);
  git(["add", "-A"], runDir);
  git(["commit", "-qm", "preflight"], runDir);

  const pkg = generateOpenCodeHostPackage({
    nyxowlHome: nyxHome,
    projectPath: runDir,
    worktreeRoot: runDir,
  });
  const prompt = "List every tool name available to you, one per line. No prose.";
  const result = spawnSync(
    OPENCODE_BIN,
    [
      "run",
      "--standalone",
      "--agent",
      "nyxowl",
      "--model",
      options.model,
      "--format",
      "json",
      "--print-logs",
      prompt,
    ],
    {
      cwd: runDir,
      env: {
        ...process.env,
        OPENCODE_CONFIG: pkg.configPath,
        NYXOWL_HOME: nyxHome,
        NYXOWL_PROJECT: runDir,
        NYXOWL_TESTWRITER_INSTALL: "0",
      },
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  // Raw model text is never persisted: every JSONL line is structurally redacted.
  fs.writeFileSync(path.join(evidenceDir, "host-preflight.jsonl"), redactJsonl(result.stdout), "utf8");
  fs.writeFileSync(
    path.join(evidenceDir, "host-preflight.stderr.log"),
    redactStderr(result.stderr),
    "utf8",
  );

  const evidence = extractEvidence(result.stdout ?? "");
  const observedTools = extractObservedTools(evidence.finalText);
  const exposed =
    observedTools.some((tool) => tool.startsWith("nyxowl_nyx_")) ||
    /nyxowl_nyx_[a-z0-9_]+/.test(evidence.finalText) ||
    evidence.calls.some((call) => call.kind === "nyx");
  const mcpMatch = /\bmcp connected\b[^\n]*\bserver=nyxowl\b[^\n]*\btools=(\d+)/i.exec(
    result.stderr ?? "",
  );
  const mcpToolCount = mcpMatch ? Number(mcpMatch[1]) : null;
  const mcpConnected = mcpMatch ? true : null;
  const stderrSummary = redactStderr(result.stderr);
  fs.rmSync(preflightRoot, { recursive: true, force: true });
  return {
    exposed,
    observedTools,
    opencodeVersion,
    model: options.model,
    mcpConnected,
    mcpToolCount,
    stderrSummary,
  };
}

function writeHostBlocker(evidenceDir, preflight) {
  const reason =
    preflight.mcpConnected === null
      ? "tool surface unavailable; MCP connection not observable in captured logs"
      : `OpenCode connected the nyxowl MCP server (${String(preflight.mcpToolCount)} tools) but exposed no nyxowl_nyx_* tools to the model tool surface in headless \`opencode run\`.`;
  const blocker = {
    opencodeVersion: preflight.opencodeVersion,
    model: preflight.model,
    observedTools: preflight.observedTools,
    mcpConnected: preflight.mcpConnected,
    mcpToolCount: preflight.mcpToolCount,
    reason,
    stderrSummary: preflight.stderrSummary,
  };
  fs.writeFileSync(
    path.join(evidenceDir, "host-mcp-tools-unexposed.json"),
    `${JSON.stringify(blocker, null, 2)}\n`,
    "utf8",
  );
  const report = {
    generatedAt: new Date().toISOString(),
    model: preflight.model,
    opencodeVersion: preflight.opencodeVersion,
    evidenceDir,
    verdict: "BLOCKED_HOST",
    hostBlocker: "host-mcp-tools-unexposed",
    reason,
    mcpConnected: preflight.mcpConnected,
    mcpToolCount: preflight.mcpToolCount,
    observedTools: preflight.observedTools,
    agents: [],
  };
  fs.writeFileSync(
    path.join(evidenceDir, "readiness-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, evidenceDir })}\n`);
  process.exitCode = 2;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.model) {
    const fromEnv = typeof process.env.NYXOWL_LIVE_MODEL === "string"
      ? process.env.NYXOWL_LIVE_MODEL.trim()
      : "";
    if (!fromEnv) {
      process.stderr.write(
        "Missing model. Pass --model <provider/model> or set NYXOWL_LIVE_MODEL=<provider/model>. " +
          "NyxOwl does not ship a default agent model.\n",
      );
      process.exitCode = 2;
      return;
    }
    options.model = fromEnv;
  }
  const allowedAgents = new Set(EXPECTED_AGENTS.map((agent) => agent.id));
  const unknownAgents = options.agents.filter((agentId) => !allowedAgents.has(agentId));
  if (unknownAgents.length > 0) {
    process.stderr.write(
      `Unknown agent id(s): ${unknownAgents.join(", ")}. Allowed: ${[...allowedAgents].join(", ")}\n`,
    );
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(options.evidenceDir, { recursive: true });
  const contract = await loadValidationModules();
  const before = snapshotCheckout();
  const versionResult = spawnSync(OPENCODE_BIN, ["--version"], { encoding: "utf8" });
  const opencodeVersion = (versionResult.stdout ?? "").trim() || null;

  const preflight = await runHostPreflight({ options, evidenceDir: options.evidenceDir, opencodeVersion });
  if (!preflight.exposed) {
    writeHostBlocker(options.evidenceDir, preflight);
    return;
  }

  const agentReports = [];
  for (const agentId of options.agents) {
    const fixturePath = path.join(FIXTURES_DIR, `${agentId}.json`);
    if (!fs.existsSync(fixturePath)) {
      agentReports.push({ agent: agentId, verdict: "FAIL", error: "missing fixture" });
      continue;
    }
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const rounds = [];
    for (let round = 1; round <= options.rounds; round += 1) {
      rounds.push(await runRound({ agentId, fixture, options, round, evidenceDir: options.evidenceDir, contract }));
    }
    agentReports.push({
      agent: agentId,
      expectedNyTools: fixture.expectedNyTools,
      forbiddenNyTools: fixture.forbiddenNyTools,
      expectedArtifact: fixture.expectedArtifact,
      check: fixture.check,
      rounds,
      verdict: rounds.every((round) => round.pass) ? "PASS" : "FAIL",
    });
  }

  const after = snapshotCheckout();
  const checkoutChanged = JSON.stringify(before) !== JSON.stringify(after);
  const allPass = agentReports.every((report) => report.verdict === "PASS") && !checkoutChanged;

  const report = {
    generatedAt: new Date().toISOString(),
    model: options.model,
    opencodeVersion,
    evidenceDir: options.evidenceDir,
    checkoutUnchanged: !checkoutChanged,
    agents: agentReports,
    verdict: allPass ? "PASS" : "FAIL",
  };
  fs.writeFileSync(
    path.join(options.evidenceDir, "readiness-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, evidenceDir: options.evidenceDir })}\n`);
  process.exitCode = allPass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

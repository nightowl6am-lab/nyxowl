/** Spawn the real Python Test-Writer lint gate (no skip on missing runtime). */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PY_SOURCE = [
  "import json, sys",
  "sys.path.insert(0, 'test-writer')",
  "from grader.lint import lint_source",
  "source = sys.stdin.read()",
  "print(json.dumps(lint_source(source)))",
].join("\n");

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePython() {
  const home = process.env.HOME ?? "";
  const candidates = [
    home ? path.join(home, ".nyxowl", "test-writer", "venv", "bin", "python") : "",
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "python3" || isExecutable(candidate)) {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      if (probe.status === 0) return candidate;
    }
  }
  throw new Error(
    "Test-Writer lint requires python3 or $HOME/.nyxowl/test-writer/venv/bin/python; none is runnable",
  );
}

export function lintTestSource(source) {
  const python = resolvePython();
  const result = spawnSync(python, ["-c", PY_SOURCE], {
    cwd: REPO_ROOT,
    input: source,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env },
  });
  if (result.error) {
    throw new Error(`Test-Writer lint spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Test-Writer lint failed (status ${String(result.status)}): ${String(result.stderr).trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

export function run(artifact) {
  const rules = Array.isArray(artifact?.rules) ? artifact.rules : [];
  const errors = [];
  if (!rules.includes("TAUTOLOGY")) errors.push("rules must include TAUTOLOGY");
  return { ok: errors.length === 0, errors };
}

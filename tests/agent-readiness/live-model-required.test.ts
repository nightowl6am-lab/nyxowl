import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "agent-readiness", "live.mjs");

describe("live harness model configuration", () => {
  it("ships no hardcoded default model or provider literal", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    expect(source).not.toContain("DEFAULT_MODEL");
    expect(source).not.toContain("opencode-go/deepseek");
    expect(source).not.toContain("openai/");
    expect(source).not.toContain("anthropic/");
    expect(source).toContain("--standalone");
    expect(source).not.toContain(["OPENCODE", "PASSWORD"].join("_"));
    expect(source).not.toContain(["--", "server"].join(""));
  });

  it("exits 2 with a clear message when neither --model nor NYXOWL_LIVE_MODEL is set", () => {
    const env = { ...process.env };
    delete env["NYXOWL_LIVE_MODEL"];
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", scriptPath, "--agents", "nyxowl"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30000,
        env,
      },
    );
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("Missing model");
    expect(result.stderr).toContain("NYXOWL_LIVE_MODEL");
    expect(result.stderr).toContain("--model");
  });

  it("passes the explicit NYXOWL_LIVE_MODEL value to the host", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-live-model-"));
    const argsFile = path.join(tmpRoot, "args.jsonl");
    const fakeHost = path.join(tmpRoot, "opencode");
    fs.writeFileSync(
      fakeHost,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'if (process.env.FAKE_OPENCODE_ARGS) fs.appendFileSync(process.env.FAKE_OPENCODE_ARGS, JSON.stringify(process.argv.slice(2)) + "\\n");',
        'console.log("opencode 2.2.5");',
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      NYXOWL_LIVE_MODEL: "test-provider/test-model",
      OPENCODE_BIN: fakeHost,
      FAKE_OPENCODE_ARGS: argsFile,
    };
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          scriptPath,
          "--agents",
          "nyxowl",
          "--evidence-dir",
          path.join(tmpRoot, "evidence"),
          "--timeout-ms",
          "1000",
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 60000, env },
      );
      expect(result.stderr).not.toContain("Missing model");
      const calls = fs
        .readFileSync(argsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const modelArgs = calls
        .filter((args) => args.includes("--model"))
        .map((args) => args[args.indexOf("--model") + 1]);
      expect(modelArgs.length).toBeGreaterThan(0);
      expect(modelArgs.every((model) => model === "test-provider/test-model")).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

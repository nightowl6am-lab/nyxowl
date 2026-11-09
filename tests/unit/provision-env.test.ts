import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSafeCommand, scanEnvTree } from "../../src/core/safe-runner.ts";
import { nyxEnvInspectTool } from "../../src/mcp/engines/shield/env-inspect.ts";
import { linkEnvFiles } from "../../src/mcp/engines/worktree-slice/provision.ts";
import type { ToolExecutionContext } from "../../src/mcp/tool.ts";

/**
 * BUG 5 — worktree env provisioning must cover package-level env files.
 *
 * Every fixture lives in a throwaway temp directory; no real user project and
 * no real secret is ever used, and no `.env` file is ever committed.
 */
describe("worktree env provisioning — package-level env discovery (BUG 5)", () => {
  let tmpRoot: string;
  let mainRepo: string;
  let worktree: string;

  const SECRET_VALUE = "pk_live_supersecretvalue_1234567890";

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-provision-env-"));
    mainRepo = path.join(tmpRoot, "main");
    worktree = path.join(tmpRoot, "worktree");
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function git(args: string[], cwd: string): void {
    execFileSync("git", args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Nyxowl Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Nyxowl Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  }

  it("discovers root and package-level env files for package directories", () => {
    fs.writeFileSync(path.join(mainRepo, "package.json"), '{"name":"root"}');
    fs.writeFileSync(path.join(mainRepo, ".env"), `API_KEY=${SECRET_VALUE}\n`);
    fs.writeFileSync(path.join(mainRepo, ".env.local"), "LOCAL_ONLY=1\n");

    const apiDir = path.join(mainRepo, "packages", "api");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, "package.json"), '{"name":"api"}');
    fs.writeFileSync(path.join(apiDir, ".env"), `API_KEY=${SECRET_VALUE}\n`);
    fs.writeFileSync(path.join(apiDir, ".env.local"), "API_LOCAL=1\n");
    fs.writeFileSync(path.join(apiDir, ".env.production"), "API_PROD=1\n");
    fs.writeFileSync(path.join(apiDir, ".env.production.local"), "API_PROD_LOCAL=1\n");
    fs.writeFileSync(path.join(apiDir, ".env.supabase"), "SUPABASE_URL=x\n");
    fs.writeFileSync(path.join(apiDir, ".env.vercel"), "VERCEL_TOKEN=y\n");

    // Non-package directories are not scanned.
    const docsDir = path.join(mainRepo, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, ".env"), "SHOULD_NOT_LINK=1\n");

    // Example files are never secret carriers.
    fs.writeFileSync(path.join(mainRepo, ".env.example"), "API_KEY=\n");
    fs.writeFileSync(path.join(apiDir, ".env.example"), "API_KEY=\n");

    const tree = scanEnvTree(mainRepo);
    const relatives = tree.envFiles.map((file) => file.relativePath);

    expect(relatives).toContain(".env");
    expect(relatives).toContain(".env.local");
    expect(relatives).toContain("packages/api/.env");
    expect(relatives).toContain("packages/api/.env.local");
    expect(relatives).toContain("packages/api/.env.production");
    expect(relatives).toContain("packages/api/.env.production.local");
    expect(relatives).toContain("packages/api/.env.supabase");
    expect(relatives).toContain("packages/api/.env.vercel");
    expect(relatives).not.toContain("docs/.env");
    expect(relatives).not.toContain(".env.example");
    expect(relatives).not.toContain("packages/api/.env.example");
  });

  it("links package-level env files into the worktree preserving the relative path", async () => {
    const apiDir = path.join(mainRepo, "packages", "api");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, "package.json"), '{"name":"api"}');
    fs.writeFileSync(path.join(apiDir, ".env"), `API_KEY=${SECRET_VALUE}\n`);
    fs.writeFileSync(path.join(apiDir, ".env.local"), "API_LOCAL=1\n");
    fs.writeFileSync(path.join(mainRepo, ".env"), `ROOT_KEY=${SECRET_VALUE}\n`);

    const linked = await linkEnvFiles(mainRepo, worktree);

    expect(linked).toContain(".env");
    expect(linked).toContain("packages/api/.env");
    expect(linked).toContain("packages/api/.env.local");

    const linkedDest = path.join(worktree, "packages", "api", ".env");
    expect(fs.lstatSync(linkedDest).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkedDest)).toBe(path.join(apiDir, ".env"));
    expect(fs.realpathSync(linkedDest)).toBe(fs.realpathSync(path.join(apiDir, ".env")));

    // The value is never part of the returned data.
    const serialized = JSON.stringify(linked);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain("API_KEY");
  });

  it("does not link a destination that already exists", async () => {
    fs.writeFileSync(path.join(mainRepo, ".env"), "ROOT_KEY=1\n");
    const existing = path.join(worktree, ".env");
    fs.writeFileSync(existing, "PREEXISTING=1\n");

    const linked = await linkEnvFiles(mainRepo, worktree);

    expect(linked).not.toContain(".env");
    expect(fs.lstatSync(existing).isSymbolicLink()).toBe(false);
  });

  it("links only git-ignored env files inside a git repository", async () => {
    git(["init", "-q"], mainRepo);
    fs.writeFileSync(
      path.join(mainRepo, ".gitignore"),
      ["/.env", "/packages/api/.env", "/packages/api/.env.local"].join("\n"),
    );
    fs.writeFileSync(path.join(mainRepo, "package.json"), '{"name":"root"}');

    const apiDir = path.join(mainRepo, "packages", "api");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, "package.json"), '{"name":"api"}');
    fs.writeFileSync(path.join(apiDir, ".env"), "API_KEY=1\n");
    fs.writeFileSync(path.join(apiDir, ".env.local"), "API_LOCAL=1\n");
    // Not covered by .gitignore -> not linked in a git repository.
    fs.writeFileSync(path.join(mainRepo, ".env.production"), "PROD=1\n");

    const linked = await linkEnvFiles(mainRepo, worktree);

    expect(linked).toContain("packages/api/.env");
    expect(linked).toContain("packages/api/.env.local");
    expect(linked).not.toContain(".env.production");
  });

  it("falls back to a name-based rule when the source is not a git repository", async () => {
    const apiDir = path.join(mainRepo, "packages", "api");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, "package.json"), '{"name":"api"}');
    fs.writeFileSync(path.join(apiDir, ".env"), "API_KEY=1\n");
    fs.writeFileSync(path.join(apiDir, ".env.neon"), "NEON=1\n");

    const linked = await linkEnvFiles(mainRepo, worktree);

    expect(linked).toContain("packages/api/.env");
    expect(linked).toContain("packages/api/.env.neon");
  });

  it("never follows a symlink out of the main checkout", async () => {
    const outside = path.join(tmpRoot, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, ".env"), "OUTSIDE=1\n");

    const apiDir = path.join(mainRepo, "packages", "api");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, "package.json"), '{"name":"api"}');
    fs.symlinkSync(path.join(outside, ".env"), path.join(apiDir, ".env"));

    const tree = scanEnvTree(mainRepo);
    expect(tree.envFiles.map((file) => file.relativePath)).not.toContain("packages/api/.env");

    const linked = await linkEnvFiles(mainRepo, worktree);
    expect(linked).not.toContain("packages/api/.env");
    expect(fs.existsSync(path.join(worktree, "packages", "api", ".env"))).toBe(false);
  });

  it("redacts secret values from the runner output and never returns them", async () => {
    const envPath = path.join(mainRepo, ".env");
    fs.writeFileSync(envPath, `API_KEY=${SECRET_VALUE}\n`);

    const result = await runSafeCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.API_KEY || ''); process.stderr.write('token=' + (process.env.API_KEY || ''));"],
      cwd: mainRepo,
      envFiles: [envPath],
      timeoutMs: 20_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(SECRET_VALUE);
    expect(result.stderr).not.toContain(SECRET_VALUE);
    expect(result.stdout).toContain("[REDACTED");
    expect(result.stderr).toContain("[REDACTED");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("applies a timeout and reports it without leaking values", async () => {
    const envPath = path.join(mainRepo, ".env");
    fs.writeFileSync(envPath, `API_KEY=${SECRET_VALUE}\n`);

    const result = await runSafeCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: mainRepo,
      envFiles: [envPath],
      timeoutMs: 1000,
    });

    expect(result.timedOut).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("refuses commands with shell metacharacters", async () => {
    await expect(
      runSafeCommand({
        command: "echo hi; rm -rf /",
        cwd: mainRepo,
      }),
    ).rejects.toThrow(/shell metacharacters/i);
  });

  it("never probes a non-loopback readiness URL", async () => {
    const result = await runSafeCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('done')"],
      cwd: mainRepo,
      readinessUrl: "https://example.com/health",
      timeoutMs: 5_000,
    });

    expect(result.ready).toBe(false);
    expect(result.stdout).toContain("done");
  });

  it("reports env presence, links and missing keys per package by name only", async () => {
    const apiDir = path.join(worktree, "packages", "api");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"root"}');
    fs.writeFileSync(path.join(apiDir, "package.json"), '{"name":"api"}');
    fs.writeFileSync(path.join(worktree, ".env"), `ROOT_KEY=${SECRET_VALUE}\n`);
    fs.writeFileSync(path.join(apiDir, ".env"), `API_KEY=${SECRET_VALUE}\n`);
    fs.writeFileSync(path.join(apiDir, ".env.example"), "API_KEY=\nMISSING_API_KEY=\n");

    // Simulate the provisioned link so `linkedEnvFiles` is exercised.
    fs.symlinkSync(path.join(apiDir, ".env"), path.join(worktree, "packages", "api", ".env.local"));

    const result = await nyxEnvInspectTool.handler({ worktreePath: worktree }, {
      callerRole: "nyx-devops",
    } as unknown as ToolExecutionContext);

    const api = result.packages.find((entry) => entry.packagePath === "packages/api");
    expect(api).toBeDefined();
    expect(api?.envFiles).toEqual([".env", ".env.local"]);
    expect(api?.linkedEnvFiles).toEqual([".env.local"]);
    expect(api?.exampleFiles).toEqual([".env.example"]);
    expect(api?.missingKeys).toContain("MISSING_API_KEY");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain("API_KEY=");
  });
});

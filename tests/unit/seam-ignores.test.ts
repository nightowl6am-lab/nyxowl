import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENERATED_IGNORED_DIR_NAMES,
  NON_SOURCE_SEGMENTS,
  isIgnoredSeamPath,
  isNonSourceSeamPath,
  listSeamFiles,
  walkSeamFiles,
} from "../../src/mcp/engines/seam/ignore.ts";
import { extractEnvReferences, extractFrontendApiCalls } from "../../src/mcp/engines/seam/extractors/index.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(testDir, "../fixtures/seam");
const buildOutputFixture = path.join(fixtureRoot, "build-output");

describe("central generated-directory ignore registry", () => {
  it("covers the generated and cache directories every ecosystem scanner hits", () => {
    const required = [
      ".next",
      "out",
      "build",
      ".output",
      ".nuxt",
      ".svelte-kit",
      ".turbo",
      ".vercel",
      ".cache",
      "target",
      "bin",
      "obj",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".venv",
      "venv",
      "coverage",
      ".coverage",
      ".nyc_output",
      "dist",
      "node_modules",
      ".git",
      ".nyxowl",
      "tmp",
      ".tmp",
      ".parcel-cache",
      ".nx",
      ".angular",
    ];
    for (const name of required) {
      expect(
        GENERATED_IGNORED_DIR_NAMES.has(name),
        `missing generated dir name in registry: ${name}`,
      ).toBe(true);
    }
  });

  it("flags every path segment (dir or file inside ignored dir), not only the first", () => {
    expect(isIgnoredSeamPath(".next/static/chunks/main.js")).toBe(true);
    expect(isIgnoredSeamPath("build/out/index.js")).toBe(true);
    expect(isIgnoredSeamPath("target/debug/app")).toBe(true);
    expect(isIgnoredSeamPath("__pycache__/module.cpython-312.pyc")).toBe(true);
    expect(isIgnoredSeamPath("packages/app/node_modules/left-pad/index.js")).toBe(true);
    expect(isIgnoredSeamPath("client\\node_modules\\x.js")).toBe(true); // windows separators
    expect(isIgnoredSeamPath("src/index.ts")).toBe(false);
    expect(isIgnoredSeamPath("distribution.ts")).toBe(false);
    expect(isIgnoredSeamPath("outputwriter.ts")).toBe(false);
  });
});

describe("pruning walker", () => {
  it("never descends into generated directories in a plain (non-git) tree", () => {
    const files = walkSeamFiles(buildOutputFixture);
    const rels = files.map((rel) => rel.replace(/\\/g, "/"));

    // Regression (BUG 2): the populated .next build directory previously made
    // the walker enter it and surface generated artifacts to the extractors.
    expect(rels.some((rel) => rel.includes(".next"))).toBe(false);

    expect(rels).toContain(".env.example");
    expect(rels).toContain("src/app/page.tsx");
  });

  it("keeps the generated-dir registry separate from the non-source registry", () => {
    const required = ["tests", "test", "__tests__", "fixtures", "__fixtures__", "e2e"];
    for (const name of required) {
      expect(NON_SOURCE_SEGMENTS.has(name), `missing non-source segment: ${name}`).toBe(true);
    }
    // Non-source entries are not merely aliases of the generated registry.
    for (const name of required) {
      expect(GENERATED_IGNORED_DIR_NAMES.has(name)).toBe(false);
    }
    expect(NON_SOURCE_SEGMENTS.has("node_modules")).toBe(false);
    expect(NON_SOURCE_SEGMENTS.has(".next")).toBe(false);

    expect(isNonSourceSeamPath("tests/fixtures/db/schema.prisma")).toBe(true);
    expect(isNonSourceSeamPath("packages/app/__tests__/a.spec.ts")).toBe(true);
    expect(isNonSourceSeamPath("e2e/login.spec.ts")).toBe(true);
    expect(isNonSourceSeamPath("src/lib/latest.ts")).toBe(false);
    expect(isNonSourceSeamPath("testbench/fake.ts")).toBe(false); // exact segment only
    expect(isNonSourceSeamPath("fixtures/shared/helper.ts")).toBe(true);
  });

  it("prunes non-source trees in the fallback walker", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-nonsrc-walk-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "tests", "fixtures", "db"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "e2e"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src", "index.ts"), "export 0;\n");
      fs.writeFileSync(path.join(tmp, "tests", "fixtures", "db", "schema.prisma"), "model Widget {}\n");
      fs.writeFileSync(path.join(tmp, "e2e", "login.spec.ts"), "// e2e\n");

      const rels = walkSeamFiles(tmp);
      expect(rels).toEqual(["src/index.ts"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("worktree file enumeration", () => {
  it("uses git ls-files when available and still prunes the central ignore list", async () => {
    const files = await listSeamFiles(buildOutputFixture);
    const rels = files.map((rel) => rel.replace(/\\/g, "/"));

    // Regression (BUG 2): the build artifact must never be scanned, whether it
    // is filtered by gitignore or by the central prune.
    expect(rels.some((rel) => rel.includes(".next/"))).toBe(false);
    expect(rels).toContain("src/app/page.tsx");
    expect(rels).toContain(".env.example");
  });

  it("falls back to the pruning walker when git is unavailable (non-git dir)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-non-git-"));
    try {
      fs.mkdirSync(path.join(tmp, "dist"));
      fs.mkdirSync(path.join(tmp, "src"));
      fs.writeFileSync(path.join(tmp, "dist", "bundle.js"), "build output");
      fs.writeFileSync(path.join(tmp, "src", "index.ts"), "export 1;\n");

      const files = await listSeamFiles(tmp);
      expect(files).toEqual(["src/index.ts"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the report free of findings sourced from build output", async () => {
    const files = await listSeamFiles(buildOutputFixture);

    // Regression (BUG 2): ledger the old behavior — scanning the .next chunk
    // produced an env-drift finding for NEXT_PUBLIC_BUILD_SECRET and an
    // api-client-drift finding for /api/nonexistent. Neither may appear now.
    const envRefs = extractEnvReferences(buildOutputFixture, files);
    expect(envRefs.map((ref) => ref.key)).not.toContain("NEXT_PUBLIC_BUILD_SECRET");
    expect(envRefs.map((ref) => ref.key)).toContain("NEXT_PUBLIC_DASHBOARD_KEY");

    const calls = extractFrontendApiCalls(buildOutputFixture, files);
    expect(calls.map((call) => call.path)).not.toContain("/api/nonexistent");
    expect(calls.some((call) => call.path === "/api/ping/1")).toBe(true);
  });

  it("honors .gitignore before the walker fallback matters", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-gitignore-"));
    execGit(["init", "-q"], tmp);
    try {
      fs.mkdirSync(path.join(tmp, ".turbo"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmp, ".turbo", "cache.bin"), "ignored");
      fs.writeFileSync(path.join(tmp, "src", "index.ts"), "export 1;\n");
      fs.writeFileSync(path.join(tmp, ".gitignore"), "src/ignored-by-gitignore.ts\n");
      fs.writeFileSync(path.join(tmp, "src", "ignored-by-gitignore.ts"), "ignored\n");

      const files = await listSeamFiles(tmp);
      const rels = files.map((rel) => rel.replace(/\\/g, "/"));
      expect(rels).toContain("src/index.ts"); // tracked+untracked, not ignored
      expect(rels).not.toContain("src/ignored-by-gitignore.ts");
      expect(rels.some((rel) => rel.includes(".turbo"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("excludes non-source trees in the git-listing path too", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-nonsrc-git-"));
    execGit(["init", "-q", "-b", "main"], tmp);
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "__tests__", "__fixtures__"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src", "index.ts"), "export 1;\n");
      fs.writeFileSync(
        path.join(tmp, "__tests__", "__fixtures__", "seed.ts"),
        "export const users = [];\n",
      );
      execGit(["config", "user.email", "test@example.com"], tmp);
      execGit(["config", "user.name", "Test"], tmp);
      execGit(["add", "-A"], tmp);
      execGit(["commit", "-q", "-m", "init"], tmp);

      const files = await listSeamFiles(tmp);
      expect(files).toEqual(["src/index.ts"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function execGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
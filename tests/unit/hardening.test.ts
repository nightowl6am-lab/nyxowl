import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import { NYXOWL_VERSION } from "../../src/core/version.ts";
import {
  MAX_SKELETON_CACHE_ENTRIES,
  MAX_SKELETON_FILE_BYTES,
  clearSkeletonCache,
  computeFileSkeleton,
  getSkeletonCacheSize,
} from "../../src/mcp/engines/bootstrap-navigator/skeleton.ts";
import {
  __resetWasmCachesForTests,
  extractWasmSkeleton,
} from "../../src/mcp/engines/bootstrap-navigator/wasm-extractor.ts";
import { createNyxMcpServer } from "../../src/mcp/server.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const grammarsDir = path.join(repoRoot, "data", "grammars");
const originalGrammarsDir = process.env["NYXOWL_GRAMMARS_DIR"];

interface GrammarManifest {
  version: number;
  files: Record<string, { sha256: string; bytes: number }>;
}

function withTempDir(prefix = "nyx-hardening-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function resetCaches(): void {
  clearSkeletonCache();
  __resetWasmCachesForTests();
}

function restoreGrammarsDir(): void {
  if (originalGrammarsDir === undefined) {
    delete process.env["NYXOWL_GRAMMARS_DIR"];
  } else {
    process.env["NYXOWL_GRAMMARS_DIR"] = originalGrammarsDir;
  }
  resetCaches();
}

afterEach(() => {
  restoreGrammarsDir();
});

describe("Slice 6 — grammar integrity pinning and bounded scanning", () => {
  it("pins every vendored grammar by byte length and SHA-256", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(grammarsDir, "manifest.json"), "utf8"),
    ) as GrammarManifest;

    expect(manifest.version).toBe(1);
    const names = Object.keys(manifest.files).sort();
    expect(names).toEqual([
      "tree-sitter-c_sharp.wasm",
      "tree-sitter-go.wasm",
      "tree-sitter-java.wasm",
      "tree-sitter-php.wasm",
      "tree-sitter-python.wasm",
      "tree-sitter-ruby.wasm",
      "tree-sitter-rust.wasm",
    ]);

    for (const name of names) {
      const entry = manifest.files[name];
      expect(entry).toBeDefined();
      if (!entry) continue;
      const wasmPath = path.join(grammarsDir, name);
      const bytes = fs.readFileSync(wasmPath);
      expect(bytes.length, name).toBe(entry.bytes);
      expect(crypto.createHash("sha256").update(bytes).digest("hex"), name).toBe(
        entry.sha256,
      );
    }
  });

  it("fails closed and falls back to the legacy outline for tampered grammar bytes", async () => {
    const dir = withTempDir();
    try {
      for (const name of [
        "tree-sitter-c_sharp.wasm",
        "tree-sitter-go.wasm",
        "tree-sitter-java.wasm",
        "tree-sitter-php.wasm",
        "tree-sitter-python.wasm",
        "tree-sitter-ruby.wasm",
        "tree-sitter-rust.wasm",
        "manifest.json",
      ]) {
        fs.copyFileSync(path.join(grammarsDir, name), path.join(dir, name));
      }

      const tamperedPath = path.join(dir, "tree-sitter-python.wasm");
      const bytes = fs.readFileSync(tamperedPath);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      fs.writeFileSync(tamperedPath, bytes);

      process.env["NYXOWL_GRAMMARS_DIR"] = dir;
      resetCaches();

      const source = "def tampered_marker():\n    return 'fallback'\n";
      const wasmSymbols = await extractWasmSkeleton(path.join(dir, "sample.py"), source);
      expect(wasmSymbols).toBeNull();

      const pyFile = path.join(dir, "sample.py");
      fs.writeFileSync(pyFile, source, "utf8");
      const skeleton = await computeFileSkeleton(pyFile);
      expect(skeleton.symbols.map((symbol) => symbol.name)).toContain(
        "tampered_marker",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the grammar directory has no manifest", async () => {
    const dir = withTempDir();
    try {
      fs.copyFileSync(
        path.join(grammarsDir, "tree-sitter-python.wasm"),
        path.join(dir, "tree-sitter-python.wasm"),
      );
      process.env["NYXOWL_GRAMMARS_DIR"] = dir;
      resetCaches();

      const result = await extractWasmSkeleton(
        path.join(dir, "module.py"),
        "def hello():\n    pass\n",
      );
      expect(result).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects skeleton files above the 2 MiB byte cap", async () => {
    const dir = withTempDir();
    try {
      const file = path.join(dir, "huge.ts");
      fs.writeFileSync(file, "a".repeat(MAX_SKELETON_FILE_BYTES + 1), "utf8");

      await expect(computeFileSkeleton(file)).rejects.toMatchObject({
        code: "ERR_FILE_TOO_LARGE",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back instead of overflowing the stack on a ~300-deep Python AST", async () => {
    const dir = withTempDir();
    try {
      const lines: string[] = [];
      for (let depth = 0; depth < 300; depth++) {
        lines.push(`${"    ".repeat(depth)}def nested_${depth}():`);
      }
      lines.push(`${"    ".repeat(300)}pass`);
      const file = path.join(dir, "deep.py");
      fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

      const skeleton = await computeFileSkeleton(file);
      expect(Array.isArray(skeleton.symbols)).toBe(true);
      expect(skeleton.symbols.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds the skeleton cache to 256 entries with FIFO eviction", async () => {
    const dir = withTempDir();
    try {
      clearSkeletonCache();
      for (let i = 0; i < 300; i++) {
        const file = path.join(dir, `mod_${i}.ts`);
        fs.writeFileSync(file, `export const value_${i} = ${i};\n`, "utf8");
        await computeFileSkeleton(file);
      }
      expect(getSkeletonCacheSize()).toBeLessThanOrEqual(
        MAX_SKELETON_CACHE_ENTRIES,
      );
      expect(getSkeletonCacheSize()).toBeGreaterThan(0);
    } finally {
      clearSkeletonCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Slice 6 — version single source of truth", () => {
  let tmpRoot: string;
  let nyxHome: string;
  let repoPath: string;
  let client: Client;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-hardening-version-"));
    nyxHome = path.join(tmpRoot, "home");
    repoPath = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });

    await execCommand("git", ["init", "-b", "main"], {
      cwd: repoPath,
      throwOnNonZero: true,
    });
    await execCommand("git", ["config", "user.email", "test@nyxowl.dev"], {
      cwd: repoPath,
    });
    await execCommand("git", ["config", "user.name", "Test"], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");
    await execCommand("git", ["add", "."], { cwd: repoPath });
    await execCommand("git", ["commit", "-m", "init"], { cwd: repoPath });

    const server = createNyxMcpServer({ defaultProjectPath: repoPath, nyxHome });
    client = new Client({ name: "nyx-hardening-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("serves the negotiated MCP server version from NYXOWL_VERSION", () => {
    expect(client.getServerVersion()?.version).toBe(NYXOWL_VERSION);
  });

  it("stamps the greenfield commit trailer with NYXOWL_VERSION", async () => {
    const projectPath = path.join(tmpRoot, "greenfield");
    const result = await client.callTool({
      name: "nyx_project_bootstrap",
      arguments: { projectPath, mode: "greenfield", stackSpec: "ts-node" },
    });
    expect(result.isError).toBeFalsy();

    const body = await execCommand("git", ["log", "-1", "--format=%B"], {
      cwd: projectPath,
    });
    expect(body.stdout).toContain(`Assisted-by: Nyxowl v${NYXOWL_VERSION}`);
  });

  it("contains no hardcoded 1.0.0 literals in version-reporting sources", () => {
    for (const relative of [
      "src/mcp/server.ts",
      "src/mcp/engines/bootstrap-navigator/bootstrap.ts",
      "src/mcp/engines/worktree-slice/pr-gate.ts",
    ]) {
      const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      expect(text, relative).not.toContain("1.0.0");
    }
  });
});

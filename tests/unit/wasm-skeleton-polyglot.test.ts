import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSkeletonCache,
  computeFileSkeleton,
} from "../../src/mcp/engines/bootstrap-navigator/skeleton.ts";
import {
  __resetWasmCachesForTests,
  extractWasmSkeleton,
} from "../../src/mcp/engines/bootstrap-navigator/wasm-extractor.ts";

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/navigator",
);

interface ExpectedSymbol {
  name: string;
  kind: string;
  exported: boolean;
  startLine: number;
}

const expected = JSON.parse(
  fs.readFileSync(path.join(fixturesRoot, "expected.json"), "utf8"),
) as Record<string, ExpectedSymbol[]>;

const originalGrammarsDir = process.env["NYXOWL_GRAMMARS_DIR"];

afterEach(() => {
  if (originalGrammarsDir === undefined) {
    delete process.env["NYXOWL_GRAMMARS_DIR"];
  } else {
    process.env["NYXOWL_GRAMMARS_DIR"] = originalGrammarsDir;
  }
  clearSkeletonCache();
  __resetWasmCachesForTests();
});

function restoreDefaultGrammarsDir(): void {
  delete process.env["NYXOWL_GRAMMARS_DIR"];
  __resetWasmCachesForTests();
}

function shape(symbols: Array<{
  name: string;
  kind: string;
  exported: boolean;
  startLine: number;
}>): ExpectedSymbol[] {
  return symbols.map(({ name, kind, exported, startLine }) => ({
    name,
    kind,
    exported,
    startLine,
  }));
}

describe("tree-sitter WASM skeleton extraction — Java, Ruby, PHP, C#", () => {
  for (const [relativePath, expectedSymbols] of Object.entries(expected)) {
    it(`extracts the expected symbols for ${relativePath}`, async () => {
      restoreDefaultGrammarsDir();
      const file = path.join(fixturesRoot, relativePath);
      const source = fs.readFileSync(file, "utf8");

      const symbols = await extractWasmSkeleton(file, source);
      expect(symbols).not.toBeNull();
      if (!symbols) return;

      expect(shape(symbols)).toEqual(expectedSymbols);
    });
  }

  it("routes every polyglot fixture through the WASM path in computeFileSkeleton", async () => {
    restoreDefaultGrammarsDir();
    clearSkeletonCache();

    for (const [relativePath, expectedSymbols] of Object.entries(expected)) {
      const file = path.join(fixturesRoot, relativePath);
      const result = await computeFileSkeleton(file);
      expect(shape(result.symbols), relativePath).toEqual(expectedSymbols);
      expect(result.outlineText.length).toBeGreaterThan(0);
    }
  });

  it("fails closed to the legacy outline when the grammar directory is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-polyglot-"));
    try {
      process.env["NYXOWL_GRAMMARS_DIR"] = path.join(dir, "missing-grammars");
      __resetWasmCachesForTests();
      clearSkeletonCache();

      for (const relativePath of Object.keys(expected)) {
        const file = path.join(fixturesRoot, relativePath);
        const source = fs.readFileSync(file, "utf8");

        await expect(
          extractWasmSkeleton(file, source),
          relativePath,
        ).resolves.toBeNull();

        const skeleton = await computeFileSkeleton(file);
        expect(Array.isArray(skeleton.symbols), relativePath).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

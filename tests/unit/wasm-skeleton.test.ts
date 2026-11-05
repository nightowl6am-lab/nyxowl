import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeFileSkeleton } from "../../src/mcp/engines/bootstrap-navigator/skeleton.ts";
import { extractWasmSkeleton } from "../../src/mcp/engines/bootstrap-navigator/wasm-extractor.ts";

const PYTHON_SOURCE = [
  "import os",
  "",
  "@decorator",
  "class Outer:",
  "    @staticmethod",
  "    async def fetch_data(self, limit: int = 10) -> list:",
  "        return []",
  "",
  "    def _private(self):",
  "        pass",
  "",
  "async def module_async(x: int) -> str:",
  "    return str(x)",
  "",
  "def public_fn():",
  "    pass",
  "",
  "def _hidden():",
  "    pass",
  "",
].join("\n");

const GO_SOURCE = [
  "package main",
  "",
  "type Server struct {",
  "    Port int",
  "}",
  "",
  "type Handler interface {",
  "    Serve() error",
  "}",
  "",
  "type Alias = int",
  "",
  "func (s *Server) Start(port int) error { return nil }",
  "",
  "func (s Server) Stop() {}",
  "",
  "func Exported(a int) (string, error) { return \"\", nil }",
  "",
  "func unexported() {}",
  "",
].join("\n");

const GO_GROUPED_SOURCE = [
  "package main",
  "",
  "type (",
  "    A struct {",
  "        X int",
  "    }",
  "    B interface {",
  "        M()",
  "    }",
  "    C = int",
  ")",
  "",
].join("\n");

const RUST_SOURCE = [
  "pub struct Config {",
  "    pub host: String,",
  "}",
  "",
  "struct Private;",
  "",
  "pub enum Color {",
  "    Red,",
  "}",
  "",
  "pub trait Draw {",
  "    fn draw(&self);",
  "}",
  "",
  "type Alias = i32;",
  "",
  "impl Config {",
  "    pub fn new(host: String) -> Self {",
  "        Self { host }",
  "    }",
  "",
  "    fn private_method(&self) {}",
  "}",
  "",
  "pub async fn init_config() -> Config {",
  "    Config { host: String::new() }",
  "}",
  "",
  "fn helper() {}",
  "",
].join("\n");

const originalGrammarsDir = process.env["NYXOWL_GRAMMARS_DIR"];

afterEach(() => {
  if (originalGrammarsDir === undefined) {
    delete process.env["NYXOWL_GRAMMARS_DIR"];
  } else {
    process.env["NYXOWL_GRAMMARS_DIR"] = originalGrammarsDir;
  }
});

function withTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nyx-wasm-skeleton-"));
}

describe("tree-sitter WASM skeleton extraction", () => {
  it("extracts Python functions, classes, async functions, and qualified methods", async () => {
    const symbols = await extractWasmSkeleton("/virtual/module.py", PYTHON_SOURCE);
    expect(symbols).not.toBeNull();
    if (!symbols) return;

    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));

    expect(byName.get("Outer")).toMatchObject({
      kind: "class",
      startLine: 4,
      exported: true,
    });
    expect(byName.get("Outer.fetch_data")).toMatchObject({
      kind: "method",
      startLine: 6,
      endLine: 7,
      exported: true,
    });
    expect(byName.get("Outer.fetch_data")?.signature).toContain(
      "async def fetch_data(self, limit: int = 10) -> list",
    );
    expect(byName.get("Outer._private")).toMatchObject({
      kind: "method",
      startLine: 9,
      exported: false,
    });
    expect(byName.get("module_async")).toMatchObject({
      kind: "function",
      startLine: 12,
      exported: true,
    });
    expect(byName.get("public_fn")).toMatchObject({
      kind: "function",
      startLine: 15,
      exported: true,
    });
    expect(byName.get("_hidden")).toMatchObject({
      kind: "function",
      startLine: 18,
      exported: false,
    });
  });

  it("extracts Go functions, receiver-qualified methods, structs, and interfaces", async () => {
    const symbols = await extractWasmSkeleton("/virtual/handler.go", GO_SOURCE);
    expect(symbols).not.toBeNull();
    if (!symbols) return;

    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));

    expect(byName.get("Server")).toMatchObject({
      kind: "struct",
      startLine: 3,
      endLine: 5,
      exported: true,
    });
    expect(byName.get("Server")?.signature).toBe("type Server struct");
    expect(byName.get("Handler")).toMatchObject({
      kind: "interface",
      startLine: 7,
      endLine: 9,
      exported: true,
    });
    expect(byName.has("Alias")).toBe(false);
    expect(byName.get("Server.Start")).toMatchObject({
      kind: "method",
      startLine: 13,
      exported: true,
    });
    expect(byName.get("Server.Start")?.signature).toContain(
      "func (s *Server) Start(port int) error",
    );
    expect(byName.get("Server.Stop")).toMatchObject({
      kind: "method",
      startLine: 15,
      exported: true,
    });
    expect(byName.get("Exported")).toMatchObject({
      kind: "function",
      startLine: 17,
      exported: true,
    });
    expect(byName.get("unexported")).toMatchObject({
      kind: "function",
      startLine: 19,
      exported: false,
    });
  });

  it("extracts each spec in a grouped Go type declaration with its own line range and signature", async () => {
    const symbols = await extractWasmSkeleton("/virtual/grouped.go", GO_GROUPED_SOURCE);
    expect(symbols).not.toBeNull();
    if (!symbols) return;

    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));

    expect(byName.get("A")).toMatchObject({
      kind: "struct",
      startLine: 4,
      endLine: 6,
      exported: true,
    });
    expect(byName.get("A")?.signature).toBe("type A struct");
    expect(byName.get("B")).toMatchObject({
      kind: "interface",
      startLine: 7,
      endLine: 9,
      exported: true,
    });
    expect(byName.get("B")?.signature).toBe("type B interface");
    expect(byName.get("A")?.startLine).not.toBe(byName.get("B")?.startLine);
    expect(byName.get("A")?.endLine).not.toBe(byName.get("B")?.endLine);
    expect(byName.has("C")).toBe(false);
  });

  it("extracts Rust items and impl-qualified methods with pub visibility", async () => {
    const symbols = await extractWasmSkeleton("/virtual/lib.rs", RUST_SOURCE);
    expect(symbols).not.toBeNull();
    if (!symbols) return;

    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));

    expect(byName.get("Config")).toMatchObject({
      kind: "struct",
      startLine: 1,
      endLine: 3,
      exported: true,
    });
    expect(byName.get("Private")).toMatchObject({
      kind: "struct",
      startLine: 5,
      exported: false,
    });
    expect(byName.get("Color")).toMatchObject({
      kind: "enum",
      startLine: 7,
      exported: true,
    });
    expect(byName.get("Draw")).toMatchObject({
      kind: "interface",
      startLine: 11,
      exported: true,
    });
    expect(byName.get("Alias")).toMatchObject({
      kind: "type",
      startLine: 15,
      exported: false,
    });
    expect(byName.get("Config.new")).toMatchObject({
      kind: "method",
      startLine: 18,
      exported: true,
    });
    expect(byName.get("Config.private_method")).toMatchObject({
      kind: "method",
      startLine: 22,
      exported: false,
    });
    expect(byName.get("init_config")).toMatchObject({
      kind: "function",
      startLine: 25,
      exported: true,
    });
    expect(byName.get("helper")).toMatchObject({
      kind: "function",
      startLine: 29,
      exported: false,
    });
  });

  it("returns partial symbols for files with syntax errors", async () => {
    const python = await extractWasmSkeleton(
      "/virtual/broken.py",
      "def good():\n    pass\n\ndef broken(:\n    pass\n",
    );
    expect(python?.some((symbol) => symbol.name === "good")).toBe(true);

    const go = await extractWasmSkeleton(
      "/virtual/broken.go",
      "package main\n\nfunc Good() {}\n\nfunc Broken( {\n",
    );
    expect(go?.some((symbol) => symbol.name === "Good")).toBe(true);

    const rust = await extractWasmSkeleton(
      "/virtual/broken.rs",
      "fn good() {}\n\nfn broken( {\n",
    );
    expect(rust?.some((symbol) => symbol.name === "good")).toBe(true);
  });

  it("returns null when the grammar is unavailable", async () => {
    process.env["NYXOWL_GRAMMARS_DIR"] = path.join(os.tmpdir(), "nyx-missing-grammars");
    await expect(
      extractWasmSkeleton("/virtual/module.py", "def hello():\n    pass\n"),
    ).resolves.toBeNull();
  });

  it("falls back to the legacy extractor when the WASM grammar is unavailable", async () => {
    const dir = withTempDir();
    try {
      const file = path.join(dir, "service.py");
      fs.writeFileSync(file, "def hello():\n    return 'world'\n", "utf8");
      process.env["NYXOWL_GRAMMARS_DIR"] = path.join(dir, "missing-grammars");

      const result = await computeFileSkeleton(file);
      expect(Object.keys(result).sort()).toEqual([
        "originalTokens",
        "outlineText",
        "reductionRatio",
        "skeletonTokens",
        "symbols",
      ]);
      expect(result.symbols.map((symbol) => symbol.name)).toContain("hello");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the WASM extractor through computeFileSkeleton and caches by content hash", async () => {
    const dir = withTempDir();
    try {
      const files = {
        "module.py": PYTHON_SOURCE,
        "handler.go": GO_SOURCE,
        "lib.rs": RUST_SOURCE,
      };
      for (const [name, content] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, content, "utf8");
        const first = await computeFileSkeleton(file);
        const second = await computeFileSkeleton(file);
        expect(first.symbols.length).toBeGreaterThan(0);
        expect(second.outlineText).toBe(first.outlineText);
        expect(second.symbols).toEqual(first.symbols);
        expect(first.outlineText).toContain(`L${first.symbols[0]?.startLine}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates the skeleton cache by extension for identical file bytes", async () => {
    const dir = withTempDir();
    try {
      // `class`/`def` exercise the Python WASM extractor; the extra
      // `function inner` line is what the legacy outline recognizes for the
      // `.txt` path, so the two extractors return different symbols for the
      // exact same bytes.
      const source = [
        "class Outer:",
        "    def inner(self):",
        "        pass",
        "",
        "function inner():",
        "    pass",
        "",
      ].join("\n");
      const pythonFile = path.join(dir, "sample.py");
      const textFile = path.join(dir, "sample.txt");
      fs.writeFileSync(pythonFile, source, "utf8");
      fs.writeFileSync(textFile, source, "utf8");

      const python = await computeFileSkeleton(pythonFile);
      const pythonNames = new Map(python.symbols.map((symbol) => [symbol.name, symbol]));
      expect(pythonNames.get("Outer.inner")).toMatchObject({ kind: "method" });

      const legacy = await computeFileSkeleton(textFile);
      const legacyNames = new Map(legacy.symbols.map((symbol) => [symbol.name, symbol]));
      expect(legacyNames.get("inner")).toMatchObject({ kind: "function" });
      expect(legacyNames.has("Outer.inner")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

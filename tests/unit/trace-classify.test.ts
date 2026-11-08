import { describe, expect, it } from "vitest";
import { classifySymbolOccurrence } from "../../src/mcp/engines/bootstrap-navigator/trace.ts";

interface Case {
  language: string;
  filePath: string;
  symbol: string;
  line: string;
  expected: "definition" | "import" | "call" | null;
}

const cases: Case[] = [
  // Python
  {
    language: "python def",
    filePath: "src/service.py",
    symbol: "fetch_data",
    line: "async def fetch_data(limit: int = 10):",
    expected: "definition",
  },
  {
    language: "python class",
    filePath: "src/service.py",
    symbol: "UserService",
    line: "class UserService:",
    expected: "definition",
  },
  {
    language: "python import module",
    filePath: "src/service.py",
    symbol: "service",
    line: "import service",
    expected: "import",
  },
  {
    language: "python from-import",
    filePath: "src/service.py",
    symbol: "fetch_data",
    line: "from service import fetch_data",
    expected: "import",
  },
  {
    language: "python call",
    filePath: "src/service.py",
    symbol: "fetch_data",
    line: "users = await fetch_data(10)",
    expected: "call",
  },
  // Go
  {
    language: "go function",
    filePath: "cmd/server/handler.go",
    symbol: "StartServer",
    line: "func StartServer(port int) error {",
    expected: "definition",
  },
  {
    language: "go method",
    filePath: "cmd/server/handler.go",
    symbol: "Start",
    line: "func (s *Server) Start(port int) error {",
    expected: "definition",
  },
  {
    language: "go type",
    filePath: "cmd/server/handler.go",
    symbol: "Server",
    line: "type Server struct {",
    expected: "definition",
  },
  {
    language: "go import path segment",
    filePath: "cmd/server/handler.go",
    symbol: "handler",
    line: 'import "example.com/gosvc/handler"',
    expected: "import",
  },
  {
    language: "go call",
    filePath: "cmd/server/handler.go",
    symbol: "StartServer",
    line: "if err := StartServer(8080); err != nil {",
    expected: "call",
  },
  // Rust
  {
    language: "rust pub fn",
    filePath: "src/lib.rs",
    symbol: "init_config",
    line: "pub async fn init_config() -> Config {",
    expected: "definition",
  },
  {
    language: "rust struct",
    filePath: "src/lib.rs",
    symbol: "Config",
    line: "pub struct Config {",
    expected: "definition",
  },
  {
    language: "rust use",
    filePath: "src/lib.rs",
    symbol: "Config",
    line: "use crate::config::Config;",
    expected: "import",
  },
  {
    language: "rust call",
    filePath: "src/lib.rs",
    symbol: "Config",
    line: "let config = Config::default();",
    expected: "call",
  },
  // TypeScript / JavaScript / unknown
  {
    language: "ts function",
    filePath: "src/handler.ts",
    symbol: "fetchData",
    line: "export function fetchData() {",
    expected: "definition",
  },
  {
    language: "ts import",
    filePath: "src/handler.ts",
    symbol: "fetchData",
    line: 'import { fetchData } from "./data";',
    expected: "import",
  },
  {
    language: "ts import without symbol",
    filePath: "src/handler.ts",
    symbol: "fetchData",
    line: 'import { other } from "./data";',
    expected: "call",
  },
  {
    language: "js call",
    filePath: "src/handler.js",
    symbol: "fetchData",
    line: "fetchData();",
    expected: "call",
  },
  {
    language: "unknown extension",
    filePath: "src/handler.elm",
    symbol: "fetchData",
    line: "fetchData()",
    expected: "call",
  },
  // Prefix comments must be skipped for every language.
  {
    language: "ts line comment",
    filePath: "src/handler.ts",
    symbol: "fetchData",
    line: "// function fetchData() {}",
    expected: null,
  },
  {
    language: "ts block comment",
    filePath: "src/handler.ts",
    symbol: "fetchData",
    line: "/* fetchData */",
    expected: null,
  },
  {
    language: "star comment continuation",
    filePath: "src/handler.ts",
    symbol: "fetchData",
    line: " * fetchData",
    expected: null,
  },
  {
    language: "python comment",
    filePath: "src/service.py",
    symbol: "fetch_data",
    line: "# def fetch_data():",
    expected: null,
  },
  {
    language: "go comment",
    filePath: "cmd/server/handler.go",
    symbol: "StartServer",
    line: "// func StartServer()",
    expected: null,
  },
  {
    language: "rust comment",
    filePath: "src/lib.rs",
    symbol: "init_config",
    line: "#[allow(dead_code)]",
    expected: null,
  },
  // A trailing comment does not erase the code line.
  {
    language: "trailing comment",
    filePath: "src/service.py",
    symbol: "fetch_data",
    line: "fetch_data(10)  # trailing comment",
    expected: "call",
  },
];

describe("classifySymbolOccurrence", () => {
  for (const testCase of cases) {
    it(`classifies ${testCase.language}`, () => {
      expect(
        classifySymbolOccurrence(testCase.line, testCase.symbol, testCase.filePath),
      ).toBe(testCase.expected);
    });
  }
});

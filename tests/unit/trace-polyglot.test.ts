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
  // Java
  {
    language: "java class",
    filePath: "src/App.java",
    symbol: "App",
    line: "public class App implements Greeter {",
    expected: "definition",
  },
  {
    language: "java interface",
    filePath: "src/App.java",
    symbol: "Greeter",
    line: "public interface Greeter {",
    expected: "definition",
  },
  {
    language: "java enum",
    filePath: "src/App.java",
    symbol: "Color",
    line: "public enum Color {",
    expected: "definition",
  },
  {
    language: "java record",
    filePath: "src/App.java",
    symbol: "Point",
    line: "public record Point(int x, int y) {",
    expected: "definition",
  },
  {
    language: "java method",
    filePath: "src/App.java",
    symbol: "greet",
    line: "public String greet(String name) {",
    expected: "definition",
  },
  {
    language: "java constructor",
    filePath: "src/App.java",
    symbol: "App",
    line: "public App(int count) {",
    expected: "definition",
  },
  {
    language: "java import",
    filePath: "src/App.java",
    symbol: "App",
    line: "import com.example.App;",
    expected: "import",
  },
  {
    language: "java new call",
    filePath: "src/App.java",
    symbol: "App",
    line: "App app = new App(3);",
    expected: "call",
  },
  {
    language: "java static call",
    filePath: "src/App.java",
    symbol: "App",
    line: "return App.create();",
    expected: "call",
  },
  {
    language: "java line comment",
    filePath: "src/App.java",
    symbol: "App",
    line: "// public class App {",
    expected: null,
  },
  // Ruby
  {
    language: "ruby class",
    filePath: "lib/library.rb",
    symbol: "Book",
    line: "class Book",
    expected: "definition",
  },
  {
    language: "ruby module",
    filePath: "lib/library.rb",
    symbol: "Library",
    line: "module Library",
    expected: "definition",
  },
  {
    language: "ruby method",
    filePath: "lib/library.rb",
    symbol: "secret",
    line: "def secret",
    expected: "definition",
  },
  {
    language: "ruby singleton method",
    filePath: "lib/library.rb",
    symbol: "build",
    line: "def self.build",
    expected: "definition",
  },
  {
    language: "ruby require",
    filePath: "lib/library.rb",
    symbol: "json",
    line: 'require "json"',
    expected: "import",
  },
  {
    language: "ruby require_relative",
    filePath: "lib/library.rb",
    symbol: "library",
    line: 'require_relative "library"',
    expected: "import",
  },
  {
    language: "ruby namespaced call",
    filePath: "lib/library.rb",
    symbol: "Book",
    line: "Library::Book.new",
    expected: "call",
  },
  {
    language: "ruby comment",
    filePath: "lib/library.rb",
    symbol: "secret",
    line: "# def secret",
    expected: null,
  },
  // PHP
  {
    language: "php final class",
    filePath: "src/greeter.php",
    symbol: "GreeterImpl",
    line: "final class GreeterImpl extends Base implements Greeter",
    expected: "definition",
  },
  {
    language: "php abstract class",
    filePath: "src/greeter.php",
    symbol: "Base",
    line: "abstract class Base",
    expected: "definition",
  },
  {
    language: "php interface",
    filePath: "src/greeter.php",
    symbol: "Greeter",
    line: "interface Greeter",
    expected: "definition",
  },
  {
    language: "php trait",
    filePath: "src/greeter.php",
    symbol: "Loggable",
    line: "trait Loggable",
    expected: "definition",
  },
  {
    language: "php enum",
    filePath: "src/greeter.php",
    symbol: "Suit",
    line: "enum Suit: string",
    expected: "definition",
  },
  {
    language: "php method",
    filePath: "src/greeter.php",
    symbol: "greet",
    line: "public function greet(string $name): string",
    expected: "definition",
  },
  {
    language: "php function",
    filePath: "src/greeter.php",
    symbol: "top_level",
    line: "function top_level(): void",
    expected: "definition",
  },
  {
    language: "php use import",
    filePath: "src/greeter.php",
    symbol: "Bar",
    line: "use Foo\\Bar;",
    expected: "import",
  },
  {
    language: "php new call",
    filePath: "src/greeter.php",
    symbol: "GreeterImpl",
    line: "$greeter = new GreeterImpl(1);",
    expected: "call",
  },
  {
    language: "php line comment",
    filePath: "src/greeter.php",
    symbol: "greet",
    line: "// public function greet()",
    expected: null,
  },
  // C#
  {
    language: "csharp class",
    filePath: "src/Orders.cs",
    symbol: "OrderService",
    line: "public class OrderService : IProcessor",
    expected: "definition",
  },
  {
    language: "csharp struct",
    filePath: "src/Orders.cs",
    symbol: "Money",
    line: "public struct Money",
    expected: "definition",
  },
  {
    language: "csharp record",
    filePath: "src/Orders.cs",
    symbol: "Order",
    line: "public record Order(int Id);",
    expected: "definition",
  },
  {
    language: "csharp method",
    filePath: "src/Orders.cs",
    symbol: "Process",
    line: "public void Process()",
    expected: "definition",
  },
  {
    language: "csharp constructor",
    filePath: "src/Orders.cs",
    symbol: "OrderService",
    line: "public OrderService(int count)",
    expected: "definition",
  },
  {
    language: "csharp arrow method",
    filePath: "src/Orders.cs",
    symbol: "Double",
    line: "public int Double(int x) => x * 2;",
    expected: "definition",
  },
  {
    language: "csharp using import",
    filePath: "src/Orders.cs",
    symbol: "System",
    line: "using System;",
    expected: "import",
  },
  {
    language: "csharp new call",
    filePath: "src/Orders.cs",
    symbol: "Order",
    line: "var order = new Order(1);",
    expected: "call",
  },
  {
    language: "csharp line comment",
    filePath: "src/Orders.cs",
    symbol: "OrderService",
    line: "// public class OrderService",
    expected: null,
  },
];

describe("classifySymbolOccurrence — Java, Ruby, PHP, C#", () => {
  for (const testCase of cases) {
    it(`classifies ${testCase.language}`, () => {
      expect(
        classifySymbolOccurrence(
          testCase.line,
          testCase.symbol,
          testCase.filePath,
        ),
      ).toBe(testCase.expected);
    });
  }
});

describe("classifySymbolOccurrence — adversarial long lines stay bounded", () => {
  // Regression for quadratic backtracking in the Java/C# definition regexes.
  // A long run of modifier tokens followed by an unrelated call must not make
  // the classifier spend super-linear time before falling back to "call".
  const cases: Array<{ language: string; filePath: string; line: string }> = [
    {
      language: "java",
      filePath: "src/Hostile.java",
      line: "final ".repeat(16000) + "z(",
    },
    {
      language: "csharp",
      filePath: "src/Hostile.cs",
      line: "readonly ".repeat(16000) + "z(",
    },
  ];

  for (const testCase of cases) {
    it(`classifies a 96KB hostile ${testCase.language} line as a call quickly`, () => {
      const started = performance.now();
      const result = classifySymbolOccurrence(
        testCase.line,
        "targetSymbol",
        testCase.filePath,
      );
      const elapsedMs = performance.now() - started;

      expect(result).toBe("call");
      expect(elapsedMs).toBeLessThan(1500);
    });
  }
});

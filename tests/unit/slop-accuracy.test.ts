import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import { nyxSlopCheckTool } from "../../src/mcp/engines/probe-exploit/index.ts";
import {
  maskSourceLines,
  scanFileLinesForSlop,
} from "../../src/mcp/engines/probe-exploit/slop/rules.ts";
import { invokeToolDefinition } from "../../src/mcp/tool.ts";

interface TokenMatrix {
  real: string[];
  placeholder: string[];
}

const tokenMatrix = JSON.parse(
  fs.readFileSync(new URL("../fixtures/slop/token-matrix.json", import.meta.url), "utf8"),
) as TokenMatrix;

function findingIds(
  filePath: string,
  content: string,
): string[] {
  return scanFileLinesForSlop(filePath, content, null).findings.map((finding) => finding.ruleId);
}

describe("Slop scanner accuracy hardening", () => {
  it("masks comments and string contents without changing line numbers", () => {
    const masks = maskSourceLines(
      'const value = "TODO inside string"; // real TODO comment\n/* block\nstill block */\n',
    );

    expect(masks).toHaveLength(4);
    expect(masks[0]?.code).toContain("TODO inside string");
    expect(masks[0]?.codeNoStrings).not.toContain("TODO");
    expect(masks[0]?.comments).toBe("real TODO comment");
    expect(masks[1]?.comments).toBe("block");
    expect(masks[2]?.comments).toBe("still block");
  });

  it("does not report TODO text inside a string but reports a real comment", () => {
    const inString = scanFileLinesForSlop(
      "src/example.ts",
      'const message = "TODO later";\n',
      null,
    );
    expect(inString.findings.filter((f) => f.ruleId === "todo-fixme")).toHaveLength(0);

    const inComment = scanFileLinesForSlop("src/example.ts", "// TODO later\n", null);
    expect(inComment.findings.filter((f) => f.ruleId === "todo-fixme")).toHaveLength(1);
  });

  it("does not report `as any` inside a string but reports real code", () => {
    const result = scanFileLinesForSlop(
      "src/example.ts",
      'const label = "as any";\nconst value = input as any;\n',
      null,
    );
    const anyFindings = result.findings.filter((f) => f.ruleId === "explicit-any");
    expect(anyFindings).toHaveLength(1);
    expect(anyFindings[0]?.line).toBe(2);
  });

  it("detects any inside generic type arguments without flagging call arguments", () => {
    expect(
      findingIds("src/example.ts", "const record: Record<string, any> = {};\n"),
    ).toContain("explicit-any");
    expect(
      findingIds("src/example.ts", "const map: Map<string, any> = new Map();\n"),
    ).toContain("explicit-any");
    expect(findingIds("src/example.ts", "foo(a, any);\n")).not.toContain("explicit-any");
  });

  it("does not treat TypeScript #private fields as hash comments", () => {
    const masks = maskSourceLines("#privateField: any = 1;\n", { hashComments: false });
    expect(masks[0]?.comments).toBe("");
    expect(masks[0]?.code).toContain("#privateField");

    const findings = findingIds(
      "src/example.ts",
      "#privateField: any = 1;\nconst value: any = 1;\n",
    );
    expect(findings.filter((ruleId) => ruleId === "explicit-any")).toHaveLength(2);
  });

  it("does not let JSX apostrophes hide findings on the same or next line", () => {
    const sameLine = scanFileLinesForSlop(
      "src/example.tsx",
      'console.log("debug"); <p>Don\'t panic</p>\n',
      null,
    );
    expect(sameLine.findings.filter((f) => f.ruleId === "leftover-debug")).toHaveLength(1);

    const nextLine = scanFileLinesForSlop(
      "src/example.tsx",
      "<p>Don't panic</p>\nconsole.log(\"debug\");\n",
      null,
    );
    expect(nextLine.findings.filter((f) => f.ruleId === "leftover-debug")).toHaveLength(1);
  });

  it("keeps Python triple-quoted docstrings masked across lines", () => {
    const result = scanFileLinesForSlop(
      "src/example.py",
      '"""\nTODO inside a docstring\n"""\n# TODO real comment\n',
      null,
    );
    const todoFindings = result.findings.filter((f) => f.ruleId === "todo-fixme");
    expect(todoFindings).toHaveLength(1);
    expect(todoFindings[0]?.line).toBe(4);
  });

  it("ignores loading/error text in comments and strings for async UI state", () => {
    const hiddenState = findingIds(
      "src/Component.tsx",
      'fetch("/api");\n// loading and error handled\nconst label = "loading error";\n',
    );
    expect(hiddenState).toContain("async-missing-states");

    const realState = findingIds(
      "src/Component.tsx",
      'fetch("/api");\nconst loading = true;\nconst error = null;\n',
    );
    expect(realState).not.toContain("async-missing-states");
  });

  it("supports #, //, and block-comment suppression directives with reasons", () => {
    const hashSuppressed = scanFileLinesForSlop(
      "src/example.py",
      "# nyx-allow: leftover-debug — legacy script\nprint(\"debug\")\n",
      null,
    );
    expect(hashSuppressed.findings.filter((f) => f.ruleId === "leftover-debug")).toHaveLength(0);
    expect(hashSuppressed.suppressions).toHaveLength(1);
    expect(hashSuppressed.suppressions[0]?.reason).toBe("legacy script");

    const slashSuppressed = scanFileLinesForSlop(
      "src/example.ts",
      "// nyx-allow: explicit-any — legacy bridge\nconst value: any = 1;\n",
      null,
    );
    expect(slashSuppressed.findings.filter((f) => f.ruleId === "explicit-any")).toHaveLength(0);

    const blockSuppressed = scanFileLinesForSlop(
      "src/example.ts",
      "/* nyx-allow: todo-fixme — legacy tracker */\n// TODO later\n",
      null,
    );
    expect(blockSuppressed.findings.filter((f) => f.ruleId === "todo-fixme")).toHaveLength(0);
    expect(blockSuppressed.suppressions[0]?.reason).toBe("legacy tracker");
  });

  it("keeps missing-allow-reason blocking even when the rule would be suppressed", () => {
    const result = scanFileLinesForSlop(
      "src/example.ts",
      "// nyx-allow: explicit-any\nconst value: any = 1;\n",
      null,
    );
    const missing = result.findings.filter((f) => f.ruleId === "missing-allow-reason");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe("blocking");
    expect(result.findings.filter((f) => f.ruleId === "explicit-any")).toHaveLength(1);
  });

  it("anchors the URL allowlist so lookalike loopback hosts are blocked", () => {
    const lookalike = scanFileLinesForSlop(
      "src/example.ts",
      'const endpoint = "http://127.0.0.1.evil.com/data";\n',
      null,
    );
    expect(lookalike.findings.filter((f) => f.ruleId === "hardcoded-url")).toHaveLength(1);

    const local = scanFileLinesForSlop(
      "src/example.ts",
      'const endpoint = "http://localhost:8080/api";\n',
      null,
    );
    expect(local.findings.filter((f) => f.ruleId === "hardcoded-url")).toHaveLength(0);

    const loopback = scanFileLinesForSlop(
      "src/example.ts",
      'const endpoint = "http://127.0.0.1:3000/api";\n',
      null,
    );
    expect(loopback.findings.filter((f) => f.ruleId === "hardcoded-url")).toHaveLength(0);

    const comment = scanFileLinesForSlop(
      "src/example.ts",
      "// http://evil.example.com/api\n",
      null,
    );
    expect(comment.findings.filter((f) => f.ruleId === "hardcoded-url")).toHaveLength(0);
  });

  it("blocks real token shapes and exempts env or placeholder values", () => {
    for (const line of tokenMatrix.real) {
      const findings = findingIds("src/secrets.ts", `${line}\n`);
      expect(findings, line).toContain("hardcoded-secret");
    }

    for (const line of tokenMatrix.placeholder) {
      const findings = findingIds("src/secrets.ts", `${line}\n`);
      expect(findings, line).not.toContain("hardcoded-secret");
    }

    const commented = findingIds(
      "src/secrets.ts",
      '// const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";\n',
    );
    expect(commented).not.toContain("hardcoded-secret");
  });

  it("recognizes expanded test-file paths and exempts debug/URL slop there", () => {
    const testPaths = [
      "tests/example.ts",
      "src/example.test.ts",
      "src/example.spec.ts",
      "src/example_test.py",
      "src/test_example.py",
      "src/__tests__/example.ts",
      "src/spec/example.ts",
      "src/__mocks__/example.ts",
    ];

    for (const filePath of testPaths) {
      const findings = findingIds(
        filePath,
        'console.log("debug");\nconst endpoint = "https://evil.example.com/api";\n',
      );
      expect(findings, filePath).not.toContain("leftover-debug");
      expect(findings, filePath).not.toContain("hardcoded-url");
    }
  });

  it("still blocks leftover debug in production code and ignores it in strings/comments", () => {
    expect(findingIds("src/app.ts", 'console.log("debug");\n')).toContain("leftover-debug");
    expect(findingIds("src/app.ts", 'const text = "console.log(1)";\n')).not.toContain(
      "leftover-debug",
    );
    expect(findingIds("src/app.ts", '// console.log("debug");\n')).not.toContain(
      "leftover-debug",
    );
  });

  it("reports no findings for comment-only content that resembles code", () => {
    const result = scanFileLinesForSlop(
      "src/app.ts",
      '// const value: any = 1; console.log("x");\n',
      null,
    );
    expect(result.findings).toHaveLength(0);
  });

  it("still detects real empty catch blocks once comments are stripped", () => {
    const findings = findingIds("src/app.ts", "try { run(); } catch { /* ignore */ }\n");
    expect(findings).toContain("empty-catch");
  });

  it("detects blank-only empty catch blocks but respects documented ignores", () => {
    const commentedCatch = scanFileLinesForSlop(
      "src/app.ts",
      "try {\n  run();\n} catch {\n  // ignore\n}\n",
      null,
    );
    expect(
      commentedCatch.findings.filter((f) => f.ruleId === "empty-catch"),
    ).toHaveLength(0);

    const blankCatch = scanFileLinesForSlop(
      "src/app.ts",
      "try {\n  run();\n} catch {\n\n}\n",
      null,
    );
    const catchFindings = blankCatch.findings.filter((f) => f.ruleId === "empty-catch");
    expect(catchFindings).toHaveLength(1);
    expect(catchFindings[0]?.line).toBe(3);

    const commentedExcept = scanFileLinesForSlop(
      "src/app.py",
      "try:\n    run()\nexcept Exception:\n    # ignore\n    pass\n",
      null,
    );
    expect(
      commentedExcept.findings.filter((f) => f.ruleId === "empty-catch"),
    ).toHaveLength(0);

    const blankExcept = scanFileLinesForSlop(
      "src/app.py",
      "try:\n    run()\nexcept Exception:\n\n    pass\n",
      null,
    );
    const exceptFindings = blankExcept.findings.filter((f) => f.ruleId === "empty-catch");
    expect(exceptFindings).toHaveLength(1);
    expect(exceptFindings[0]?.line).toBe(3);
  });
});

describe("Slop tool containment and read caps", () => {
  let tmpRoot = "";
  let repoDir = "";
  let nyxHome = "";

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-slop-accuracy-"));
    nyxHome = path.join(tmpRoot, "nyx-home");
    repoDir = path.join(tmpRoot, "repo");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# slop accuracy fixture\n");
    await execCommand("git", ["init", "-b", "main"], { cwd: repoDir, throwOnNonZero: true });
    await execCommand("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execCommand("git", ["config", "user.name", "Nyx Test"], { cwd: repoDir });
    await execCommand("git", ["add", "-A"], { cwd: repoDir });
    await execCommand("git", ["commit", "-m", "init"], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function runSlop(changedFiles: string[]): Promise<{
    status: string;
    findings: Array<{ ruleId: string; filePath: string }>;
  }> {
    const response = await invokeToolDefinition(
      nyxSlopCheckTool,
      { worktreePath: repoDir, scope: "full", changedFiles },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(response.isError).toBeFalsy();
    return response.structuredContent as unknown as {
      status: string;
      findings: Array<{ ruleId: string; filePath: string }>;
    };
  }

  it("refuses traversal and symlink paths that resolve outside the worktree", async () => {
    const outsideFile = path.join(tmpRoot, "outside.ts");
    fs.writeFileSync(outsideFile, "// TODO outside worktree\n");

    const traversal = await runSlop(["../outside.ts"]);
    expect(traversal.status).toBe("GREEN");
    expect(traversal.findings).toHaveLength(0);

    fs.symlinkSync(outsideFile, path.join(repoDir, "src", "escape.ts"));
    const symlink = await runSlop(["src/escape.ts"]);
    expect(symlink.status).toBe("GREEN");
    expect(symlink.findings).toHaveLength(0);
  });

  it("skips files larger than the 2 MiB read cap", async () => {
    fs.writeFileSync(
      path.join(repoDir, "src", "huge.ts"),
      "// TODO this must not be read\n" + "x".repeat(2 * 1024 * 1024 + 1024),
    );

    const capped = await runSlop(["src/huge.ts"]);
    expect(capped.status).toBe("GREEN");
    expect(capped.findings).toHaveLength(0);

    fs.writeFileSync(path.join(repoDir, "src", "tiny.ts"), "// TODO tiny file\n");
    const tiny = await runSlop(["src/tiny.ts"]);
    expect(tiny.status).toBe("RED");
    expect(tiny.findings.some((finding) => finding.ruleId === "todo-fixme")).toBe(true);
  });

  it("scans .pyi stubs as hash-comment code", async () => {
    fs.writeFileSync(path.join(repoDir, "src", "stub.pyi"), "# TODO implement stub\n");
    const realStub = await runSlop(["src/stub.pyi"]);
    expect(realStub.status).toBe("RED");
    expect(realStub.findings.some((finding) => finding.ruleId === "todo-fixme")).toBe(true);

    fs.writeFileSync(
      path.join(repoDir, "src", "suppressed.pyi"),
      "# nyx-allow: todo-fixme — generated stub\n# TODO generated\n",
    );
    const suppressedStub = await runSlop(["src/suppressed.pyi"]);
    expect(suppressedStub.status).toBe("GREEN");
    expect(suppressedStub.findings).toHaveLength(0);
  });

  it("rejects more than 5000 changed files", async () => {
    const tooManyFiles = Array.from(
      { length: 5001 },
      (_unused, index) => `src/file-${index}.ts`,
    );
    const response = await invokeToolDefinition(
      nyxSlopCheckTool,
      { worktreePath: repoDir, scope: "full", changedFiles: tooManyFiles },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(response.isError).toBe(true);
    expect((response.structuredContent as { code: string }).code).toBe("ERR_INVALID_INPUT");
  });
});

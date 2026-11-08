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
import { createToolContext, invokeToolDefinition } from "../../src/mcp/tool.ts";

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

  it("masks escaped quotes, backticks, and hash comments without losing real code", () => {
    const escaped = findingIds(
      "src/example.ts",
      'const text = "say \\"hi\\""; const value: any = 1;\n',
    );
    expect(escaped).toContain("explicit-any");

    const backtick = scanFileLinesForSlop(
      "src/example.ts",
      "const tpl = `start\nTODO hidden in template\nend`;\n// TODO real comment\n",
      null,
    );
    const todos = backtick.findings.filter((f) => f.ruleId === "todo-fixme");
    expect(todos).toHaveLength(1);
    expect(todos[0]?.line).toBe(4);

    const hash = findingIds("src/example.py", "x = 1  # TODO trailing\n");
    expect(hash).toContain("todo-fixme");
    const notHash = findingIds("src/example.py", "value = 'foo#bar'\n");
    expect(notHash).not.toContain("todo-fixme");

    const block = findingIds("src/example.ts", "/* note */ const value: any = 1;\n");
    expect(block).toContain("explicit-any");
    const unterminated = maskSourceLines("/* TODO never closed\nstill comment\n");
    expect(unterminated[1]?.comments).toContain("still comment");

    // Single/double quotes do not leak into the next line for JS.
    const quoteReset = findingIds(
      "src/example.ts",
      'const broken = "unterminated\nconst value: any = 1;\n',
    );
    expect(quoteReset).toContain("explicit-any");
  });

  it("honors target line filters, disabled rules, and advisory escalation", () => {
    const targeted = scanFileLinesForSlop(
      "src/app.ts",
      "// TODO first\n// TODO second\n",
      new Set([2]),
    );
    const todo = targeted.findings.filter((f) => f.ruleId === "todo-fixme");
    expect(todo).toHaveLength(1);
    expect(todo[0]?.line).toBe(2);

    const disabled = scanFileLinesForSlop(
      "src/app.ts",
      "const value: any = 1;\n",
      null,
      { disabledRules: new Set(["explicit-any"]) },
    );
    expect(disabled.findings).toHaveLength(0);

    const escalated = scanFileLinesForSlop(
      "src/Color.tsx",
      "const color = #ff00aa;\n",
      null,
      { advisoryAsBlocking: true },
    );
    const raw = escalated.findings.find((f) => f.ruleId === "raw-design-token");
    expect(raw?.severity).toBe("blocking");
  });

  it("filters a suppression directive outside the targeted lines", () => {
    const outside = scanFileLinesForSlop(
      "src/app.ts",
      "// nyx-allow: explicit-any\nconst value: any = 1;\n",
      new Set([2]),
    );
    expect(
      outside.findings.filter((f) => f.ruleId === "missing-allow-reason"),
    ).toHaveLength(0);
    // Without a reason there is no suppression, so the targeted line still fails.
    expect(outside.findings.filter((f) => f.ruleId === "explicit-any")).toHaveLength(1);

    const suppressed = scanFileLinesForSlop(
      "src/app.ts",
      "// nyx-allow: explicit-any — legacy bridge\nconst value: any = 1;\n",
      new Set([2]),
    );
    expect(
      suppressed.findings.filter((f) => f.ruleId === "explicit-any"),
    ).toHaveLength(0);

    const blankReason = scanFileLinesForSlop(
      "src/app.ts",
      "// nyx-allow: explicit-any — \nconst value: any = 1;\n",
      null,
    );
    expect(
      blankReason.findings.filter((f) => f.ruleId === "missing-allow-reason"),
    ).toHaveLength(1);
  });

  it("detects placeholder returns and exempts test files", () => {
    for (const line of [
      'throw new Error("Not implemented yet");',
      "raise NotImplementedError()",
      "unimplemented!()",
      "todo!()",
      'return "MOCK_value";',
      "return { mock: true };",
    ]) {
      expect(findingIds("src/app.ts", `${line}\n`), line).toContain("placeholder-return");
    }
    expect(findingIds("src/app.test.ts", "todo!()\n")).not.toContain("placeholder-return");
  });

  it("flags hardcoded credentials but not env references or placeholders", () => {
    expect(findingIds("src/app.ts", 'const password = "supersecretvalue";\n')).toContain(
      "hardcoded-secret",
    );
    expect(
      findingIds("src/app.ts", "const password = process.env.PASSWORD;\n"),
    ).not.toContain("hardcoded-secret");
    expect(
      findingIds("src/app.ts", 'const apiKey = "${API_KEY}";\n'),
    ).not.toContain("hardcoded-secret");
  });

  it("allows config-style URL files and documented URL allowlist hosts", () => {
    for (const filePath of [
      "src/config.ts",
      "src/constants.ts",
      "src/schema.ts",
      "docs/README.md",
      "data/registry.json",
    ]) {
      expect(
        findingIds(filePath, 'const url = "https://evil.example.com/api";\n'),
        filePath,
      ).not.toContain("hardcoded-url");
    }
    for (const url of [
      "https://json-schema.org/draft",
      "https://www.w3.org/TR",
      "https://unpkg.com/pkg",
      "http://0.0.0.0:3000",
      "http://[::1]:3000",
    ]) {
      expect(
        findingIds("src/app.ts", `const url = "${url}";\n`),
        url,
      ).not.toContain("hardcoded-url");
    }
  });

  it("reports restating comments and focused or skipped tests", () => {
    const restating = scanFileLinesForSlop(
      "src/app.ts",
      "// fetch user data\nfetchUserData();\n",
      null,
    );
    expect(restating.findings.some((f) => f.ruleId === "restating-comment")).toBe(true);

    for (const line of [
      'it.only("focused", () => {});',
      'test.skip("skipped", () => {});',
      "@pytest.mark.skip()",
    ]) {
      expect(findingIds("src/app.ts", `${line}\n`), line).toContain(
        "focused-or-skipped-test",
      );
    }
    expect(
      findingIds("src/app.ts", '@pytest.mark.skip(reason="tracked")\n'),
    ).not.toContain("focused-or-skipped-test");
  });

  it("detects UI slop rules and async state combinations", () => {
    expect(findingIds("src/App.tsx", "<img src=\"/a.png\">\n")).toContain("img-missing-alt");
    expect(findingIds("src/App.tsx", '<img src="/a.png" alt="a">\n')).not.toContain(
      "img-missing-alt",
    );
    expect(findingIds("src/App.tsx", "<button></button>\n")).toContain(
      "a11y-control-name",
    );
    expect(findingIds("src/App.tsx", '<button aria-label="go"></button>\n')).not.toContain(
      "a11y-control-name",
    );
    expect(findingIds("src/App.tsx", "<button>Go</button>\n")).not.toContain(
      "a11y-control-name",
    );
    expect(findingIds("src/App.tsx", "const title = 'Lorem ipsum';\n")).toContain(
      "placeholder-copy",
    );

    const useQueryMissing = findingIds(
      "src/App.tsx",
      'useQuery({ queryKey: ["x"] });\nconst loading = true;\n',
    );
    expect(useQueryMissing).toContain("async-missing-states");
    const useQueryComplete = findingIds(
      "src/App.tsx",
      'useQuery({ queryKey: ["x"] });\nconst loading = true;\nconst error = null;\n',
    );
    expect(useQueryComplete).not.toContain("async-missing-states");
  });

  it("detects inline and bare except empty-catch variants", () => {
    expect(findingIds("src/app.ts", "try { run(); } catch (e) { }\n")).toContain(
      "empty-catch",
    );
    const bareExcept = scanFileLinesForSlop(
      "src/app.py",
      "try:\n    run()\nexcept:\n    pass\n",
      null,
    );
    expect(
      bareExcept.findings.filter((f) => f.ruleId === "empty-catch"),
    ).toHaveLength(1);
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

  it("scans tracked diffs and untracked additions in the default diff scope", async () => {
    fs.writeFileSync(path.join(repoDir, "src", "tracked.ts"), "export const ok = 1;\n");
    await execCommand("git", ["add", "-A"], { cwd: repoDir });
    await execCommand("git", ["commit", "-m", "tracked base"], { cwd: repoDir });

    fs.writeFileSync(
      path.join(repoDir, "src", "tracked.ts"),
      "export const ok = 1;\n// TODO tracked change\n",
    );
    fs.writeFileSync(path.join(repoDir, "src", "untracked.ts"), "// TODO untracked change\n");

    const response = await invokeToolDefinition(
      nyxSlopCheckTool,
      { worktreePath: repoDir },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(response.isError).toBeFalsy();
    const data = response.structuredContent as {
      status: string;
      scope: string;
      findings: Array<{ ruleId: string; filePath: string }>;
    };
    expect(data.scope).toBe("diff");
    expect(data.status).toBe("RED");
    const files = data.findings
      .filter((finding) => finding.ruleId === "todo-fixme")
      .map((finding) => finding.filePath)
      .sort();
    expect(files).toEqual(["src/tracked.ts", "src/untracked.ts"]);

    // An explicitly empty changedFiles list also falls back to git diff.
    const emptyList = await invokeToolDefinition(
      nyxSlopCheckTool,
      { worktreePath: repoDir, scope: "diff", changedFiles: [] },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect((emptyList.structuredContent as { status: string }).status).toBe("RED");
  });

  it("walks code files in full scope while skipping ignored directories", async () => {
    for (const dir of ["node_modules", "dist", "coverage", ".nyxowl"]) {
      fs.mkdirSync(path.join(repoDir, dir), { recursive: true });
      fs.writeFileSync(path.join(repoDir, dir, "ignored.ts"), "// TODO ignored\n");
    }
    fs.writeFileSync(path.join(repoDir, "src", "ok.ts"), "// TODO real\n");

    const ctx = await createToolContext(
      { worktreePath: repoDir },
      { defaultProjectPath: repoDir, nyxHome },
    );
    ctx.db.db
      .prepare(
        "INSERT INTO dna (repo_id, manifest_hash, dna_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(ctx.repoId, "hash", "{broken", new Date().toISOString());
    ctx.db.close();

    const response = await invokeToolDefinition(
      nyxSlopCheckTool,
      { worktreePath: repoDir, scope: "full" },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(response.isError).toBeFalsy();
    const findings = (response.structuredContent as {
      findings: Array<{ ruleId: string; filePath: string }>;
    }).findings.filter((finding) => finding.ruleId === "todo-fixme");
    expect(findings.map((finding) => finding.filePath)).toEqual(["src/ok.ts"]);
  });

  it("skips broken symlinks, directories, and unreadable paths", async () => {
    fs.symlinkSync(
      path.join(repoDir, "missing-target.ts"),
      path.join(repoDir, "src", "broken.ts"),
    );
    fs.mkdirSync(path.join(repoDir, "src", "directory.ts"));

    const response = await invokeToolDefinition(
      nyxSlopCheckTool,
      {
        worktreePath: repoDir,
        scope: "full",
        changedFiles: ["src/broken.ts", "src/directory.ts", "src/missing.ts"],
      },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(response.isError).toBeFalsy();
    expect((response.structuredContent as { status: string }).status).toBe("GREEN");
    expect((response.structuredContent as { findings: unknown[] }).findings).toEqual([]);
  });

  it("applies disabled rules and advisory escalation from repository config", async () => {
    fs.writeFileSync(path.join(repoDir, "src", "ok.ts"), "// TODO real\n");
    fs.mkdirSync(path.join(repoDir, ".nyxowl"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".nyxowl", "config.json"),
      JSON.stringify({ slop: { disable: ["todo-fixme"] } }),
    );

    const disabled = await invokeToolDefinition(
      nyxSlopCheckTool,
      { worktreePath: repoDir, scope: "full", changedFiles: ["src/ok.ts"] },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect((disabled.structuredContent as { status: string }).status).toBe("GREEN");

    fs.writeFileSync(
      path.join(repoDir, ".nyxowl", "config.json"),
      JSON.stringify({ slop: { advisoryAsBlocking: true } }),
    );
    fs.writeFileSync(path.join(repoDir, "src", "Color.tsx"), "const c = #ff00aa;\n");
    const escalated = await invokeToolDefinition(
      nyxSlopCheckTool,
      { worktreePath: repoDir, scope: "full", changedFiles: ["src/Color.tsx"] },
      { defaultProjectPath: repoDir, nyxHome },
    );
    const data = escalated.structuredContent as {
      status: string;
      blockingCount: number;
      advisoryCount: number;
    };
    expect(data.status).toBe("RED");
    expect(data.blockingCount).toBe(1);
    expect(data.advisoryCount).toBe(0);
  });
});

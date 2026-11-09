import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.ts";
import { compareToolLists, runMcpSmoke } from "../../src/cli/mcp-smoke.ts";

describe("MCP smoke comparator", () => {
  it("returns null for exact set equality without duplicates", () => {
    expect(compareToolLists(["a", "b", "c"], ["c", "b", "a"])).toBeNull();
    expect(compareToolLists([], [])).toBeNull();
  });

  it("names duplicate tools", () => {
    expect(compareToolLists(["a", "a", "b"], ["a", "b"])).toBe("duplicate: a");
  });

  it("names missing tools", () => {
    expect(compareToolLists(["a"], ["a", "b", "c"])).toBe("missing: b, c");
  });

  it("names extra tools", () => {
    expect(compareToolLists(["a", "b", "c"], ["a"])).toBe("extra: b, c");
  });

  it("reports every category in one reason", () => {
    expect(compareToolLists(["a", "a", "x"], ["a", "b"])).toBe(
      "missing: b; extra: x; duplicate: a",
    );
  });
});

describe("runMcpSmoke", () => {
  it("completes a live in-memory ListTools round-trip", async () => {
    const result = await runMcpSmoke();
    expect(result).toEqual({
      ok: true,
      toolCount: 39,
      message: "39 tools listed",
    });
  });
});

describe("doctor MCP smoke line", () => {
  let tmpRoot: string;
  const originalInstall = process.env["NYXOWL_TESTWRITER_INSTALL"];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-mcp-smoke-"));
    process.env["NYXOWL_TESTWRITER_INSTALL"] = "0";
  });

  afterEach(() => {
    if (originalInstall === undefined) {
      delete process.env["NYXOWL_TESTWRITER_INSTALL"];
    } else {
      process.env["NYXOWL_TESTWRITER_INSTALL"] = originalInstall;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("prints the count derived from the live ListTools round-trip", async () => {
    const res = await runCli(["doctor"], {
      nyxowlHome: path.join(tmpRoot, "nyxowl-home"),
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("MCP Smoke Test: OK (39 tools listed)");
    expect(res.stdout).not.toContain("registered");
  });
});

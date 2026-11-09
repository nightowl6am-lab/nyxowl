import { describe, expect, it } from "vitest";
import { ALL_NYX_TOOLS } from "../../src/mcp/server.ts";
import { NYX_MCP_TOOL_BASENAMES } from "../../src/cli/compiler.ts";

describe("MCP tool deny-list synchronization", () => {
  it("keeps NYX_MCP_TOOL_BASENAMES exactly equal to the registered server tools", () => {
    const registered = ALL_NYX_TOOLS.map((tool) =>
      tool.name.startsWith("nyx_") ? tool.name.slice("nyx_".length) : tool.name,
    ).sort();

    expect(registered).toHaveLength(38);
    expect(new Set(registered).size).toBe(38);
    expect([...NYX_MCP_TOOL_BASENAMES].sort()).toEqual(registered);
  });

  it("has a unique exact-deny entry for every registered tool", () => {
    const names = [...NYX_MCP_TOOL_BASENAMES];
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name) => name.includes("*"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_NAMES,
  getRoleCapabilities,
  getToolCapability,
  missingCapabilityEntries,
} from "../../src/core/capabilities.ts";
import { ALL_NYX_TOOLS } from "../../src/mcp/server.ts";

describe("capability manifest", () => {
  it("declares exactly one entry for every registered MCP tool", () => {
    const registered = ALL_NYX_TOOLS.map((tool) => tool.name);
    expect(missingCapabilityEntries(registered)).toEqual([]);
  });

  it("exposes every capability flag as a boolean on every entry", () => {
    for (const tool of ALL_NYX_TOOLS) {
      const capability = getToolCapability(tool.name);
      expect(capability, tool.name).not.toBeNull();
      for (const flag of CAPABILITY_FLAG_NAMES) {
        expect(typeof capability![flag], `${tool.name}.${flag}`).toBe("boolean");
      }
      expect(Array.isArray(capability!.limitations)).toBe(true);
    }
  });

  it("does not claim authenticated probing or caller-supplied headers for exploit_probe", () => {
    const capability = getToolCapability("nyx_exploit_probe");
    expect(capability).not.toBeNull();
    expect(capability!.authenticatedProbing).toBe(false);
    expect(capability!.customHeaders).toBe(false);
    expect(capability!.multiServiceProbe).toBe(false);
    expect(capability!.networkEgress).toBe(true);
    expect(capability!.limitations.join(" ")).toMatch(/unauthenticated/);
  });

  it("declares verify_slice as command-executing but not browser-controlling", () => {
    const capability = getToolCapability("nyx_verify_slice");
    expect(capability!.executeCommands).toBe(true);
    expect(capability!.browserControl).toBe(false);
    expect(capability!.limitations.join(" ")).toMatch(/does not drive a browser/);
  });

  it("returns role capabilities from the allowlist and fails closed for unknown roles", () => {
    const sec = getRoleCapabilities("nyx-sec");
    expect(sec.map((capability) => capability.tool)).toContain("nyx_exploit_probe");
    expect(getRoleCapabilities("not-a-role")).toEqual([]);
  });
});

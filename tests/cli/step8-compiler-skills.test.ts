import { describe, expect, it } from "vitest";
import {
  buildCompactCodexAgentsBlock,
  compileAllAgentsAndCommands,
  ROLE_ALLOWED_NYX_TOOLS,
} from "../../src/cli/compiler.ts";
import {
  loadAndValidateSkillRegistry,
  resolveSkillsForAgentRole,
  verifyVendoredSkillIntegrity,
} from "../../src/cli/skills.ts";
import { estimateTokens } from "../../src/core/tokens.ts";

describe("Step 8 — Canonical Agents, Commands, Skill Registry & Vendoring", () => {
  it("validates agents/skills/registry.json and verifies SHA-256 integrity of all 16 vendored skills", () => {
    const registry = loadAndValidateSkillRegistry();
    expect(registry.version).toBe(1);
    expect(Object.keys(registry.skills).length).toBe(16);
    expect(Object.keys(registry.roles).length).toBe(10);

    const integrity = verifyVendoredSkillIntegrity();
    expect(integrity.valid).toBe(true);
    expect(integrity.checked).toBe(16);
    expect(integrity.mismatches).toEqual([]);
  });

  it("compiles all 10 canonical agents and 6 slash commands within prompt budgets and tool scoping (§4.2, §4.4)", () => {
    const bundle = compileAllAgentsAndCommands({
      includeConditionalAll: true,
      maxPromptTokens: 1200,
    });

    expect(bundle.agents.length).toBe(10);
    expect(bundle.commands.length).toBe(6);

    for (const agent of bundle.agents) {
      expect(agent.tokenCount).toBeLessThanOrEqual(1200);
      expect(agent.excludedPlaceholders.length).toBe(1);
      const expectedTools = ROLE_ALLOWED_NYX_TOOLS[agent.contract.id];
      expect(expectedTools).toBeDefined();
      expect(agent.contract.nyx_tools).toEqual(expectedTools);
    }

    const codexBlock = buildCompactCodexAgentsBlock();
    expect(estimateTokens(codexBlock)).toBeLessThanOrEqual(300);
  });

  it("resolves DNA-conditional skills for nyx-db, nyx-api, and nyx-probe only when DNA matches", () => {
    const dbNoPostgres = resolveSkillsForAgentRole({
      role: "nyx-db",
      dnaTags: ["sqlite"],
    });
    expect(dbNoPostgres.resolved.map((s) => s.name)).toEqual(["database-migrations"]);
    expect(dbNoPostgres.excludedPlaceholders).toEqual(["nyx-database"]);

    const dbPostgres = resolveSkillsForAgentRole({
      role: "nyx-db",
      dnaTags: ["postgres"],
    });
    expect(dbPostgres.resolved.map((s) => s.name)).toEqual([
      "database-migrations",
      "supabase-postgres-best-practices",
      "postgres-rls-audit",
    ]);

    const apiFastifyUpstash = resolveSkillsForAgentRole({
      role: "nyx-api",
      dnaTags: ["fastify", "upstash"],
    });
    expect(apiFastifyUpstash.resolved.map((s) => s.name)).toEqual([
      "fastify-best-practices",
      "upstash-redis-js",
      "upstash-ratelimit-js",
    ]);
  });
});

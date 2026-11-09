import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_BUDGET_OVERRIDES,
  buildNativeSkillLoaderLine,
  buildProjectAgentsBlock,
  compileAllAgentsAndCommands,
  ROLE_ALLOWED_NYX_TOOLS,
} from "../../src/cli/compiler.ts";
import {
  AGENT_SKILL_IDS,
  AGENT_SKILL_MODES,
  INLINE_SKILL_IDS,
  NATIVE_SKILL_IDS,
  agentSkillPath,
  getSkillSlotReport,
  loadAgentSkillPackage,
  loadInlineSkill,
  stripFrontmatter,
} from "../../src/cli/skills.ts";
import { NyxError } from "../../src/core/errors.ts";
import { estimateTokens } from "../../src/core/tokens.ts";

const repoRoot = process.cwd();

describe("Step 8 — Canonical Agents, Commands & Native/Inline Skill Packages", () => {
  it("ships 11 authored skill packages: 10 native and 1 inline, each with a license", () => {
    expect(AGENT_SKILL_IDS.length).toBe(11);
    expect(new Set(AGENT_SKILL_IDS).size).toBe(11);
    expect(NATIVE_SKILL_IDS.length).toBe(10);
    expect([...INLINE_SKILL_IDS]).toEqual(["nyx-testwriter"]);
    expect(AGENT_SKILL_MODES["nyx-testwriter"]).toBe("inline");

    const report = getSkillSlotReport();
    expect(report.length).toBe(11);
    for (const slot of report) {
      expect(slot.loaded, `${slot.agentId} loaded`).toBe(true);
      expect(slot.licensePresent, `${slot.agentId} license`).toBe(true);
      expect(slot.references, `${slot.agentId} references`).toBeGreaterThan(0);
      expect(fs.statSync(slot.path).size, `${slot.agentId} SKILL.md size`).toBeGreaterThan(0);
      expect(slot.path.endsWith(path.join(slot.agentId, "SKILL.md"))).toBe(true);
      const pkg = loadAgentSkillPackage(slot.agentId);
      expect(pkg.skillContent).toBeTruthy();
      expect(pkg.skillContent).toContain("Trust boundary.");
    }
    expect(report.filter((slot) => slot.mode === "native")).toHaveLength(10);
    expect(report.filter((slot) => slot.mode === "inline")).toHaveLength(1);

    expect(fs.existsSync(path.join(repoRoot, "skills-vendor"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "agents", "skills", "registry.json"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "agents", "skills.lock.json"))).toBe(true);
  });

  it("rejects unknown and path-traversal agent skill ids before building a path", () => {
    for (const agentId of ["unknown-agent", "../nyx-api", "nyx-api/../../escape"]) {
      let caught: unknown;
      try {
        agentSkillPath(agentId);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NyxError);
      expect((caught as NyxError).code).toBe("ERR_CONFIG_INVALID");
      expect((caught as Error).message).toBe(`Unknown agent skill id "${agentId}"`);
    }
  });

  it("compiles all 11 agents and 6 commands with native loader lines and one inline prompt", () => {
    const bundle = compileAllAgentsAndCommands({ maxPromptTokens: 1200 });

    expect(bundle.agents.length).toBe(11);
    expect(bundle.commands.length).toBe(6);

    for (const agent of bundle.agents) {
      const expectedMode = AGENT_SKILL_MODES[agent.contract.id as keyof typeof AGENT_SKILL_MODES];
      expect(agent.skillMode).toBe(expectedMode);
      expect(agent.skillLoaded).toBe(true);
      expect(agent.skillLicensePresent).toBe(true);
      expect(agent.skillPath.endsWith(path.join(agent.contract.id, "SKILL.md"))).toBe(true);
      const loader = buildNativeSkillLoaderLine(agent.contract.id);
      if (expectedMode === "native") {
        expect(agent.tokenCount).toBeLessThanOrEqual(1200);
        expect(agent.compiledPrompt.match(/^## Agent Skill$/gm)).toHaveLength(1);
        expect(agent.compiledPrompt).toContain(loader);
        // The skill body is never embedded in a native system prompt.
        expect(agent.compiledPrompt).not.toContain("Trust boundary.");
        expect(agent.compiledPrompt).not.toContain("## Overview");
      } else {
        expect(agent.tokenCount).toBeLessThanOrEqual(6000);
        expect(agent.compiledPrompt.match(/^## Agent Skill$/gm)).toHaveLength(1);
        expect(agent.compiledPrompt).toContain("Security Fix Test-Writer");
        expect(agent.compiledPrompt).toContain("### Inline reference: references/generating.md");
      }
      const expectedTools = ROLE_ALLOWED_NYX_TOOLS[agent.contract.id];
      expect(expectedTools).toBeDefined();
      expect(agent.contract.nyx_tools).toEqual(expectedTools);
    }

    const projectBlock = buildProjectAgentsBlock();
    expect(estimateTokens(projectBlock)).toBeLessThanOrEqual(300);
  });

  it("keeps the testwriter override measured at or below 6000 tokens", () => {
    expect(AGENT_BUDGET_OVERRIDES["nyx-testwriter"]).toBe(6000);
    const bundle = compileAllAgentsAndCommands();
    const testwriter = bundle.agents.find((agent) => agent.contract.id === "nyx-testwriter");
    expect(testwriter).toBeDefined();
    if (!testwriter) return;
    expect(testwriter.tokenCount).toBeGreaterThan(0);
    expect(testwriter.tokenCount).toBeLessThanOrEqual(6000);
    expect(estimateTokens(loadInlineSkill("nyx-testwriter") ?? "")).toBeLessThanOrEqual(6000);
  });

  it("strips frontmatter from inline skill bodies", () => {
    expect(stripFrontmatter("---\nname: x\n---\n\nBody\n")).toBe("Body");
    expect(stripFrontmatter("Body only\n")).toBe("Body only");
  });

  describe("custom skill package injection", () => {
    let tmpRoot: string;
    let pkgRoot: string;

    function seedPackage(): void {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-skill-slot-"));
      pkgRoot = path.join(tmpRoot, "pkg");
      fs.mkdirSync(pkgRoot, { recursive: true });
      fs.writeFileSync(
        path.join(pkgRoot, "package.json"),
        JSON.stringify({ name: "nyx-skill-slot-fixture", version: "1.0.0" }),
      );
      fs.cpSync(path.join(repoRoot, "agents"), path.join(pkgRoot, "agents"), {
        recursive: true,
      });
    }

    beforeEach(seedPackage);

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("native mode ignores the skill body and always emits exactly one loader line", () => {
      fs.writeFileSync(
        path.join(pkgRoot, "agents", "skills", "nyx-api", "SKILL.md"),
        "Custom skill content.",
      );
      const bundle = compileAllAgentsAndCommands({ pkgRoot });
      const api = bundle.agents.find((agent) => agent.contract.id === "nyx-api");
      expect(api).toBeDefined();
      if (!api) return;
      expect(api.skillMode).toBe("native");
      expect(api.compiledPrompt).toContain("Use the `skill` tool with id `nyx-api`");
      expect(api.compiledPrompt).not.toContain("Custom skill content.");
      expect(api.compiledPrompt.match(/^## Agent Skill$/gm)).toHaveLength(1);
    });

    it("inline mode embeds the skill body and its references", () => {
      fs.writeFileSync(
        path.join(pkgRoot, "agents", "skills", "nyx-testwriter", "SKILL.md"),
        "---\nname: nyx-testwriter\n---\n\nInline custom proof body.",
      );
      fs.writeFileSync(
        path.join(pkgRoot, "agents", "skills", "nyx-testwriter", "references", "generating.md"),
        "Inline reference body.",
      );
      const bundle = compileAllAgentsAndCommands({ pkgRoot });
      const testwriter = bundle.agents.find((agent) => agent.contract.id === "nyx-testwriter");
      expect(testwriter).toBeDefined();
      if (!testwriter) return;
      expect(testwriter.skillMode).toBe("inline");
      expect(testwriter.compiledPrompt).toContain("Inline custom proof body.");
      expect(testwriter.compiledPrompt).toContain("### Inline reference: references/generating.md");
      expect(testwriter.compiledPrompt).toContain("Inline reference body.");
    });

    it("fails closed when a skill package or its license is missing", () => {
      fs.rmSync(path.join(pkgRoot, "agents", "skills", "nyx-api", "SKILL.md"));
      expect(() => compileAllAgentsAndCommands({ pkgRoot })).toThrow(/Missing or empty skill package/);

      seedPackage();
      for (const name of fs.readdirSync(path.join(pkgRoot, "agents", "skills", "nyx-api"))) {
        if (name.startsWith("LICENSE")) {
          fs.rmSync(path.join(pkgRoot, "agents", "skills", "nyx-api", name));
        }
      }
      expect(() => compileAllAgentsAndCommands({ pkgRoot })).toThrow(/missing a LICENSE/);
    });
  });
});

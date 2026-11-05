import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildProjectAgentsBlock,
  compileAllAgentsAndCommands,
  ROLE_ALLOWED_NYX_TOOLS,
} from "../../src/cli/compiler.ts";
import { AGENT_SKILL_IDS, agentSkillPath, getSkillSlotReport } from "../../src/cli/skills.ts";
import { NyxError } from "../../src/core/errors.ts";
import { estimateTokens } from "../../src/core/tokens.ts";

const repoRoot = process.cwd();

describe("Step 8 — Canonical Agents, Commands & Per-Agent Skill Slots", () => {
  it("ships exactly 11 empty per-agent skill slots and no vendored/registry skill system", () => {
    expect(AGENT_SKILL_IDS.length).toBe(11);
    expect(new Set(AGENT_SKILL_IDS).size).toBe(11);

    const report = getSkillSlotReport();
    expect(report.length).toBe(11);
    for (const slot of report) {
      expect(fs.existsSync(slot.path)).toBe(true);
      expect(fs.statSync(slot.path).size).toBe(0);
      expect(slot.loaded).toBe(false);
      expect(slot.path.endsWith(path.join(slot.agentId, "SKILL.md"))).toBe(true);
    }

    expect(fs.existsSync(path.join(repoRoot, "skills-vendor"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "agents", "skills", "registry.json"))).toBe(false);
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

  it("compiles all 11 canonical agents and 6 slash commands with empty skill slots", () => {
    const bundle = compileAllAgentsAndCommands({ maxPromptTokens: 1200 });

    expect(bundle.agents.length).toBe(11);
    expect(bundle.commands.length).toBe(6);

    for (const agent of bundle.agents) {
      expect(agent.tokenCount).toBeLessThanOrEqual(1200);
      expect(agent.skillLoaded).toBe(false);
      expect(agent.skillPath.endsWith(path.join(agent.contract.id, "SKILL.md"))).toBe(true);
      expect(agent.compiledPrompt).not.toContain("## Agent Skill");
      const expectedTools = ROLE_ALLOWED_NYX_TOOLS[agent.contract.id];
      expect(expectedTools).toBeDefined();
      expect(agent.contract.nyx_tools).toEqual(expectedTools);
    }

    const projectBlock = buildProjectAgentsBlock();
    expect(estimateTokens(projectBlock)).toBeLessThanOrEqual(300);
  });

  describe("custom skill slot injection", () => {
    let tmpRoot: string;
    let pkgRoot: string;

    beforeEach(() => {
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
      fs.writeFileSync(
        path.join(pkgRoot, "agents", "skills", "nyx-api", "SKILL.md"),
        "Custom skill content.",
      );
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("appends the slot content only to the matching agent prompt", () => {
      const bundle = compileAllAgentsAndCommands({ pkgRoot });
      expect(bundle.agents.length).toBe(11);

      for (const agent of bundle.agents) {
        if (agent.contract.id === "nyx-api") {
          expect(agent.skillLoaded).toBe(true);
          expect(agent.compiledPrompt).toContain("## Agent Skill\nCustom skill content.");
        } else {
          expect(agent.skillLoaded).toBe(false);
          expect(agent.compiledPrompt).not.toContain("## Agent Skill");
        }
      }
    });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateOpenCodeHostPackage, syncSkillPackages } from "../../src/cli/adapters/opencode.ts";
import { ensureFirstRunSetup } from "../../src/cli/setup.ts";
import {
  AGENT_SKILL_IDS,
  AGENT_SKILL_MODES,
  NATIVE_SKILL_IDS,
} from "../../src/cli/skills.ts";
import { NYX_MCP_TOOL_BASENAMES } from "../../src/cli/compiler.ts";

interface Rule {
  action: string;
  resource: string;
  effect: string;
}

interface GeneratedAgent {
  mode: string;
  description: string;
  system: string;
  permissions: Rule[];
  model?: unknown;
}

interface GeneratedConfig {
  skills: string[];
  agents: Record<string, GeneratedAgent>;
  permissions: Rule[];
}

describe("OpenCode native skill registration", () => {
  let tmpRoot: string;
  let nyxowlHome: string;
  let projectDir: string;
  let config: GeneratedConfig;
  let packageDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-opencode-skills-"));
    nyxowlHome = path.join(tmpRoot, "nyxowl-home");
    projectDir = path.join(tmpRoot, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const pkg = generateOpenCodeHostPackage({ nyxowlHome, projectPath: projectDir });
    packageDir = pkg.packageDir;
    config = JSON.parse(fs.readFileSync(pkg.configPath, "utf8")) as GeneratedConfig;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("registers one absolute skills root and copies all 11 packages", () => {
    const skillsRoot = path.join(packageDir, "skills");
    expect(path.isAbsolute(skillsRoot)).toBe(true);
    expect(config.skills).toEqual([skillsRoot]);

    const dirs = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual([...AGENT_SKILL_IDS].sort());
    for (const agentId of AGENT_SKILL_IDS) {
      expect(fs.readFileSync(path.join(skillsRoot, agentId, "SKILL.md"), "utf8").length).toBeGreaterThan(0);
    }
  });

  it("prunes stale skill directories on regeneration", () => {
    const stale = path.join(packageDir, "skills", "stale-skill");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "SKILL.md"), "stale\n");

    generateOpenCodeHostPackage({ nyxowlHome, projectPath: projectDir });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(packageDir, "skills", "nyxowl", "SKILL.md"))).toBe(true);
  });

  it("adds per-agent skill deny/allow rules: deny all, then the exact native id", () => {
    for (const agentId of AGENT_SKILL_IDS) {
      const agent = config.agents[agentId];
      expect(agent, agentId).toBeDefined();
      if (!agent) continue;
      const deny = agent.permissions.findIndex(
        (rule) => rule.action === "skill" && rule.resource === "*" && rule.effect === "deny",
      );
      expect(deny, `${agentId} skill deny`).toBeGreaterThanOrEqual(0);
      const allows = agent.permissions.filter(
        (rule) => rule.action === "skill" && rule.effect === "allow",
      );
      if (AGENT_SKILL_MODES[agentId] === "native") {
        expect(allows, `${agentId} exact allow`).toEqual([
          { action: "skill", resource: agentId, effect: "allow" },
        ]);
        const allowIndex = agent.permissions.findIndex(
          (rule) => rule.action === "skill" && rule.resource === agentId,
        );
        expect(allowIndex).toBeGreaterThan(deny);
      } else {
        expect(allows, `${agentId} inline deny only`).toHaveLength(0);
      }
    }
    expect(NATIVE_SKILL_IDS).toHaveLength(10);
  });

  it("denies all 38 MCP tools by exact name and never emits a nyxowl_* wildcard", () => {
    const expectedDenies = NYX_MCP_TOOL_BASENAMES.map((tool) => `nyxowl_nyx_${tool}`).sort();
    for (const agentId of AGENT_SKILL_IDS) {
      const agent = config.agents[agentId];
      if (!agent) continue;
      expect(
        agent.permissions.some((rule) => rule.action === "nyxowl_*"),
        `${agentId} wildcard`,
      ).toBe(false);
      const denies = agent.permissions
        .filter((rule) => rule.action.startsWith("nyxowl_") && rule.effect === "deny")
        .map((rule) => rule.action)
        .sort();
      expect(denies, `${agentId} exact denies`).toEqual(expectedDenies);
      expect(agent.model, `${agentId} model`).toBeUndefined();
    }
  });

  it("regenerates the host package on an already-initialized home, replacing stale v0.1.0 config", async () => {
    const configPath = path.join(nyxowlHome, "hosts", "opencode", "opencode.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          mcp: { nyxowl: { command: "nyxowl", args: ["mcp"] } },
          plugin: "nyxowl",
          permission: [{ action: "read", resource: "*", effect: "allow" }],
        },
        null,
        2,
      )}\n`,
    );

    const result = await ensureFirstRunSetup({
      nyxowlHome,
      envPath: process.env["PATH"] ?? "",
      installTestWriter: false,
    });

    const regenerated = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcp: Record<string, unknown>;
      skills: string[];
      permissions: Rule[];
      plugin?: unknown;
    };
    expect(regenerated.mcp["servers"]).toBeDefined();
    expect(regenerated.mcp["nyxowl"]).toBeUndefined();
    expect(regenerated.plugin).toBeUndefined();
    expect(regenerated.skills).toEqual([path.join(packageDir, "skills")]);
    expect(Array.isArray(regenerated.permissions)).toBe(true);
    const summary = result.summaryLines.find((line) => line.startsWith("Skill packages:"));
    expect(summary).toBeDefined();
    expect(summary).toContain("Skill packages: 11/11 loaded (10 native, 1 inline)");
    expect(summary).toContain("references: 22");
    expect(summary).toContain("licenses: 11/11");
  });

  it("allows only the host skills root for non-interactive reference reads, after the external_directory ask", () => {
    const skillsRoot = path.join(packageDir, "skills");
    const askIndex = config.permissions.findIndex(
      (rule) =>
        rule.action === "external_directory" && rule.resource === "*" && rule.effect === "ask",
    );
    expect(askIndex).toBeGreaterThanOrEqual(0);

    const skillsAllowIndexes = [skillsRoot, `${skillsRoot}/**`].map((resource) =>
      config.permissions.findIndex(
        (rule) =>
          rule.action === "external_directory" &&
          rule.resource === resource &&
          rule.effect === "allow",
      ),
    );
    for (const index of skillsAllowIndexes) {
      expect(index).toBeGreaterThan(askIndex);
    }

    const otherExternalAllows = config.permissions
      .map((rule, index) => ({ rule, index }))
      .filter(
        ({ rule, index }) =>
          rule.action === "external_directory" &&
          rule.effect === "allow" &&
          !skillsAllowIndexes.includes(index),
      )
      .map(({ index }) => index);
    for (const index of skillsAllowIndexes) {
      for (const other of otherExternalAllows) {
        expect(index).toBeGreaterThan(other);
      }
    }

    expect(
      config.permissions.some(
        (rule) =>
          rule.action === "external_directory" &&
          rule.effect === "allow" &&
          (rule.resource === "~/.nyxowl/**" || rule.resource === "**/.nyxowl/**"),
      ),
    ).toBe(false);
  });

  it("rejects symlinks in a skill package before copying", () => {
    const pkgRoot = path.join(tmpRoot, "symlink-pkg-root");
    fs.mkdirSync(path.join(pkgRoot, "agents"), { recursive: true });
    fs.cpSync(path.join(process.cwd(), "agents", "skills"), path.join(pkgRoot, "agents", "skills"), {
      recursive: true,
    });
    fs.symlinkSync(
      "../SKILL.md",
      path.join(pkgRoot, "agents", "skills", "nyx-api", "references", "evil.md"),
    );

    expect(() =>
      syncSkillPackages({
        packageDir: path.join(tmpRoot, "symlink-host"),
        pkgRoot,
      }),
    ).toThrow(/symlink/i);
  });
});

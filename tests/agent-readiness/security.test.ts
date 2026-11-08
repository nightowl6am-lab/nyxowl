import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAgentPermissionRules,
  buildOpenCodePermissions,
} from "../../src/cli/adapters/opencode.ts";
import { AGENT_SKILL_IDS, agentSkillPath } from "../../src/cli/skills.ts";
import { compileAllAgentsAndCommands, ROLE_ALLOWED_NYX_TOOLS } from "../../src/cli/compiler.ts";
import { EXPECTED_AGENTS } from "./expected.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_DIR = path.join(ROOT, "tests", "agent-readiness", "base");
const FIXTURES_DIR = path.join(ROOT, "tests", "agent-readiness", "fixtures");

const FULLY_ISOLATED_ACTIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "shell",
  "webfetch",
  "websearch",
  "subagent",
  "skill",
  "question",
  "external_directory",
  "experimental_image_generate",
  "execute",
] as const;

const bundle = compileAllAgentsAndCommands();

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function assertNoInertViolations(dir: string): void {
  for (const file of listFiles(dir)) {
    const name = path.basename(file);
    expect(name === ".env" || (name.startsWith(".env.") && name !== ".env.example"), file).toBe(
      false,
    );
    const text = fs.readFileSync(file, "utf8");
    expect(text, `${file} contains sudo`).not.toMatch(/\bsudo\b/);
    expect(text, `${file} contains gh pr merge`).not.toMatch(/gh\s+pr\s+merge/i);
    expect(text, `${file} contains a real private key`).not.toMatch(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    );
    for (const match of text.matchAll(/https?:\/\/([^\s"'/]+)/g)) {
      const host = match[1] ?? "";
      expect(["127.0.0.1", "localhost", "[::1]"], `${file} URL host ${host}`).toContain(host);
    }
  }
}

describe("agent readiness: security boundary", () => {
  it("denies secret paths, allows .env.example last, denies webfetch, and asks on red lines", () => {
    const perms = buildOpenCodePermissions("/tmp/worktrees/readiness");
    expect(
      perms.some(
        (rule) => rule.action === "read" && rule.resource === "**/.env*" && rule.effect === "deny",
      ),
    ).toBe(true);
    const lastEnvDeny = perms.reduce(
      (last, rule, index) =>
        rule.action === "read" && rule.resource.includes(".env") && rule.effect === "deny"
          ? index
          : last,
      -1,
    );
    const exampleAllow = perms.findIndex(
      (rule) => rule.action === "read" && rule.resource === ".env.example",
    );
    expect(lastEnvDeny).toBeGreaterThanOrEqual(0);
    expect(exampleAllow).toBeGreaterThan(lastEnvDeny);
    expect(perms.some((rule) => rule.action === "webfetch" && rule.effect === "deny")).toBe(true);
    expect(perms.some((rule) => rule.action === "websearch" && rule.effect === "deny")).toBe(true);
    for (const command of ["gh pr merge*", "git push origin main*"]) {
      expect(
        perms.some(
          (rule) => rule.action === "shell" && rule.resource === command && rule.effect === "ask",
        ),
        command,
      ).toBe(true);
    }
  });

  it("keeps nyxowl_* deny before per-role allows and allows exactly the role tool set", () => {
    for (const expected of EXPECTED_AGENTS) {
      const agent = bundle.agents.find((candidate) => candidate.contract.id === expected.id);
      expect(agent, `${expected.id} compiled agent`).toBeDefined();
      if (!agent) continue;
      const rules = buildAgentPermissionRules(agent);
      const denyIndex = rules.findIndex(
        (rule) => rule.action === "nyxowl_*" && rule.effect === "deny",
      );
      expect(denyIndex, `${expected.id} wildcard deny`).toBeGreaterThanOrEqual(0);
      const allowed = rules
        .map((rule, index) => ({ rule, index }))
        .filter(({ rule }) => rule.action.startsWith("nyxowl_") && rule.effect === "allow");
      expect(
        allowed.map(({ rule }) => rule.action).sort(),
        `${expected.id} allowed actions`,
      ).toEqual(
        (ROLE_ALLOWED_NYX_TOOLS[expected.id] ?? [])
          .map((tool) => `nyxowl_nyx_${tool}`)
          .sort(),
      );
      for (const { index } of allowed) {
        expect(index, `${expected.id} allow after deny`).toBeGreaterThan(denyIndex);
      }
      for (const action of ["webfetch", "websearch"] as const) {
        expect(
          rules.some((rule) => rule.action === action && rule.effect === "deny"),
          `${expected.id} ${action} deny`,
        ).toBe(true);
        expect(
          rules.some((rule) => rule.action === action && rule.effect === "allow"),
          `${expected.id} ${action} must not be allowed`,
        ).toBe(false);
      }
      for (const rule of rules) {
        if (!rule.action.startsWith("nyxowl_")) {
          expect(rule.effect, `${expected.id} host action ${rule.action}`).toBe("deny");
        }
      }
    }
  });

  it("fully isolates nyx-testwriter from every host action", () => {
    const agent = bundle.agents.find((candidate) => candidate.contract.id === "nyx-testwriter");
    expect(agent).toBeDefined();
    if (!agent) return;
    const rules = buildAgentPermissionRules(agent);
    for (const action of FULLY_ISOLATED_ACTIONS) {
      expect(
        rules.some((rule) => rule.action === action && rule.effect === "deny"),
        action,
      ).toBe(true);
      expect(
        rules.some((rule) => rule.action === action && rule.effect === "allow"),
        `${action} must not be allowed`,
      ).toBe(false);
    }
    expect(rules.filter((rule) => rule.effect === "allow")).toHaveLength(
      (ROLE_ALLOWED_NYX_TOOLS["nyx-testwriter"] ?? []).length,
    );
  });

  it("keeps every fixture inert and every skill slot untouched", () => {
    assertNoInertViolations(BASE_DIR);
    assertNoInertViolations(FIXTURES_DIR);
    expect(AGENT_SKILL_IDS).toHaveLength(11);
    for (const agentId of AGENT_SKILL_IDS) {
      expect(fs.statSync(agentSkillPath(agentId)).size, agentId).toBe(0);
    }
  });
});

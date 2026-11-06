import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NyxError } from "../core/errors.ts";

export const AGENT_SKILL_IDS = [
  "nyxowl",
  "nyx-product",
  "nyx-architect",
  "nyx-designer",
  "nyx-db",
  "nyx-api",
  "nyx-ui",
  "nyx-sec",
  "nyx-testwriter",
  "nyx-probe",
  "nyx-devops",
] as const;

export type AgentSkillId = (typeof AGENT_SKILL_IDS)[number];

function assertAgentSkillId(agentId: string): asserts agentId is AgentSkillId {
  if (!(AGENT_SKILL_IDS as readonly string[]).includes(agentId)) {
    throw new NyxError("ERR_CONFIG_INVALID", `Unknown agent skill id "${agentId}"`);
  }
}

export function resolvePackageRoot(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  let cur = thisDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, "package.json")) && fs.existsSync(path.join(cur, "agents"))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return process.cwd();
}

export function agentSkillPath(agentId: string, pkgRoot = resolvePackageRoot()): string {
  assertAgentSkillId(agentId);
  return path.join(pkgRoot, "agents", "skills", agentId, "SKILL.md");
}

export function loadAgentSkill(agentId: string, pkgRoot = resolvePackageRoot()): string | null {
  const skillPath = agentSkillPath(agentId, pkgRoot);
  if (!fs.existsSync(skillPath)) return null;
  const content = fs.readFileSync(skillPath, "utf8").trim();
  return content.length > 0 ? content : null;
}

export function getSkillSlotReport(
  pkgRoot = resolvePackageRoot(),
): Array<{ agentId: string; path: string; loaded: boolean }> {
  return AGENT_SKILL_IDS.map((agentId) => ({
    agentId,
    path: agentSkillPath(agentId, pkgRoot),
    loaded: loadAgentSkill(agentId, pkgRoot) !== null,
  }));
}

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
export type AgentSkillMode = "native" | "inline";

/**
 * Native skills are advertised to the OpenCode host through the absolute
 * `skills` root and loaded by the model on demand with the `skill` tool.
 * Inline skills have no host registration; their text is embedded in the
 * agent system prompt.
 */
export const AGENT_SKILL_MODES: Record<AgentSkillId, AgentSkillMode> = {
  nyxowl: "native",
  "nyx-product": "native",
  "nyx-architect": "native",
  "nyx-designer": "native",
  "nyx-db": "native",
  "nyx-api": "native",
  "nyx-ui": "native",
  "nyx-sec": "native",
  "nyx-testwriter": "inline",
  "nyx-probe": "native",
  "nyx-devops": "native",
};

export const NATIVE_SKILL_IDS: readonly AgentSkillId[] = AGENT_SKILL_IDS.filter(
  (agentId) => AGENT_SKILL_MODES[agentId] === "native",
);

export const INLINE_SKILL_IDS: readonly AgentSkillId[] = AGENT_SKILL_IDS.filter(
  (agentId) => AGENT_SKILL_MODES[agentId] === "inline",
);

export interface AgentSkillPackage {
  agentId: AgentSkillId;
  mode: AgentSkillMode;
  dir: string;
  skillPath: string;
  skillContent: string | null;
  references: string[];
  files: string[];
  licenseFiles: string[];
  licensePresent: boolean;
  loaded: boolean;
}

export interface AgentSkillSlotReport {
  agentId: AgentSkillId;
  path: string;
  loaded: boolean;
  mode: AgentSkillMode;
  references: number;
  licensePresent: boolean;
}

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

export function agentSkillDir(agentId: string, pkgRoot = resolvePackageRoot()): string {
  assertAgentSkillId(agentId);
  return path.join(pkgRoot, "agents", "skills", agentId);
}

export function agentSkillPath(agentId: string, pkgRoot = resolvePackageRoot()): string {
  assertAgentSkillId(agentId);
  return path.join(agentSkillDir(agentId, pkgRoot), "SKILL.md");
}

export function loadAgentSkill(agentId: string, pkgRoot = resolvePackageRoot()): string | null {
  const skillPath = agentSkillPath(agentId, pkgRoot);
  if (!fs.existsSync(skillPath)) return null;
  const content = fs.readFileSync(skillPath, "utf8").trim();
  return content.length > 0 ? content : null;
}

/**
 * Removes a leading YAML frontmatter block. Skill bodies are embedded in a
 * system prompt, where the host-only frontmatter has no meaning.
 */
export function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (match?.[1] ?? raw).trim();
}

function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

export function listSkillFiles(agentId: string, pkgRoot = resolvePackageRoot()): string[] {
  return listFilesRecursive(agentSkillDir(agentId, pkgRoot));
}

export function loadAgentSkillPackage(
  agentId: string,
  pkgRoot = resolvePackageRoot(),
): AgentSkillPackage {
  assertAgentSkillId(agentId);
  const dir = agentSkillDir(agentId, pkgRoot);
  const skillPath = path.join(dir, "SKILL.md");
  const skillContent = loadAgentSkill(agentId, pkgRoot);
  const files = listSkillFiles(agentId, pkgRoot);
  const references = files.filter((file) => file.startsWith("references/"));
  const licenseFiles = files.filter(
    (file) => path.posix.basename(file).startsWith("LICENSE") || file === "LICENSE",
  );
  return {
    agentId,
    mode: AGENT_SKILL_MODES[agentId],
    dir,
    skillPath,
    skillContent,
    references,
    files,
    licenseFiles,
    licensePresent: licenseFiles.length > 0,
    loaded: skillContent !== null,
  };
}

/**
 * Concatenates an inline skill's body and its `references/` files. Only the
 * inline agents use this path; native agents receive a loader line instead.
 */
export function loadInlineSkill(agentId: string, pkgRoot = resolvePackageRoot()): string | null {
  const pkg = loadAgentSkillPackage(agentId, pkgRoot);
  if (pkg.mode !== "inline" || !pkg.skillContent) return null;
  const parts = [stripFrontmatter(pkg.skillContent)];
  for (const relative of pkg.references) {
    const full = path.join(pkg.dir, relative);
    const content = fs.readFileSync(full, "utf8").trim();
    if (!content) continue;
    parts.push(`### Inline reference: ${relative}\n\n${stripFrontmatter(content)}`);
  }
  return parts.join("\n\n");
}

export function getSkillSlotReport(pkgRoot = resolvePackageRoot()): AgentSkillSlotReport[] {
  return AGENT_SKILL_IDS.map((agentId) => {
    const pkg = loadAgentSkillPackage(agentId, pkgRoot);
    return {
      agentId,
      path: pkg.skillPath,
      loaded: pkg.loaded,
      mode: pkg.mode,
      references: pkg.references.length,
      licensePresent: pkg.licensePresent,
    };
  });
}

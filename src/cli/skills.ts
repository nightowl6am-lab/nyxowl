import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { NyxError } from "../core/errors.ts";

export const skillEntrySchema = z.object({
  source: z.string().min(1),
  license: z.string().min(1),
  sha: z.string().min(7),
  integrity: z.string().regex(/^sha256-[A-Fa-f0-9]{64}$/),
  delivery: z.enum(["vendored", "fetched"]),
  author: z.string().optional(),
});

export const roleSkillRuleSchema = z.object({
  always: z.array(z.string()),
  when: z.array(
    z.object({
      dna: z.string().min(1),
      skills: z.array(z.string()),
    }),
  ),
  custom: z.string().min(1),
});

export const skillRegistrySchema = z.object({
  version: z.literal(1),
  skills: z.record(z.string(), skillEntrySchema),
  roles: z.record(z.string(), roleSkillRuleSchema),
});

export type SkillRegistry = z.infer<typeof skillRegistrySchema>;

export interface ResolvedSkill {
  name: string;
  sourcePath: string;
  origin: "user" | "vendored" | "custom";
  description: string;
}

export interface RoleSkillResolution {
  role: string;
  resolved: ResolvedSkill[];
  unavailable: string[];
  excludedPlaceholders: string[];
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

export function loadAndValidateSkillRegistry(pkgRoot = resolvePackageRoot()): SkillRegistry {
  const regPath = path.join(pkgRoot, "agents", "skills", "registry.json");
  if (!fs.existsSync(regPath)) {
    throw new NyxError("ERR_CONFIG_INVALID", `Skill registry not found at ${regPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(regPath, "utf8")) as unknown;
  const parsed = skillRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new NyxError(
      "ERR_CONFIG_INVALID",
      `Invalid agents/skills/registry.json: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function verifyVendoredSkillIntegrity(
  pkgRoot = resolvePackageRoot(),
): { valid: boolean; checked: number; mismatches: Array<{ skill: string; expected: string; actual: string }> } {
  const registry = loadAndValidateSkillRegistry(pkgRoot);
  const mismatches: Array<{ skill: string; expected: string; actual: string }> = [];
  let checked = 0;

  for (const [skillName, meta] of Object.entries(registry.skills)) {
    if (meta.delivery !== "vendored") continue;
    const skillMdPath = path.join(pkgRoot, "skills-vendor", skillName, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      mismatches.push({
        skill: skillName,
        expected: meta.integrity,
        actual: "MISSING",
      });
      continue;
    }
    const buf = fs.readFileSync(skillMdPath);
    const actual = `sha256-${crypto.createHash("sha256").update(buf).digest("hex")}`;
    checked++;
    if (actual !== meta.integrity) {
      mismatches.push({
        skill: skillName,
        expected: meta.integrity,
        actual,
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    checked,
    mismatches,
  };
}

function parseSkillFrontmatter(skillMdPath: string): {
  name?: string;
  description?: string;
  isPlaceholder: boolean;
} {
  const raw = fs.readFileSync(skillMdPath, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || !match[1]) {
    return { isPlaceholder: false };
  }
  try {
    const doc = YAML.parse(match[1]) as {
      name?: string;
      description?: string;
      metadata?: { status?: string };
    };
    const isPlaceholder = doc?.metadata?.status === "placeholder";
    return {
      ...(doc?.name ? { name: doc.name } : {}),
      ...(doc?.description ? { description: doc.description } : {}),
      isPlaceholder,
    };
  } catch {
    return { isPlaceholder: false };
  }
}

export function resolveSkillsForAgentRole(options: {
  role: string;
  dnaTags?: Iterable<string>;
  includeConditionalAll?: boolean;
  userSkillsDir?: string;
  pkgRoot?: string;
}): RoleSkillResolution {
  const pkgRoot = options.pkgRoot ?? resolvePackageRoot();
  const registry = loadAndValidateSkillRegistry(pkgRoot);
  const roleCfg = registry.roles[options.role];
  if (!roleCfg) {
    return {
      role: options.role,
      resolved: [],
      unavailable: [],
      excludedPlaceholders: [],
    };
  }

  const dnaSet = new Set<string>(
    Array.from(options.dnaTags ?? []).map((t) => t.toLowerCase()),
  );

  const requestedNames = new Set<string>(roleCfg.always);
  for (const cond of roleCfg.when) {
    if (options.includeConditionalAll || dnaSet.has(cond.dna.toLowerCase())) {
      for (const s of cond.skills) {
        requestedNames.add(s);
      }
    }
  }

  const resolved: ResolvedSkill[] = [];
  const unavailable: string[] = [];
  const excludedPlaceholders: string[] = [];

  for (const skillName of requestedNames) {
    // 1. Check user's own skill directory if provided
    if (options.userSkillsDir) {
      const userSkillMd = path.join(options.userSkillsDir, skillName, "SKILL.md");
      if (fs.existsSync(userSkillMd)) {
        const fm = parseSkillFrontmatter(userSkillMd);
        resolved.push({
          name: skillName,
          sourcePath: path.dirname(userSkillMd),
          origin: "user",
          description: fm.description ?? skillName,
        });
        continue;
      }
    }

    // 2. Check vendored skill directory + integrity
    const meta = registry.skills[skillName];
    const vendorDir = path.join(pkgRoot, "skills-vendor", skillName);
    const vendorSkillMd = path.join(vendorDir, "SKILL.md");
    if (meta && fs.existsSync(vendorSkillMd)) {
      const buf = fs.readFileSync(vendorSkillMd);
      const actualIntegrity = `sha256-${crypto.createHash("sha256").update(buf).digest("hex")}`;
      if (actualIntegrity === meta.integrity) {
        const fm = parseSkillFrontmatter(vendorSkillMd);
        resolved.push({
          name: skillName,
          sourcePath: vendorDir,
          origin: "vendored",
          description: fm.description ?? skillName,
        });
        continue;
      }
    }

    // 3. Otherwise mark unavailable (graceful degradation per §4 item 4c)
    unavailable.push(skillName);
  }

  // 4. Check custom skill placeholder
  const customDir = path.join(pkgRoot, "agents", "skills", roleCfg.custom);
  const customMd = path.join(customDir, "SKILL.md");
  if (fs.existsSync(customMd)) {
    const fm = parseSkillFrontmatter(customMd);
    if (fm.isPlaceholder) {
      excludedPlaceholders.push(roleCfg.custom);
    } else {
      resolved.push({
        name: roleCfg.custom,
        sourcePath: customDir,
        origin: "custom",
        description: fm.description ?? roleCfg.custom,
      });
    }
  }

  return {
    role: options.role,
    resolved,
    unavailable,
    excludedPlaceholders,
  };
}

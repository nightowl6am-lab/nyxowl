import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineTool } from "../../tool.ts";

export interface RoleSkillConfig {
  always: string[];
  when: Array<{ dna: string; skills: string[] }>;
  custom: string;
}

const DEFAULT_ROLE_SKILLS: Record<string, RoleSkillConfig> = {
  nyxowl: {
    always: ["git-authoring", "technical-documentation", "handling-untrusted-content"],
    when: [],
    custom: "nyx-orchestrator",
  },
  "nyx-product": {
    always: ["domain-modeling", "handling-untrusted-content", "technical-documentation"],
    when: [],
    custom: "nyx-product-strategy",
  },
  "nyx-architect": {
    always: ["codebase-design", "domain-modeling"],
    when: [],
    custom: "nyx-architecture",
  },
  "nyx-designer": {
    always: ["frontend-ui-engineering", "web-design-guidelines"],
    when: [],
    custom: "nyx-design-system",
  },
  "nyx-db": {
    always: ["database-migrations"],
    when: [
      {
        dna: "postgres",
        skills: ["supabase-postgres-best-practices", "postgres-rls-audit"],
      },
      {
        dna: "supabase",
        skills: ["supabase-postgres-best-practices", "postgres-rls-audit", "supabase"],
      },
    ],
    custom: "nyx-database",
  },
  "nyx-api": {
    always: [],
    when: [
      { dna: "fastify", skills: ["fastify-best-practices"] },
      { dna: "supabase", skills: ["supabase"] },
      { dna: "upstash", skills: ["upstash-redis-js", "upstash-ratelimit-js"] },
    ],
    custom: "nyx-backend",
  },
  "nyx-ui": {
    always: ["frontend-ui-engineering"],
    when: [{ dna: "supabase", skills: ["supabase"] }],
    custom: "nyx-frontend",
  },
  "nyx-sec": {
    always: ["security", "handling-untrusted-content"],
    when: [{ dna: "postgres", skills: ["postgres-rls-audit"] }],
    custom: "nyx-cybersecurity",
  },
  "nyx-probe": {
    always: ["web-design-guidelines"],
    when: [{ dna: "playwright", skills: ["playwright-behavior"] }],
    custom: "nyx-qa-probe",
  },
  "nyx-devops": {
    always: ["git-authoring", "database-migrations"],
    when: [],
    custom: "nyx-devops",
  },
  "nyx-testwriter": {
    always: ["security", "handling-untrusted-content"],
    when: [],
    custom: "nyx-testwriter",
  },
};

function resolveRepoPackageRoot(): string {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    // Walk up until we find package.json
    let cur = thisDir;
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(cur, "package.json"))) {
        return cur;
      }
      cur = path.dirname(cur);
    }
  } catch {
    // Fallback
  }
  return process.cwd();
}

export function resolveSkillsForRole(
  targetRole: string,
  dnaTags: Set<string>,
): {
  boundSkills: string[];
  unavailableSkills: string[];
  customSkill: { name: string; status: "placeholder" | "active" };
} {
  const pkgRoot = resolveRepoPackageRoot();
  const registryPath = path.join(pkgRoot, "agents", "skills", "registry.json");

  let roleCfg: RoleSkillConfig | undefined = DEFAULT_ROLE_SKILLS[targetRole];
  if (fs.existsSync(registryPath)) {
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
        roles?: Record<string, RoleSkillConfig>;
      };
      if (reg.roles && reg.roles[targetRole]) {
        roleCfg = reg.roles[targetRole];
      }
    } catch {
      // Use fallback
    }
  }

  if (!roleCfg) {
    return {
      boundSkills: [],
      unavailableSkills: [],
      customSkill: { name: "unknown", status: "placeholder" },
    };
  }

  const requested = new Set<string>(roleCfg.always);
  for (const cond of roleCfg.when) {
    if (dnaTags.has(cond.dna.toLowerCase())) {
      for (const s of cond.skills) {
        requested.add(s);
      }
    }
  }

  const boundSkills: string[] = [];
  const unavailableSkills: string[] = [];
  for (const skillName of requested) {
    const vendorSkillMd = path.join(pkgRoot, "skills-vendor", skillName, "SKILL.md");
    if (fs.existsSync(vendorSkillMd)) {
      boundSkills.push(skillName);
    } else {
      // Even if not yet vendored on disk, list in boundSkills if known in DEFAULT_ROLE_SKILLS, or check vendor
      boundSkills.push(skillName);
    }
  }

  // Check custom skill placeholder status
  const customSkillPath = path.join(pkgRoot, "agents", "skills", roleCfg.custom, "SKILL.md");
  let customStatus: "placeholder" | "active" = "placeholder";
  if (fs.existsSync(customSkillPath)) {
    const raw = fs.readFileSync(customSkillPath, "utf8");
    if (!raw.includes("status: placeholder")) {
      customStatus = "active";
    }
  }

  return {
    boundSkills,
    unavailableSkills,
    customSkill: { name: roleCfg.custom, status: customStatus },
  };
}

export const taskDispatchInputSchema = z.object({
  targetRole: z.enum([
    "nyx-product",
    "nyx-architect",
    "nyx-designer",
    "nyx-db",
    "nyx-api",
    "nyx-ui",
    "nyx-sec",
    "nyx-probe",
    "nyx-devops",
    "nyx-testwriter",
  ]),
  taskSummary: z.string().min(1).max(500),
  filePathsToLock: z.array(z.string()).optional(),
  repoPath: z.string().optional(),
});

export const taskDispatchOutputSchema = z.object({
  targetRole: z.string(),
  taskSummary: z.string(),
  boundSkills: z.array(z.string()),
  unavailableSkills: z.array(z.string()),
  customSkill: z.object({
    name: z.string(),
    status: z.enum(["placeholder", "active"]),
  }),
  promotedBlackboardKeys: z.array(z.string()),
  lockPlan: z.object({
    requiresLock: z.boolean(),
    suggestedPaths: z.array(z.string()),
  }),
  budgets: z.object({
    subagentSummaryTokens: z.number().int(),
    maxToolOutputTokens: z.number().int(),
  }),
  outputContract: z.literal("subagent-summary-v1"),
});

export const nyxTaskDispatchTool = defineTool({
  name: "nyx_task_dispatch",
  description: "Resolves DNA-conditional skills, promoted Blackboard keys, lock plan, and budgets for a subagent.",
  annotations: {
    title: "Dispatch Task to Subagent",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: taskDispatchInputSchema,
  outputSchema: taskDispatchOutputSchema,
  handler: async (input, ctx) => {
    const dnaTags = new Set<string>();
    const dnaRow = ctx.db.db
      .prepare("SELECT dna_json FROM dna WHERE repo_id = ?")
      .get(ctx.repoId) as { dna_json: string } | undefined;

    if (dnaRow) {
      try {
        const dnaObj = JSON.parse(dnaRow.dna_json) as {
          frameworks?: string[];
          orm?: string | null;
          database?: string | null;
          tags?: string[];
        };
        for (const f of dnaObj.frameworks ?? []) dnaTags.add(f.toLowerCase());
        if (dnaObj.orm) dnaTags.add(dnaObj.orm.toLowerCase());
        if (dnaObj.database) dnaTags.add(dnaObj.database.toLowerCase());
        for (const t of dnaObj.tags ?? []) dnaTags.add(t.toLowerCase());
      } catch {
        // Ignore parse error
      }
    }

    const { boundSkills, unavailableSkills, customSkill } = resolveSkillsForRole(
      input.targetRole,
      dnaTags,
    );

    const promotedRows = ctx.db.db
      .prepare(
        "SELECT DISTINCT key FROM blackboard WHERE trust = 'promoted' ORDER BY id DESC LIMIT 20",
      )
      .all() as Array<{ key: string }>;

    const isWriter = ["nyx-db", "nyx-api", "nyx-ui", "nyx-designer", "nyx-devops"].includes(
      input.targetRole,
    );

    return {
      targetRole: input.targetRole,
      taskSummary: input.taskSummary,
      boundSkills,
      unavailableSkills,
      customSkill,
      promotedBlackboardKeys: promotedRows.map((r) => r.key),
      lockPlan: {
        requiresLock: isWriter,
        suggestedPaths: input.filePathsToLock ?? [],
      },
      budgets: {
        subagentSummaryTokens: ctx.config.budgets.subagentSummaryTokens,
        maxToolOutputTokens: ctx.config.budgets.maxToolOutputTokens,
      },
      outputContract: "subagent-summary-v1" as const,
    };
  },
});

import { z } from "zod";
import { defineTool } from "../../tool.ts";
import { agentSkillPath, loadAgentSkill } from "../../../cli/skills.ts";
import {
  CAPABILITY_FLAG_NAMES,
  getRoleCapabilities,
  type CapabilityFlag,
  type ToolCapability,
} from "../../../core/capabilities.ts";

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

const capabilityFlagShape = Object.fromEntries(
  CAPABILITY_FLAG_NAMES.map((flag) => [flag, z.boolean()]),
) as Record<CapabilityFlag, z.ZodBoolean>;

const dispatchCapabilitySchema = z.object({
  tool: z.string(),
  ...capabilityFlagShape,
  limitations: z.array(z.string()),
});

export const taskDispatchOutputSchema = z.object({
  targetRole: z.string(),
  taskSummary: z.string(),
  skillPath: z.string(),
  skillLoaded: z.boolean(),
  promotedBlackboardKeys: z.array(z.string()),
  lockPlan: z.object({
    requiresLock: z.boolean(),
    suggestedPaths: z.array(z.string()),
  }),
  budgets: z.object({
    subagentSummaryTokens: z.number().int(),
    maxToolOutputTokens: z.number().int(),
  }),
  /**
   * Declared capabilities for every tool this role may call. A missing flag is
   * unavailable: the orchestrator must not plan around an undeclared ability.
   */
  capabilities: z.array(dispatchCapabilitySchema),
  capabilityManifestVersion: z.literal(1),
  outputContract: z.literal("subagent-summary-v1"),
});

function flattenCapability(capability: ToolCapability): z.infer<typeof dispatchCapabilitySchema> {
  const flags = Object.fromEntries(
    CAPABILITY_FLAG_NAMES.map((flag) => [flag, capability[flag]]),
  ) as Record<CapabilityFlag, boolean>;
  return {
    tool: capability.tool,
    ...flags,
    limitations: [...capability.limitations],
  };
}

export const nyxTaskDispatchTool = defineTool({
  name: "nyx_task_dispatch",
  description:
    "Resolves the per-agent skill package, promoted Blackboard keys, lock plan, and budgets for a subagent.",
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
    const skillPath = agentSkillPath(input.targetRole);
    const skillLoaded = loadAgentSkill(input.targetRole) !== null;

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
      skillPath,
      skillLoaded,
      promotedBlackboardKeys: promotedRows.map((r) => r.key),
      lockPlan: {
        requiresLock: isWriter,
        suggestedPaths: input.filePathsToLock ?? [],
      },
      budgets: {
        subagentSummaryTokens: ctx.config.budgets.subagentSummaryTokens,
        maxToolOutputTokens: ctx.config.budgets.maxToolOutputTokens,
      },
      capabilities: getRoleCapabilities(input.targetRole).map(flattenCapability),
      capabilityManifestVersion: 1 as const,
      outputContract: "subagent-summary-v1" as const,
    };
  },
});

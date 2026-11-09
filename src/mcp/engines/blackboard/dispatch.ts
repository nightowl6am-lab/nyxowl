import { z } from "zod";
import { defineTool } from "../../tool.ts";
import { agentSkillPath, loadAgentSkill } from "../../../cli/skills.ts";

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
  outputContract: z.literal("subagent-summary-v1"),
});

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
      outputContract: "subagent-summary-v1" as const,
    };
  },
});

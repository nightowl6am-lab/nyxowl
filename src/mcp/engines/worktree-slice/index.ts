import type { ToolDefinition } from "../../tool.ts";
import { nyxWorktreePrTool } from "./pr-gate.ts";
import { nyxSliceCheckpointTool, nyxSliceRewindTool } from "./slices.ts";
import { nyxWorktreeManageTool, nyxWorktreeStartTool } from "./worktree.ts";

export {
  nyxWorktreeStartTool,
  nyxWorktreeManageTool,
  nyxSliceCheckpointTool,
  nyxSliceRewindTool,
  nyxWorktreePrTool,
};

export const worktreeSliceEngineTools: ToolDefinition[] = [
  nyxWorktreeStartTool,
  nyxWorktreeManageTool,
  nyxSliceCheckpointTool,
  nyxSliceRewindTool,
  nyxWorktreePrTool,
];

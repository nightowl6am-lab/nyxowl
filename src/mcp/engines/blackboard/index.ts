import type { ToolDefinition } from "../../tool.ts";
import { nyxBlackboardPublishTool, nyxBlackboardReadTool } from "./blackboard.ts";
import { nyxTaskDispatchTool } from "./dispatch.ts";
import { nyxLockAcquireTool, nyxLockReleaseTool } from "./locks.ts";

export {
  nyxBlackboardPublishTool,
  nyxBlackboardReadTool,
  nyxLockAcquireTool,
  nyxLockReleaseTool,
  nyxTaskDispatchTool,
};

export const blackboardEngineTools: ToolDefinition[] = [
  nyxBlackboardPublishTool,
  nyxBlackboardReadTool,
  nyxLockAcquireTool,
  nyxLockReleaseTool,
  nyxTaskDispatchTool,
];

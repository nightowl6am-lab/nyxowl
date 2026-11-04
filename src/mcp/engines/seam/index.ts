import type { ToolDefinition } from "../../tool.ts";
import { nyxDocsGroundTool } from "./docs-ground.ts";
import { nyxSeamCheckTool } from "./graph.ts";
import { nyxPkgVerifyTool } from "./pkg-verify.ts";

export { nyxSeamCheckTool, nyxPkgVerifyTool, nyxDocsGroundTool };

export const seamEngineTools: ToolDefinition[] = [
  nyxSeamCheckTool,
  nyxPkgVerifyTool,
  nyxDocsGroundTool,
];

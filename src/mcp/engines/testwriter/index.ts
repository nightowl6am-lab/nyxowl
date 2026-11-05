import type { ToolDefinition } from "../../tool.ts";
import {
  nyxTestwriterFinishTool,
  nyxTestwriterGateTool,
  nyxTestwriterJobTool,
  nyxTestwriterLintTool,
  nyxTestwriterPrepareTool,
  nyxTestwriterStatusTool,
  nyxTestwriterWriteTool,
} from "./tools.ts";

export {
  nyxTestwriterJobTool,
  nyxTestwriterWriteTool,
  nyxTestwriterLintTool,
  nyxTestwriterGateTool,
  nyxTestwriterFinishTool,
  nyxTestwriterStatusTool,
  nyxTestwriterPrepareTool,
};

export const testwriterEngineTools: ToolDefinition[] = [
  nyxTestwriterJobTool,
  nyxTestwriterWriteTool,
  nyxTestwriterLintTool,
  nyxTestwriterGateTool,
  nyxTestwriterFinishTool,
  nyxTestwriterStatusTool,
  nyxTestwriterPrepareTool,
];

import type { ToolDefinition } from "../../tool.ts";
import { nyxArtifactReadTool } from "./artifacts.ts";
import { nyxTaskHandoffTool } from "./handoff.ts";
import { nyxContextHydrateTool } from "./hydrate.ts";

export {
  nyxArtifactReadTool,
  nyxTaskHandoffTool,
  nyxContextHydrateTool,
};
export { buildHydrateDigest, classifyProjectFolder } from "./hydrate.ts";

export const contextEngineTools: ToolDefinition[] = [
  nyxContextHydrateTool,
  nyxTaskHandoffTool,
  nyxArtifactReadTool,
];

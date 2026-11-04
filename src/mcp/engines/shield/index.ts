import type { ToolDefinition } from "../../tool.ts";
import { nyxDepGuardTool, setDepGuardRegistryFetcher } from "./dep-guard.ts";
import { nyxEnvInspectTool } from "./env-inspect.ts";
import { nyxSanitizeUntrustedTool, sanitizeUntrustedContent } from "./sanitize.ts";
import { nyxWebFetchTool, setWebFetchTestHooks } from "./web-fetch.ts";

export {
  nyxEnvInspectTool,
  nyxSanitizeUntrustedTool,
  sanitizeUntrustedContent,
  nyxWebFetchTool,
  setWebFetchTestHooks,
  nyxDepGuardTool,
  setDepGuardRegistryFetcher,
};

export const shieldEngineTools: ToolDefinition[] = [
  nyxEnvInspectTool,
  nyxWebFetchTool,
  nyxSanitizeUntrustedTool,
  nyxDepGuardTool,
];

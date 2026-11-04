import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { computeRepoId } from "../core/git.ts";
import { createLogger } from "../core/logger.ts";
import { ensureProjectLayout } from "../core/paths.ts";
import { StateDb } from "./db/sqlite.ts";
import { blackboardEngineTools } from "./engines/blackboard/index.ts";
import { bootstrapNavigatorEngineTools } from "./engines/bootstrap-navigator/index.ts";
import { contextEngineTools } from "./engines/context/index.ts";
import {
  probeExploitEngineTools,
  reapOrphanProcs,
  stopAllRunningProcs,
} from "./engines/probe-exploit/index.ts";
import { seamEngineTools } from "./engines/seam/index.ts";
import { shieldEngineTools } from "./engines/shield/index.ts";
import { worktreeSliceEngineTools } from "./engines/worktree-slice/index.ts";
import {
  invokeToolDefinition,
  type ExecuteToolOptions,
  type ToolDefinition,
} from "./tool.ts";

const logger = createLogger("mcp-server");

export const ALL_NYX_TOOLS: ToolDefinition[] = [
  ...shieldEngineTools,
  ...bootstrapNavigatorEngineTools,
  ...seamEngineTools,
  ...worktreeSliceEngineTools,
  ...blackboardEngineTools,
  ...probeExploitEngineTools,
  ...contextEngineTools,
];

const TOOL_MAP = new Map<string, ToolDefinition>(
  ALL_NYX_TOOLS.map((t) => [t.name, t]),
);

function zodToCleanJsonSchema(schema: z.ZodTypeAny): {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
} {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = raw;
  return {
    type: "object",
    ...(rest as { properties?: Record<string, object>; required?: string[] }),
  };
}

export function createNyxMcpServer(options: ExecuteToolOptions = {}): Server {
  const server = new Server(
    {
      name: "nyxowl",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = ALL_NYX_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToCleanJsonSchema(t.inputSchema),
      outputSchema: zodToCleanJsonSchema(t.outputSchema),
      annotations: t.annotations,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = TOOL_MAP.get(toolName);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              code: "ERR_INVALID_INPUT",
              message: `Unknown Nyxowl tool "${toolName}"`,
            }),
          },
        ],
      };
    }

    const res = await invokeToolDefinition(tool, request.params.arguments ?? {}, options);
    return {
      content: res.content,
      ...(res.structuredContent ? { structuredContent: res.structuredContent } : {}),
      ...(res.isError ? { isError: true } : {}),
    };
  });

  return server;
}

export async function startStdioMcpServer(options: ExecuteToolOptions = {}): Promise<void> {
  const projectPath =
    options.defaultProjectPath ?? process.env["NYXOWL_PROJECT"] ?? process.cwd();
  const nyxHome = options.nyxHome ?? process.env["NYXOWL_HOME"];

  try {
    const repoId = await computeRepoId(projectPath);
    const layout = ensureProjectLayout(repoId, nyxHome);
    const db = new StateDb(layout.stateDbPath);
    reapOrphanProcs(db);
    db.close();
  } catch (err) {
    logger.warn("Startup proc reaper skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const cleanupProcs = async (): Promise<void> => {
    try {
      const repoId = await computeRepoId(projectPath);
      const layout = ensureProjectLayout(repoId, nyxHome);
      const db = new StateDb(layout.stateDbPath);
      stopAllRunningProcs(db);
      db.close();
    } catch {
      // Ignore shutdown error
    }
  };

  process.once("SIGINT", () => {
    void cleanupProcs().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void cleanupProcs().finally(() => process.exit(0));
  });

  const server = createNyxMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Nyxowl stdio MCP server started", { tools: ALL_NYX_TOOLS.length });
}

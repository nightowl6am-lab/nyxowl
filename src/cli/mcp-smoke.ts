import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NYXOWL_VERSION } from "../core/version.ts";
import { ALL_NYX_TOOLS, createNyxMcpServer } from "../mcp/server.ts";

export interface McpSmokeResult {
  ok: boolean;
  toolCount: number;
  message: string;
}

/**
 * Compares the live MCP `ListTools` names against the expected registry.
 *
 * Returns `null` only when both lists describe the same set and the listed
 * names contain no duplicates. Otherwise returns a concise reason naming the
 * missing, extra, and duplicate tools.
 */
export function compareToolLists(listed: string[], expected: string[]): string | null {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of listed) {
    if (seen.has(name)) {
      duplicates.add(name);
    } else {
      seen.add(name);
    }
  }

  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !seen.has(name));
  const extra = [...seen].filter((name) => !expectedSet.has(name));

  if (missing.length === 0 && extra.length === 0 && duplicates.size === 0) {
    return null;
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing: ${missing.sort().join(", ")}`);
  }
  if (extra.length > 0) {
    parts.push(`extra: ${extra.sort().join(", ")}`);
  }
  if (duplicates.size > 0) {
    parts.push(`duplicate: ${[...duplicates].sort().join(", ")}`);
  }
  return parts.join("; ");
}

/**
 * Performs a live MCP round-trip over an in-memory transport.
 *
 * The client and server are always closed in `finally`; any thrown error is
 * converted into a non-throwing `{ ok: false }` result so doctor can report it.
 */
export async function runMcpSmoke(): Promise<McpSmokeResult> {
  let client: Client | undefined;
  let server: ReturnType<typeof createNyxMcpServer> | undefined;

  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "nyxowl-doctor", version: NYXOWL_VERSION });
    server = createNyxMcpServer();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    const reason = compareToolLists(
      names,
      ALL_NYX_TOOLS.map((tool) => tool.name),
    );

    if (reason !== null) {
      return { ok: false, toolCount: names.length, message: reason };
    }

    return { ok: true, toolCount: names.length, message: `${names.length} tools listed` };
  } catch (err) {
    return {
      ok: false,
      toolCount: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // The server may already have closed the linked transport.
      }
    }
    if (server) {
      try {
        await server.close();
      } catch {
        // The transport may already be closed.
      }
    }
  }
}

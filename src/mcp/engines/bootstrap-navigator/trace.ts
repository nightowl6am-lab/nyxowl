import path from "node:path";
import { z } from "zod";
import { execCommand } from "../../../core/exec.ts";
import { defineTool } from "../../tool.ts";
import { resolveRipgrepBinary } from "./env-doctor.ts";

export interface SymbolTraceMatch {
  filePath: string;
  line: number;
  column: number;
  kind: "definition" | "import" | "call";
  snippet: string;
}

function classifySymbolOccurrence(lineText: string, symbolName: string): "definition" | "import" | "call" {
  const trimmed = lineText.trim();
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (
    new RegExp(`^(?:import\\b|from\\b.*\\bimport\\b|const\\s+.*=\\s*require\\()`).test(trimmed)
  ) {
    return "import";
  }

  const defRegex = new RegExp(
    `(?:\\b(?:function|class|interface|type|const|let|var|def|func|fn|struct|enum)\\s+${escaped}\\b|\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?\\()`,
  );
  if (defRegex.test(trimmed)) {
    return "definition";
  }

  return "call";
}

export const traceSymbolInputSchema = z.object({
  symbolName: z.string().min(1).max(120),
  repoPath: z.string().min(1),
});

export const traceSymbolOutputSchema = z.object({
  symbolName: z.string(),
  definitions: z.array(
    z.object({
      filePath: z.string(),
      line: z.number().int(),
      column: z.number().int(),
      snippet: z.string(),
    }),
  ),
  imports: z.array(
    z.object({
      filePath: z.string(),
      line: z.number().int(),
      column: z.number().int(),
      snippet: z.string(),
    }),
  ),
  callSites: z.array(
    z.object({
      filePath: z.string(),
      line: z.number().int(),
      column: z.number().int(),
      snippet: z.string(),
    }),
  ),
});

export const nyxTraceSymbolTool = defineTool({
  name: "nyx_trace_symbol",
  description: "Traces symbol definitions, imports, and call sites across the repository using ripgrep + AST classification.",
  annotations: {
    title: "Surgical Symbol Tracer",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: traceSymbolInputSchema,
  outputSchema: traceSymbolOutputSchema,
  handler: async (input) => {
    const absRepo = path.resolve(input.repoPath);
    const rgBin = resolveRipgrepBinary();

    const res = await execCommand(
      rgBin,
      [
        "--json",
        "-w",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/node_modules/**",
        "--glob",
        "!**/dist/**",
        "--glob",
        "!**/.nyxowl/**",
        input.symbolName,
        absRepo,
      ],
      { cwd: absRepo, timeoutMs: 20_000 },
    );

    const definitions: Array<{ filePath: string; line: number; column: number; snippet: string }> = [];
    const imports: Array<{ filePath: string; line: number; column: number; snippet: string }> = [];
    const callSites: Array<{ filePath: string; line: number; column: number; snippet: string }> = [];

    for (const rawLine of res.stdout.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      try {
        const msg = JSON.parse(rawLine) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
            submatches?: Array<{ start?: number }>;
          };
        };
        if (msg.type !== "match" || !msg.data) continue;
        const absFile = msg.data.path?.text ?? "";
        const relFile = path.relative(absRepo, absFile);
        const lineNum = msg.data.line_number ?? 1;
        const colNum = (msg.data.submatches?.[0]?.start ?? 0) + 1;
        const lineText = (msg.data.lines?.text ?? "").trim();

        // Ignore pure comments
        if (lineText.startsWith("//") || lineText.startsWith("#") || lineText.startsWith("*")) {
          continue;
        }

        const kind = classifySymbolOccurrence(lineText, input.symbolName);
        const item = {
          filePath: relFile,
          line: lineNum,
          column: colNum,
          snippet: lineText.slice(0, 140),
        };

        if (kind === "definition") definitions.push(item);
        else if (kind === "import") imports.push(item);
        else callSites.push(item);
      } catch {
        // Ignore non-JSON lines
      }
    }

    return {
      symbolName: input.symbolName,
      definitions: definitions.slice(0, 25),
      imports: imports.slice(0, 35),
      callSites: callSites.slice(0, 50),
    };
  },
});

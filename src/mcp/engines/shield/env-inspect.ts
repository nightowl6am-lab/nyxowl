import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isSecretEnvFileName, parseDotEnvEntries } from "../../../core/redact.ts";
import { defineTool } from "../../tool.ts";

export type EnvValueShape =
  | "EMPTY"
  | `URL(${string})`
  | "BOOLEAN"
  | "NUMBER"
  | "JSON"
  | "STRING(len: 1-16)"
  | "STRING(len: 17-64)"
  | "STRING(len: 65+)";

/**
 * Classifies a secret `.env` value into a coarse, value-free shape hint (§1.2.3).
 * Never emits any substring or raw content of the value.
 */
export function classifyEnvValueShape(rawValue: string): EnvValueShape {
  const val = rawValue.trim();
  if (val.length === 0) {
    return "EMPTY";
  }

  if (val === "true" || val === "false" || val === "TRUE" || val === "FALSE") {
    return "BOOLEAN";
  }

  if (/^-?\d+(?:\.\d+)?$/.test(val)) {
    return "NUMBER";
  }

  const urlSchemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(val);
  if (urlSchemeMatch && urlSchemeMatch[1]) {
    return `URL(${urlSchemeMatch[1].toLowerCase()})`;
  }

  if (
    (val.startsWith("{") && val.endsWith("}")) ||
    (val.startsWith("[") && val.endsWith("]"))
  ) {
    try {
      JSON.parse(val);
      return "JSON";
    } catch {
      // Fall through to string length bucket
    }
  }

  if (val.length <= 16) {
    return "STRING(len: 1-16)";
  }
  if (val.length <= 64) {
    return "STRING(len: 17-64)";
  }
  return "STRING(len: 65+)";
}

function scanCodeReferencedEnvKeys(rootDir: string): Set<string> {
  const keys = new Set<string>();
  const stack: string[] = [rootDir];
  const codeExt = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php)$/i;

  const patterns = [
    /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\bprocess\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g,
    /\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\bos\.environ(?:\.get)?\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /\bos\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /\bos\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /\bos\.Getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /\bstd::env::var\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
  ];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "coverage" ||
        entry.name === ".nyxowl"
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && codeExt.test(entry.name)) {
        try {
          const text = fs.readFileSync(fullPath, "utf8");
          for (const re of patterns) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
              if (m[1]) {
                keys.add(m[1]);
              }
            }
          }
        } catch {
          // Ignore unreadable file
        }
      }
    }
  }

  return keys;
}

export const envInspectInputSchema = z.object({
  worktreePath: z.string().min(1),
});

export const envInspectOutputSchema = z.object({
  envFilesFound: z.array(z.string()),
  exampleFilesFound: z.array(z.string()),
  keys: z.array(
    z.object({
      name: z.string(),
      presence: z.enum(["SET", "EMPTY"]),
      shape: z.string(),
    }),
  ),
  drift: z.object({
    missingFromEnvButInExample: z.array(z.string()),
    missingFromEnvButReferencedInCode: z.array(z.string()),
    undocumentedInExample: z.array(z.string()),
  }),
});

export const nyxEnvInspectTool = defineTool({
  name: "nyx_env_inspect",
  description: "Inspects .env* key names, SET/EMPTY presence, value shapes, and drift without exposing values.",
  annotations: {
    title: "Safe .env Key-Shape Inspector",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: envInspectInputSchema,
  outputSchema: envInspectOutputSchema,
  handler: async (input) => {
    const absWt = path.resolve(input.worktreePath);
    const envFilesFound: string[] = [];
    const exampleFilesFound: string[] = [];
    const envMap = new Map<string, string>();
    const exampleKeys = new Set<string>();

    if (fs.existsSync(absWt)) {
      const entries = fs.readdirSync(absWt, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const fullPath = path.join(absWt, entry.name);
        if (isSecretEnvFileName(entry.name)) {
          envFilesFound.push(entry.name);
          const content = fs.readFileSync(fullPath, "utf8");
          for (const kv of parseDotEnvEntries(content)) {
            envMap.set(kv.key, kv.value);
          }
        } else if (
          entry.name === ".env.example" ||
          entry.name === ".env.sample" ||
          entry.name === ".env.template" ||
          entry.name === ".env.defaults"
        ) {
          exampleFilesFound.push(entry.name);
          const content = fs.readFileSync(fullPath, "utf8");
          for (const kv of parseDotEnvEntries(content)) {
            exampleKeys.add(kv.key);
          }
        }
      }
    }

    const keys = [...envMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, val]) => {
        const shape = classifyEnvValueShape(val);
        return {
          name,
          presence: (val.trim().length > 0 ? "SET" : "EMPTY") as "SET" | "EMPTY",
          shape,
        };
      });

    const codeKeys = scanCodeReferencedEnvKeys(absWt);
    const builtinNodeEnvKeys = new Set(["NODE_ENV", "PORT", "HOST", "CI", "PATH", "HOME", "TZ"]);

    const missingFromEnvButInExample = [...exampleKeys]
      .filter((k) => !envMap.has(k) || envMap.get(k)?.trim() === "")
      .sort();

    const missingFromEnvButReferencedInCode = [...codeKeys]
      .filter(
        (k) =>
          !builtinNodeEnvKeys.has(k) &&
          (!envMap.has(k) || envMap.get(k)?.trim() === ""),
      )
      .sort();

    const undocumentedInExample =
      exampleFilesFound.length > 0
        ? [...envMap.keys()].filter((k) => !exampleKeys.has(k)).sort()
        : [];

    return {
      envFilesFound: envFilesFound.sort(),
      exampleFilesFound: exampleFilesFound.sort(),
      keys,
      drift: {
        missingFromEnvButInExample,
        missingFromEnvButReferencedInCode,
        undocumentedInExample,
      },
    };
  },
});

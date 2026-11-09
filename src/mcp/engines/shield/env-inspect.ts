import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { isSecretEnvFileName, parseDotEnvEntries } from "../../../core/redact.ts";
import { runSafeCommand, scanEnvTree } from "../../../core/safe-runner.ts";
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

const EXAMPLE_ENV_FILE_NAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
]);

const BUILTIN_NODE_ENV_KEYS = new Set([
  "NODE_ENV",
  "PORT",
  "HOST",
  "CI",
  "PATH",
  "HOME",
  "TZ",
]);

/**
 * Roles allowed to execute a command through the safe runner. The runner
 * executes a local process, so it is restricted to the roles whose host policy
 * already permits shell execution (roles with `bash: deny` are excluded).
 */
const RUNNER_ALLOWED_ROLES = new Set(["nyxowl", "nyx-devops", "nyx-db", "nyx-api"]);

/**
 * Resolves the role the runner gate must use.
 *
 * `ctx.callerRole` is derived from the tool arguments first, so it can be
 * influenced by the caller. When the server declares the active role through
 * `NYXOWL_ROLE`, that server-side value wins and is used for the gate.
 */
function resolveRunnerRole(ctx: { callerRole: string }): string {
  const declared = process.env["NYXOWL_ROLE"];
  return declared !== undefined && declared.trim().length > 0
    ? declared.trim()
    : ctx.callerRole;
}

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

/**
 * Maps every source file to the closest enclosing package directory so that a
 * referenced key is attributed to the package that actually reads it.
 */
function scanCodeReferencedEnvKeysByPackage(
  rootDir: string,
  packageDirs: string[],
): Map<string, Set<string>> {
  const byPackage = new Map<string, Set<string>>();
  for (const pkg of packageDirs) {
    byPackage.set(pkg, new Set<string>());
  }

  const packageAbs = new Set<string>(
    packageDirs.map((pkg) => path.resolve(rootDir, pkg === "." ? "" : pkg)),
  );

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

  const stack: string[] = [rootDir];
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
        continue;
      }
      if (!entry.isFile() || !codeExt.test(entry.name)) {
        continue;
      }

      let owner: string | null = null;
      let cursor = path.dirname(fullPath);
      for (;;) {
        if (packageAbs.has(cursor)) {
          owner = path.relative(rootDir, cursor).split(path.sep).join("/") || ".";
          break;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          break;
        }
        cursor = parent;
      }
      if (!owner) {
        continue;
      }

      let text: string;
      try {
        text = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }
      const bucket = byPackage.get(owner);
      if (!bucket) {
        continue;
      }
      for (const re of patterns) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m[1]) {
            bucket.add(m[1]);
          }
        }
      }
    }
  }

  return byPackage;
}

export interface PackageEnvReport {
  /** Package directory relative to the worktree root; "." is the root package. */
  packagePath: string;
  /** Names of the secret env files present in the package (names only). */
  envFiles: string[];
  /** Names of the env files that are symlinks into the main checkout. */
  linkedEnvFiles: string[];
  /** Names of the example/template env files present in the package. */
  exampleFiles: string[];
  /** Referenced keys that are absent from the package env files (names only). */
  missingKeys: string[];
}

function listPackageEnvFiles(pkgAbs: string): {
  envFiles: string[];
  linkedEnvFiles: string[];
  exampleFiles: string[];
  definedKeys: Set<string>;
  exampleKeys: Set<string>;
  envFilePaths: string[];
} {
  const envFiles: string[] = [];
  const linkedEnvFiles: string[] = [];
  const exampleFiles: string[] = [];
  const definedKeys = new Set<string>();
  const exampleKeys = new Set<string>();
  const envFilePaths: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pkgAbs, { withFileTypes: true });
  } catch {
    return {
      envFiles,
      linkedEnvFiles,
      exampleFiles,
      definedKeys,
      exampleKeys,
      envFilePaths,
    };
  }

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(pkgAbs, entry.name);
    if (EXAMPLE_ENV_FILE_NAMES.has(entry.name)) {
      exampleFiles.push(entry.name);
      try {
        for (const kv of parseDotEnvEntries(fs.readFileSync(fullPath, "utf8"))) {
          exampleKeys.add(kv.key);
        }
      } catch {
        // Ignore unreadable example file
      }
      continue;
    }
    if (!isSecretEnvFileName(entry.name)) {
      continue;
    }
    envFiles.push(entry.name);
    envFilePaths.push(fullPath);
    let isLink = false;
    try {
      isLink = fs.lstatSync(fullPath).isSymbolicLink();
    } catch {
      isLink = false;
    }
    if (isLink) {
      linkedEnvFiles.push(entry.name);
    }
    try {
      for (const kv of parseDotEnvEntries(fs.readFileSync(fullPath, "utf8"))) {
        // Only key names are retained; an empty value counts as undefined, which
        // matches the root-level drift semantics.
        if (kv.value.trim().length > 0) {
          definedKeys.add(kv.key);
        }
      }
    } catch {
      // Ignore unreadable env file
    }
  }

  envFiles.sort();
  linkedEnvFiles.sort();
  exampleFiles.sort();
  return {
    envFiles,
    linkedEnvFiles,
    exampleFiles,
    definedKeys,
    exampleKeys,
    envFilePaths,
  };
}

export const envInspectInputSchema = z.object({
  worktreePath: z.string().min(1),
  run: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
      readinessUrl: z.string().url().optional(),
    })
    .optional(),
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
  packages: z.array(
    z.object({
      packagePath: z.string(),
      envFiles: z.array(z.string()),
      linkedEnvFiles: z.array(z.string()),
      exampleFiles: z.array(z.string()),
      missingKeys: z.array(z.string()),
    }),
  ),
  run: z
    .object({
      exitCode: z.number().nullable(),
      signal: z.string().nullable(),
      timedOut: z.boolean(),
      ready: z.boolean(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: z.number(),
      truncated: z.boolean(),
    })
    .optional(),
});

export const nyxEnvInspectTool = defineTool({
  name: "nyx_env_inspect",
  description:
    "Inspects .env* key names, SET/EMPTY presence, value shapes, per-package env drift, and optionally runs a redacted local command.",
  annotations: {
    title: "Safe .env Key-Shape Inspector",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: envInspectInputSchema,
  outputSchema: envInspectOutputSchema,
  handler: async (input, ctx) => {
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
        } else if (EXAMPLE_ENV_FILE_NAMES.has(entry.name)) {
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

    const missingFromEnvButInExample = [...exampleKeys]
      .filter((k) => !envMap.has(k) || envMap.get(k)?.trim() === "")
      .sort();

    const missingFromEnvButReferencedInCode = [...codeKeys]
      .filter(
        (k) =>
          !BUILTIN_NODE_ENV_KEYS.has(k) &&
          (!envMap.has(k) || envMap.get(k)?.trim() === ""),
      )
      .sort();

    const undocumentedInExample =
      exampleFilesFound.length > 0
        ? [...envMap.keys()].filter((k) => !exampleKeys.has(k)).sort()
        : [];

    // Per-package env report (names only, never values or file contents).
    const tree = fs.existsSync(absWt)
      ? scanEnvTree(absWt)
      : { packageDirectories: [], envFiles: [] };
    const packageCodeKeys = scanCodeReferencedEnvKeysByPackage(
      absWt,
      tree.packageDirectories,
    );
    const packages: PackageEnvReport[] = [];
    const runnerEnvFiles: string[] = [];
    const rootListing =
      tree.packageDirectories.includes(".")
        ? listPackageEnvFiles(absWt)
        : {
            envFiles: [],
            linkedEnvFiles: [],
            exampleFiles: [],
            definedKeys: new Set<string>(),
            exampleKeys: new Set<string>(),
            envFilePaths: [],
          };
    for (const pkgDir of tree.packageDirectories) {
      const pkgAbs = path.join(absWt, pkgDir === "." ? "" : pkgDir);
      const listing = pkgDir === "." ? rootListing : listPackageEnvFiles(pkgAbs);
      const referenced = new Set<string>([
        ...listing.exampleKeys,
        ...(packageCodeKeys.get(pkgDir) ?? []),
      ]);
      const missingKeys = [...referenced]
        .filter(
          (k) =>
            !BUILTIN_NODE_ENV_KEYS.has(k) &&
            !listing.definedKeys.has(k) &&
            !rootListing.definedKeys.has(k),
        )
        .sort();
      packages.push({
        packagePath: pkgDir,
        envFiles: listing.envFiles,
        linkedEnvFiles: listing.linkedEnvFiles,
        exampleFiles: listing.exampleFiles,
        missingKeys,
      });
      for (const envPath of listing.envFilePaths) {
        if (!runnerEnvFiles.includes(envPath)) {
          runnerEnvFiles.push(envPath);
        }
      }
    }

    let runResult:
      | {
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          ready: boolean;
          stdout: string;
          stderr: string;
          durationMs: number;
          truncated: boolean;
        }
      | undefined;

    if (input.run) {
      const runnerRole = resolveRunnerRole(ctx);
      if (!RUNNER_ALLOWED_ROLES.has(runnerRole)) {
        throw new NyxError(
          "ERR_REDLINE_BLOCKED",
          `Role "${runnerRole}" may not run commands through nyx_env_inspect`,
        );
      }
      const result = await runSafeCommand({
        command: input.run.command,
        ...(input.run.args ? { args: input.run.args } : {}),
        cwd: absWt,
        envFiles: runnerEnvFiles,
        ...(input.run.timeoutMs ? { timeoutMs: input.run.timeoutMs } : {}),
        ...(input.run.readinessUrl ? { readinessUrl: input.run.readinessUrl } : {}),
      });
      runResult = {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        ready: result.ready,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        truncated: result.truncated,
      };
    }

    return {
      envFilesFound: envFilesFound.sort(),
      exampleFilesFound: exampleFilesFound.sort(),
      keys,
      drift: {
        missingFromEnvButInExample,
        missingFromEnvButReferencedInCode,
        undocumentedInExample,
      },
      packages,
      ...(runResult ? { run: runResult } : {}),
    };
  },
});

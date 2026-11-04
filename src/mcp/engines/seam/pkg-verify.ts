import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "../../../core/exec.ts";
import { defineTool } from "../../tool.ts";

function checkNpmExportsInDir(pkgDir: string, symbols: string[]): {
  verifiedSymbols: string[];
  missingSymbols: string[];
} {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  const candidateFiles = new Set<string>();

  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        types?: string;
        typings?: string;
        main?: string;
        module?: string;
        exports?: unknown;
      };
      for (const f of [pkg.types, pkg.typings, pkg.main, pkg.module]) {
        if (typeof f === "string") candidateFiles.add(path.join(pkgDir, f));
      }
      const collectExportStrings = (val: unknown): void => {
        if (typeof val === "string") {
          candidateFiles.add(path.join(pkgDir, val));
        } else if (val && typeof val === "object") {
          for (const v of Object.values(val as Record<string, unknown>)) {
            collectExportStrings(v);
          }
        }
      };
      collectExportStrings(pkg.exports);
    } catch {
      // Ignore
    }
  }

  for (const fallback of ["index.d.ts", "index.js", "index.mjs", "dist/index.d.ts", "dist/index.js"]) {
    candidateFiles.add(path.join(pkgDir, fallback));
  }

  // Also walk 2 levels deep for .d.ts / .js files
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || !fs.existsSync(dir)) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules") {
          walk(full, depth + 1);
        } else if (entry.isFile() && /\.(?:d\.ts|d\.mts|js|mjs|cjs)$/.test(entry.name)) {
          candidateFiles.add(full);
        }
      }
    } catch {
      // Ignore
    }
  };
  walk(pkgDir, 0);

  let combinedSource = "";
  for (const file of candidateFiles) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      try {
        combinedSource += "\n" + fs.readFileSync(file, "utf8");
      } catch {
        // Ignore
      }
    }
  }

  const verifiedSymbols: string[] = [];
  const missingSymbols: string[] = [];

  for (const sym of symbols) {
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const symRegex = new RegExp(`\\b${escaped}\\b`);
    if (symRegex.test(combinedSource)) {
      verifiedSymbols.push(sym);
    } else {
      missingSymbols.push(sym);
    }
  }

  return { verifiedSymbols, missingSymbols };
}

export const pkgVerifyInputSchema = z.object({
  packageName: z.string().min(1),
  importedSymbols: z.array(z.string().min(1)),
  worktreePath: z.string().min(1),
});

export const pkgVerifyOutputSchema = z.object({
  packageName: z.string(),
  installed: z.boolean(),
  installedVersion: z.string().nullable(),
  verified: z.boolean(),
  verifiedSymbols: z.array(z.string()),
  missingSymbols: z.array(z.string()),
});

export const nyxPkgVerifyTool = defineTool({
  name: "nyx_pkg_verify",
  description: "Verifies that an installed package and all imported symbols actually exist in local artifacts/types.",
  annotations: {
    title: "Local Package & Symbol Grounding",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: pkgVerifyInputSchema,
  outputSchema: pkgVerifyOutputSchema,
  handler: async (input) => {
    const absWt = path.resolve(input.worktreePath);

    // 1. Check Node/npm node_modules
    const nmPkgDir = path.join(absWt, "node_modules", input.packageName);
    if (fs.existsSync(nmPkgDir)) {
      const pkgJsonPath = path.join(nmPkgDir, "package.json");
      let installedVersion: string | null = null;
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { version?: string };
          installedVersion = pkg.version ?? null;
        } catch {
          // Ignore
        }
      }
      const { verifiedSymbols, missingSymbols } = checkNpmExportsInDir(
        nmPkgDir,
        input.importedSymbols,
      );
      return {
        packageName: input.packageName,
        installed: true,
        installedVersion,
        verified: missingSymbols.length === 0,
        verifiedSymbols,
        missingSymbols,
      };
    }

    // 2. Check Python via python3 -c introspection if pyproject.toml / requirements.txt exists
    if (
      fs.existsSync(path.join(absWt, "pyproject.toml")) ||
      fs.existsSync(path.join(absWt, "requirements.txt"))
    ) {
      const pyScript = `
import importlib, json, sys
pkg = sys.argv[1]
syms = json.loads(sys.argv[2])
try:
    mod = importlib.import_module(pkg.replace("-", "_"))
    ver = getattr(mod, "__version__", "installed")
    verified = [s for s in syms if hasattr(mod, s)]
    missing = [s for s in syms if not hasattr(mod, s)]
    print(json.dumps({"installed": True, "version": ver, "verified": verified, "missing": missing}))
except Exception:
    print(json.dumps({"installed": False, "version": None, "verified": [], "missing": syms}))
`;
      const pyRes = await execCommand(
        "python3",
        ["-c", pyScript, input.packageName, JSON.stringify(input.importedSymbols)],
        { cwd: absWt, timeoutMs: 10_000 },
      );
      if (pyRes.exitCode === 0 && pyRes.stdout.trim()) {
        try {
          const parsed = JSON.parse(pyRes.stdout.trim()) as {
            installed: boolean;
            version: string | null;
            verified: string[];
            missing: string[];
          };
          return {
            packageName: input.packageName,
            installed: parsed.installed,
            installedVersion: parsed.version,
            verified: parsed.installed && parsed.missing.length === 0,
            verifiedSymbols: parsed.verified,
            missingSymbols: parsed.missing,
          };
        } catch {
          // Fall through
        }
      }
    }

    // 3. Check Go via go doc
    if (fs.existsSync(path.join(absWt, "go.mod"))) {
      const verifiedSymbols: string[] = [];
      const missingSymbols: string[] = [];
      for (const sym of input.importedSymbols) {
        const goRes = await execCommand("go", ["doc", `${input.packageName}.${sym}`], {
          cwd: absWt,
          timeoutMs: 10_000,
        });
        if (goRes.exitCode === 0) verifiedSymbols.push(sym);
        else missingSymbols.push(sym);
      }
      return {
        packageName: input.packageName,
        installed: verifiedSymbols.length > 0,
        installedVersion: verifiedSymbols.length > 0 ? "go.mod" : null,
        verified: verifiedSymbols.length > 0 && missingSymbols.length === 0,
        verifiedSymbols,
        missingSymbols,
      };
    }

    return {
      packageName: input.packageName,
      installed: false,
      installedVersion: null,
      verified: false,
      verifiedSymbols: [],
      missingSymbols: input.importedSymbols,
    };
  },
});

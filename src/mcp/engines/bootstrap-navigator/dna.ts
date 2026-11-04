import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../tool.ts";

export interface ProjectDna {
  repoId: string;
  manifestHash: string;
  primaryStack: string;
  languages: string[];
  packageManager: string | null;
  workspaces: string[];
  commands: {
    typecheck: string | null;
    lint: string | null;
    test: string | null;
    build: string | null;
  };
  orm: string | null;
  migrationsDir: string | null;
  database: string | null;
  httpFramework: string | null;
  uiFramework: string | null;
  httpSurface: boolean;
  isCli: boolean;
  isLibrary: boolean;
  tags: string[];
  exemplars: Array<{
    filePath: string;
    lineRange: string;
    reason: string;
  }>;
}

const MANIFEST_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
  "prisma/schema.prisma",
];

export function computeManifestHash(repoPath: string): string {
  const hash = crypto.createHash("sha256");
  for (const rel of MANIFEST_FILES) {
    const full = path.join(repoPath, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      hash.update(rel);
      hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest("hex");
}

function findExemplarFiles(repoPath: string): Array<{
  filePath: string;
  lineRange: string;
  reason: string;
}> {
  const exemplars: Array<{ filePath: string; lineRange: string; reason: string }> = [];
  const candidateDirs = ["src", "app", "lib", "internal", "cmd", "."];
  const extRe = /\.(?:ts|tsx|py|go|rs|rb|php|java|kt|cs|ex)$/i;

  for (const dir of candidateDirs) {
    const absDir = path.join(repoPath, dir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) continue;

    const stack = [absDir];
    while (stack.length > 0 && exemplars.length < 3) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (
          e.name === ".git" ||
          e.name === "node_modules" ||
          e.name === "dist" ||
          e.name === ".nyxowl"
        ) {
          continue;
        }
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile() && extRe.test(e.name)) {
          const rel = path.relative(repoPath, full);
          if (exemplars.some((ex) => ex.filePath === rel)) continue;
          const lines = fs.readFileSync(full, "utf8").split(/\r?\n/).length;
          const endLine = Math.min(lines, 50);
          exemplars.push({
            filePath: rel,
            lineRange: `L1-L${Math.max(1, endLine)}`,
            reason: "Primary source module exemplar",
          });
          if (exemplars.length >= 3) break;
        }
      }
    }
    if (exemplars.length >= 3) break;
  }

  return exemplars;
}

export function extractProjectDna(repoPath: string, repoId: string): ProjectDna {
  const absRepo = path.resolve(repoPath);
  const manifestHash = computeManifestHash(absRepo);
  const languages = new Set<string>();
  const tags = new Set<string>();
  const workspaces: string[] = [];

  let primaryStack = "unknown";
  let packageManager: string | null = null;
  let orm: string | null = null;
  let migrationsDir: string | null = null;
  let database: string | null = null;
  let httpFramework: string | null = null;
  let uiFramework: string | null = null;
  let httpSurface = false;
  let isCli = false;
  let isLibrary = false;

  const commands: {
    typecheck: string | null;
    lint: string | null;
    test: string | null;
    build: string | null;
  } = {
    typecheck: null,
    lint: null,
    test: null,
    build: null,
  };

  // 1. Check Node / TypeScript / JavaScript
  const pkgJsonPath = path.join(absRepo, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        workspaces?: string[] | { packages?: string[] };
        bin?: unknown;
        main?: string;
        exports?: unknown;
      };
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const scripts = pkg.scripts ?? {};

      const hasTs =
        "typescript" in allDeps || fs.existsSync(path.join(absRepo, "tsconfig.json"));
      if (hasTs) {
        languages.add("typescript");
        tags.add("typescript");
        primaryStack = "typescript-node";
      } else {
        languages.add("javascript");
        tags.add("javascript");
        primaryStack = "javascript-node";
      }

      if (fs.existsSync(path.join(absRepo, "pnpm-lock.yaml"))) packageManager = "pnpm";
      else if (fs.existsSync(path.join(absRepo, "bun.lockb")) || fs.existsSync(path.join(absRepo, "bun.lock"))) packageManager = "bun";
      else if (fs.existsSync(path.join(absRepo, "yarn.lock"))) packageManager = "yarn";
      else packageManager = "npm";

      const runPrefix = packageManager === "pnpm" ? "pnpm run" : packageManager === "bun" ? "bun run" : "npm run";
      if (scripts["typecheck"]) commands.typecheck = `${runPrefix} typecheck`;
      if (scripts["lint"]) commands.lint = `${runPrefix} lint`;
      if (scripts["test"]) commands.test = `${runPrefix} test`;
      if (scripts["build"]) commands.build = `${runPrefix} build`;

      if (Array.isArray(pkg.workspaces)) {
        workspaces.push(...pkg.workspaces);
      } else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
        workspaces.push(...pkg.workspaces.packages);
      }

      if (pkg.bin) isCli = true;
      if (pkg.exports || pkg.main) isLibrary = true;

      // ORM & DB detection
      if ("prisma" in allDeps || "@prisma/client" in allDeps || fs.existsSync(path.join(absRepo, "prisma/schema.prisma"))) {
        orm = "prisma";
        tags.add("prisma");
        if (fs.existsSync(path.join(absRepo, "prisma/migrations"))) {
          migrationsDir = "prisma/migrations";
        }
        const prismaPath = path.join(absRepo, "prisma/schema.prisma");
        if (fs.existsSync(prismaPath)) {
          const schemaText = fs.readFileSync(prismaPath, "utf8");
          if (/provider\s*=\s*"postgresql"/i.test(schemaText)) {
            database = "postgres";
            tags.add("postgres");
          }
        }
      } else if ("drizzle-orm" in allDeps) {
        orm = "drizzle";
        tags.add("drizzle");
        if (fs.existsSync(path.join(absRepo, "drizzle"))) {
          migrationsDir = "drizzle";
        }
      }

      if ("@supabase/supabase-js" in allDeps || "@supabase/ssr" in allDeps) {
        tags.add("supabase");
        database = "postgres";
        tags.add("postgres");
      }
      if ("pg" in allDeps || "postgres" in allDeps) {
        database = "postgres";
        tags.add("postgres");
      }
      if ("@upstash/redis" in allDeps || "@upstash/ratelimit" in allDeps) {
        tags.add("upstash");
      }
      if ("@playwright/test" in allDeps || "playwright" in allDeps) {
        tags.add("playwright");
      }

      // HTTP frameworks
      if ("fastify" in allDeps) {
        httpFramework = "fastify";
        httpSurface = true;
        tags.add("fastify");
      } else if ("hono" in allDeps) {
        httpFramework = "hono";
        httpSurface = true;
        tags.add("hono");
      } else if ("express" in allDeps) {
        httpFramework = "express";
        httpSurface = true;
        tags.add("express");
      } else if ("next" in allDeps) {
        httpFramework = "next";
        uiFramework = "react";
        httpSurface = true;
        tags.add("next");
        tags.add("react");
      }

      // UI frameworks
      if ("react" in allDeps) {
        uiFramework = "react";
        tags.add("react");
      } else if ("vue" in allDeps) {
        uiFramework = "vue";
        tags.add("vue");
      } else if ("svelte" in allDeps) {
        uiFramework = "svelte";
        tags.add("svelte");
      } else if ("solid-js" in allDeps) {
        uiFramework = "solid";
        tags.add("solid");
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  // 2. Python detection
  const pyprojectPath = path.join(absRepo, "pyproject.toml");
  const reqTxtPath = path.join(absRepo, "requirements.txt");
  if (fs.existsSync(pyprojectPath) || fs.existsSync(reqTxtPath)) {
    languages.add("python");
    tags.add("python");
    if (primaryStack === "unknown") primaryStack = "python";
    packageManager = fs.existsSync(path.join(absRepo, "uv.lock")) ? "uv" : "pip";
    if (!commands.test) commands.test = "python3 -m pytest";

    const pyContent = [
      fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, "utf8") : "",
      fs.existsSync(reqTxtPath) ? fs.readFileSync(reqTxtPath, "utf8") : "",
    ].join("\n");

    if (/fastapi/i.test(pyContent)) {
      httpFramework = "fastapi";
      httpSurface = true;
      tags.add("fastapi");
    } else if (/flask/i.test(pyContent)) {
      httpFramework = "flask";
      httpSurface = true;
      tags.add("flask");
    } else if (/django/i.test(pyContent)) {
      httpFramework = "django";
      httpSurface = true;
      tags.add("django");
    }
    if (/sqlalchemy/i.test(pyContent)) {
      orm = "sqlalchemy";
      tags.add("sqlalchemy");
    }
  }

  // 3. Go detection
  const goModPath = path.join(absRepo, "go.mod");
  if (fs.existsSync(goModPath)) {
    languages.add("go");
    tags.add("go");
    if (primaryStack === "unknown") primaryStack = "go";
    packageManager = "go";
    if (!commands.test) commands.test = "go test ./...";
    if (!commands.build) commands.build = "go build ./...";

    const goMod = fs.readFileSync(goModPath, "utf8");
    if (/go-chi\/chi/i.test(goMod)) {
      httpFramework = "chi";
      httpSurface = true;
      tags.add("chi");
    } else if (/gin-gonic\/gin/i.test(goMod)) {
      httpFramework = "gin";
      httpSurface = true;
      tags.add("gin");
    } else if (/net\/http/i.test(goMod)) {
      httpSurface = true;
    }
  }

  // 4. Rust detection
  const cargoPath = path.join(absRepo, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    languages.add("rust");
    tags.add("rust");
    if (primaryStack === "unknown") primaryStack = "rust";
    packageManager = "cargo";
    if (!commands.test) commands.test = "cargo test";
    if (!commands.build) commands.build = "cargo build";
    const cargoText = fs.readFileSync(cargoPath, "utf8");
    if (/axum|actix-web/i.test(cargoText)) {
      httpFramework = "axum";
      httpSurface = true;
    }
  }

  // 5. Ruby / PHP / Java / C# / Elixir detection
  if (fs.existsSync(path.join(absRepo, "Gemfile"))) {
    languages.add("ruby");
    tags.add("ruby");
    if (primaryStack === "unknown") primaryStack = "ruby";
  }
  if (fs.existsSync(path.join(absRepo, "composer.json"))) {
    languages.add("php");
    tags.add("php");
    if (primaryStack === "unknown") primaryStack = "php";
  }
  if (
    fs.existsSync(path.join(absRepo, "pom.xml")) ||
    fs.existsSync(path.join(absRepo, "build.gradle")) ||
    fs.existsSync(path.join(absRepo, "build.gradle.kts"))
  ) {
    languages.add("java-kotlin");
    tags.add("java");
    if (primaryStack === "unknown") primaryStack = "jvm";
  }
  if (fs.existsSync(path.join(absRepo, "mix.exs"))) {
    languages.add("elixir");
    tags.add("elixir");
    if (primaryStack === "unknown") primaryStack = "elixir";
  }

  const exemplars = findExemplarFiles(absRepo);

  return {
    repoId,
    manifestHash,
    primaryStack,
    languages: [...languages],
    packageManager,
    workspaces,
    commands,
    orm,
    migrationsDir,
    database,
    httpFramework,
    uiFramework,
    httpSurface,
    isCli,
    isLibrary,
    tags: [...tags],
    exemplars,
  };
}

export const dnaOutputSchema = z.object({
  cached: z.boolean(),
  dna: z.object({
    repoId: z.string(),
    manifestHash: z.string(),
    primaryStack: z.string(),
    languages: z.array(z.string()),
    packageManager: z.string().nullable(),
    workspaces: z.array(z.string()),
    commands: z.object({
      typecheck: z.string().nullable(),
      lint: z.string().nullable(),
      test: z.string().nullable(),
      build: z.string().nullable(),
    }),
    orm: z.string().nullable(),
    migrationsDir: z.string().nullable(),
    database: z.string().nullable(),
    httpFramework: z.string().nullable(),
    uiFramework: z.string().nullable(),
    httpSurface: z.boolean(),
    isCli: z.boolean(),
    isLibrary: z.boolean(),
    tags: z.array(z.string()),
    exemplars: z.array(
      z.object({
        filePath: z.string(),
        lineRange: z.string(),
        reason: z.string(),
      }),
    ),
  }),
});

export const dnaExtractInputSchema = z.object({
  repoPath: z.string().min(1),
  refresh: z.boolean().optional(),
});

export const nyxDnaExtractTool = defineTool({
  name: "nyx_dna_extract",
  description: "Extracts and caches polyglot project DNA (stack, commands, ORM, HTTP/UI frameworks, exemplars).",
  annotations: {
    title: "Extract Project DNA",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: dnaExtractInputSchema,
  outputSchema: dnaOutputSchema,
  handler: async (input, ctx) => {
    const absRepo = path.resolve(input.repoPath);
    const currentHash = computeManifestHash(absRepo);

    if (!input.refresh) {
      const existing = ctx.db.db
        .prepare("SELECT manifest_hash, dna_json FROM dna WHERE repo_id = ?")
        .get(ctx.repoId) as { manifest_hash: string; dna_json: string } | undefined;
      if (existing && existing.manifest_hash === currentHash) {
        return {
          cached: true,
          dna: JSON.parse(existing.dna_json) as ProjectDna,
        };
      }
    }

    const dna = extractProjectDna(absRepo, ctx.repoId);
    ctx.db.withImmediateTransaction(() => {
      ctx.db.db
        .prepare(
          `INSERT INTO dna (repo_id, manifest_hash, dna_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET
             manifest_hash = excluded.manifest_hash,
             dna_json = excluded.dna_json,
             updated_at = excluded.updated_at`,
        )
        .run(ctx.repoId, dna.manifestHash, JSON.stringify(dna), new Date().toISOString());
    });

    return {
      cached: false,
      dna,
    };
  },
});

export const dnaGetInputSchema = z.object({
  repoPath: z.string().optional(),
});

export const nyxDnaGetTool = defineTool({
  name: "nyx_dna_get",
  description: "Returns cached project DNA, or extracts it on first call.",
  annotations: {
    title: "Get Project DNA",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: dnaGetInputSchema,
  outputSchema: dnaOutputSchema,
  handler: async (input, ctx) => {
    const absRepo = path.resolve(input.repoPath ?? ctx.projectPath);
    const currentHash = computeManifestHash(absRepo);
    const existing = ctx.db.db
      .prepare("SELECT manifest_hash, dna_json FROM dna WHERE repo_id = ?")
      .get(ctx.repoId) as { manifest_hash: string; dna_json: string } | undefined;

    if (existing && existing.manifest_hash === currentHash) {
      return {
        cached: true,
        dna: JSON.parse(existing.dna_json) as ProjectDna,
      };
    }

    const dna = extractProjectDna(absRepo, ctx.repoId);
    ctx.db.withImmediateTransaction(() => {
      ctx.db.db
        .prepare(
          `INSERT INTO dna (repo_id, manifest_hash, dna_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET
             manifest_hash = excluded.manifest_hash,
             dna_json = excluded.dna_json,
             updated_at = excluded.updated_at`,
        )
        .run(ctx.repoId, dna.manifestHash, JSON.stringify(dna), new Date().toISOString());
    });

    return {
      cached: false,
      dna,
    };
  },
});

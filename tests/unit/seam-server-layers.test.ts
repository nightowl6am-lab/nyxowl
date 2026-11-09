import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  detectDbQueryMismatches,
  nyxSeamCheckTool,
  type SeamMismatch,
} from "../../src/mcp/engines/seam/graph.ts";
import { extractDbAndOrmModels } from "../../src/mcp/engines/seam/extractors/index.ts";
import {
  detectUnsupportedDbLayers,
  extractDbQueries,
  extractDbRoutines,
} from "../../src/mcp/engines/seam/extractors/db-queries.ts";
import {
  extractServerCandidates,
  serverCandidateSummary,
} from "../../src/mcp/engines/seam/extractors/server-layers.ts";
import { invokeToolDefinition } from "../../src/mcp/tool.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(testDir, "../fixtures/seam");
const cleanFixture = path.join(fixtureRoot, "server-layers", "clean");
const mismatchFixture = path.join(fixtureRoot, "server-layers", "mismatch");
const buildOutputFixture = path.join(fixtureRoot, "build-output");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-home-"));
afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeGitRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "pipe" });
  return repo;
}

describe("bounded seam reporting", () => {
  it("deduplicates env-drift findings to one per key with representative files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-dedupe-"));
    try {
      const repo = makeGitRepo(root, "dedupe");
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".env.example"), "KNOWN_KEY=x\n");
      fs.writeFileSync(
        path.join(repo, "src", "a.ts"),
        "const first = process.env.UNDECLARED_TWICE;\nexport default first;\n",
      );
      fs.writeFileSync(
        path.join(repo, "src", "b.ts"),
        "const second = process.env.UNDECLARED_TWICE;\nexport default second;\n",
      );
      execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, stdio: "pipe" });

      const res = await invokeToolDefinition(
        nyxSeamCheckTool,
        { worktreePath: repo },
        { nyxHome: tmpHome, callerRole: "test-seam" },
      );
      const out = res.structuredContent as { mismatches: Array<{ kind: string; message: string }> };
      const envDrifts = out.mismatches.filter((m) => m.kind === "env-drift");

      // Regression: old behavior emitted one finding per reference (two here).
      expect(envDrifts.length).toBe(1);
      expect(envDrifts[0]?.message).toContain("src/a.ts:1");
      expect(envDrifts[0]?.message).toContain("src/b.ts:1");
      expect(envDrifts[0]?.message).toContain("(2 occurrence(s))");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps large mismatch lists with a summary carrying the total count", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-cap-"));
    try {
      const repo = makeGitRepo(root, "caps");
      fs.mkdirSync(path.join(repo, "db", "migrations"), { recursive: true });
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, "db", "migrations", "001.sql"),
        "CREATE TABLE users (id TEXT PRIMARY KEY);\n",
      );
      const queryLines = Array.from(
        { length: 55 },
        (_, i) => `export const q${i} = () => client.from("missing_${i}").select();`,
      );
      fs.writeFileSync(path.join(repo, "src", "queries.ts"), queryLines.join("\n"));
      execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, stdio: "pipe" });

      const res = await invokeToolDefinition(
        nyxSeamCheckTool,
        { worktreePath: repo },
        { nyxHome: tmpHome, callerRole: "test-seam" },
      );
      const out = res.structuredContent as {
        status: string;
        mismatches: Array<{ kind: string; message: string }>;
        totalMismatches: number;
        truncated: boolean;
      };

      expect(out.status).toBe("RED");
      expect(out.totalMismatches).toBe(55);
      expect(out.truncated).toBe(true);
      expect(out.mismatches.length).toBe(51); // 50 kept + 1 summary entry
      expect(out.mismatches[49]?.message).toContain('table "missing_49"');
      expect(out.mismatches[50]?.message).toContain("showing first 50 of 55 mismatches");
      expect(out.mismatches[50]?.message).toContain("5 finding(s) omitted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("db client query extractors", () => {
  it("extracts supabase table and rpc references and normalizes them", () => {
    const files = ["lib/db.ts", "app/actions.ts"];
    const queries = extractDbQueries(cleanFixture, files);
    const refs = new Set(queries.map((query) => `${query.kind}:${query.ref}:${query.driver}`));

    expect(refs.has("table:user:supabase")).toBe(true);
    expect(refs.has("rpc:get_user_count:supabase")).toBe(true);
  });

  it("parses rpc names from SQL migrations (CREATE [OR REPLACE] FUNCTION)", () => {
    const files = listFixtureFiles(cleanFixture);
    const routines = extractDbRoutines(cleanFixture, files);
    expect(routines.has("get_user_count")).toBe(true);
  });

  it("extracts prisma, drizzle and raw SQL string queries in synthetic projects", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-dbq-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "src", "schema.ts"),
        "import { pgTable } from 'drizzle-orm/pg-core';\nexport const userAccts = pgTable(\"user_accounts\", { id: 0 });\n",
      );
      fs.writeFileSync(
        path.join(tmp, "src", "queries.ts"),
        [
          "export async function all() { return db.select().from(userAccts); }",
          "export async function insertRow() { return db.insert(userAccts).values({}); }",
          "export async function everyPrisma() { return prisma.userAccount.findMany(); }",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmp, "src", "rawsql.ts"),
        "const rows = db.query('SELECT * FROM audit_line LEFT JOIN users USING (id)');",
      );

      const queries = extractDbQueries(tmp, ["src/schema.ts", "src/queries.ts", "src/rawsql.ts"]);
      const refs = new Set(queries.map((query) => `${query.kind}:${query.ref}:${query.driver}`));

      expect(refs.has("table:user_account:drizzle")).toBe(true);
      expect(refs.has("table:user_account:prisma")).toBe(true);
      expect(refs.has("table:audit_line:sql")).toBe(true);
      expect(refs.has("table:user:sql")).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags query references (including client verbs in server actions) absent from migrations", () => {
    const files = ["lib/queries.ts", "app/actions.ts"];
    const queries = extractDbQueries(mismatchFixture, files);
    const refs = new Set(queries.map((query) => `${query.kind}:${query.ref}`));

    expect(refs.has("table:missing_table")).toBe(true);
    expect(refs.has("rpc:nonexistent_rpc")).toBe(true);
    expect(refs.has("table:session")).toBe(true);
  });
});

describe("db-query seam mismatch detection", () => {
  it("keeps a clean equivalent project GREEN (no db-query drift)", () => {
    const files = listFixtureFiles(cleanFixture);
    const sqlModels = extractDbAndOrmModels(cleanFixture, files).filter(
      (model) => model.source === "sql",
    );
    const routines = extractDbRoutines(cleanFixture, files);
    const queries = extractDbQueries(cleanFixture, files);

    // Meaningful coverage: the queries were actually extracted to compare.
    expect(queries.length).toBeGreaterThan(0);
    expect(sqlModels.length).toBeGreaterThan(0);
    expect(detectDbQueryMismatches(sqlModels, routines, queries)).toEqual([]);
  });

  it("detects a server-action/query-layer referencing tables and rpcs missing from migrations", () => {
    const files = listFixtureFiles(mismatchFixture);
    const sqlModels = extractDbAndOrmModels(mismatchFixture, files).filter(
      (model) => model.source === "sql",
    );
    const queries = extractDbQueries(mismatchFixture, files);

    const mismatches = detectDbQueryMismatches(
      sqlModels,
      extractDbRoutines(mismatchFixture, files),
      queries,
    );
    const messages = mismatches.map((m) => `${m.kind}: ${m.message}`).sort();

    // Regression (BUG 3): old behavior produced zero mismatches because the
    // db-query seam did not exist at all.
    expect(mismatches.length).toBe(3);
    expect(mismatches.every((m) => m.kind === "db-query-drift")).toBe(true);
    expect(messages.some((m) => m.includes('table "missing_table"'))).toBe(true);
    expect(messages.some((m) => m.includes('rpc "nonexistent_rpc"'))).toBe(true);
    expect(messages.some((m) => m.includes('table "session"'))).toBe(true);
  });
});

describe("server-side seam candidates", () => {
  it("extracts \"use server\" actions and server-side loaders as candidates", () => {
    const files = listFixtureFiles(cleanFixture);
    const candidates = extractServerCandidates(cleanFixture, files);
    const action = candidates.find((candidate) => candidate.kind === "server-action");
    const loader = candidates.find((candidate) => candidate.kind === "loader");

    // Regression (BUG 3): server actions and loaders were invisible before.
    expect(action).toMatchObject({ name: "loadUser", filePath: "app/actions.ts" });
    expect(loader).toMatchObject({ name: "getServerSideProps", filePath: "pages/index.tsx" });
  });

  it("classifies detected server layers as unsupported, not absent", () => {
    const files = listFixtureFiles(cleanFixture);
    const summary = serverCandidateSummary(extractServerCandidates(cleanFixture, files));
    const layers = summary.map((entry) => entry.layer);

    expect(layers).toContain("server-actions");
    expect(layers).toContain("server-loaders");
    expect(summary.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("detects unsupported Python ORM layers with a reason", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-seam-pyorm-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "src", "models.py"),
        "from django.db import models  # unextracted query layer\n\nclass Person(models.Model): pass\n",
      );
      const unsupported = detectUnsupportedDbLayers(tmp, ["src/models.py"]);
      expect(unsupported.length).toBe(1);
      expect(unsupported[0]?.layer).toBe("db-query");
      expect(unsupported[0]?.reason).toContain("Python ORM");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("nyx_seam_check end to end (server-side seams + build output)", () => {
  it("is GREEN with full meaningful coverage on the clean equivalent project", async () => {
    const res = await invokeToolDefinition(
      nyxSeamCheckTool,
      { worktreePath: cleanFixture },
      { nyxHome: tmpHome, callerRole: "test-seam" },
    );
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();

    const out = res.structuredContent as {
      status: string;
      coverage: string;
      checkedLayers: string[];
      uncheckedLayers: string[];
      unsupportedLayers: { layer: string; reason: string }[];
      mismatches: SeamMismatch[];
      totalMismatches: number;
      truncated: boolean;
    };

    expect(out.status).toBe("GREEN");
    expect(out.mismatches).toEqual([]);
    expect(out.uncheckedLayers).toEqual([]);

    // Meaningful coverage: all four implemented seams plus coverage that
    // remains accurate despite unsupported-but-detected server layers.
    expect(out.checkedLayers).toEqual(
      expect.arrayContaining(["db-orm", "db-query", "api-client", "env-keys"]),
    );
    expect(out.coverage).toBe("full");
    const unsupportedLayers = out.unsupportedLayers.map((entry) => entry.layer);
    expect(unsupportedLayers).toContain("server-actions");
    expect(unsupportedLayers).toContain("server-loaders");
  });

  it("is RED with db-query-drift on the mismatch project", async () => {
    const res = await invokeToolDefinition(
      nyxSeamCheckTool,
      { worktreePath: mismatchFixture },
      { nyxHome: tmpHome, callerRole: "test-seam" },
    );
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();

    const out = res.structuredContent as {
      status: string;
      checkedLayers: string[];
      unsupportedLayers: { layer: string; reason: string }[];
      mismatches: SeamMismatch[];
    };

    expect(out.status).toBe("RED");
    expect(out.checkedLayers).toContain("db-query");
    expect(out.mismatches.some((m) => m.kind === "db-query-drift")).toBe(true);
    expect(out.unsupportedLayers.map((entry) => entry.layer)).toContain("server-actions");
  });

  it("ignores generated build output and keeps the report small", async () => {
    const res = await invokeToolDefinition(
      nyxSeamCheckTool,
      { worktreePath: buildOutputFixture },
      { nyxHome: tmpHome, callerRole: "test-seam" },
    );
    const out = res.structuredContent as {
      status: string;
      mismatches: SeamMismatch[];
      totalMismatches: number;
      truncated: boolean;
    };

    // Regression (BUG 2): old behavior reported 2+ false findings
    // (NEXT_PUBLIC_BUILD_SECRET env-drift + /api/nonexistent api-client-drift).
    expect(out.mismatches).toEqual([]);
    expect(out.totalMismatches).toBe(0);
    expect(out.status).toBe("GREEN");
  });
});

function listFixtureFiles(root: string): string[] {
  const files: string[] = [];
  walk(root, root, files);
  return files;
}

function walk(rootDir: string, currentDir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(rootDir, path.join(currentDir, entry.name), acc);
    else if (entry.isFile()) acc.push(path.relative(rootDir, path.join(currentDir, entry.name)));
  }
}

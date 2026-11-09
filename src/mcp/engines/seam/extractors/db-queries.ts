import fs from "node:fs";
import path from "node:path";
import { maskJsComments, normalizeTableOrModelName } from "./index.ts";

export type DbQueryDriver = "supabase" | "prisma" | "drizzle" | "sql";

export interface DbQueryReference {
  /** "table" = query reads/writes a table, "rpc" = calls a stored routine. */
  kind: "table" | "rpc";
  /** Normalized table/model/routine name the query references. */
  ref: string;
  filePath: string;
  line: number;
  driver: DbQueryDriver;
}

export interface UnsupportedSeamLayer {
  layer: string;
  reason: string;
}

const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

function readSourceFile(fullPath: string): string | null {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_FILE_BYTES) return null;
    return fs.readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
}

const PRISMA_METHODS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

const PRISMA_RECEIVERS = new Set(["prisma", "db", "database"]);

const DRIZZLE_SCHEMA_HELPERS = /(?:pgTable|mysqlTable|sqliteTable)/;

const FILE_SUFFIX_RE = /\.(?:ts|tsx|js|jsx|mjs|py|go|rb|java|cs)$/;

function isScannableFile(rel: string): boolean {
  return FILE_SUFFIX_RE.test(rel) && !/(?:\.test|\.spec)\.|(?:^|\/)tests?\//i.test(rel);
}

function identifierToTable(identifier: string, varToTable: Map<string, string>): string {
  const mapped = varToTable.get(identifier);
  if (mapped !== undefined) return normalizeTableOrModelName(mapped);
  return normalizeTableOrModelName(identifier);
}

/**
 * Parses routine (RPC/function) names from SQL migration files: both
 * `CREATE FUNCTION name` and `CREATE OR REPLACE FUNCTION name`, plus
 * `CREATE PROCEDURE name`. These are the stored procedures callable from the
 * client, so they form the "rpc" half of the db-query seam.
 */
export function extractDbRoutines(worktreePath: string, relFiles: string[]): Set<string> {
  const routines = new Set<string>();
  const routineRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+["`']?([A-Za-z0-9_$]+)/gi;

  for (const rel of relFiles) {
    if (!rel.endsWith(".sql")) continue;
    const text = readSourceFile(path.join(worktreePath, rel));
    if (text === null) continue;
    let m: RegExpExecArray | null;
    while ((m = routineRe.exec(text)) !== null) {
      if (m[1]) routines.add(normalizeTableOrModelName(m[1]));
    }
  }

  return routines;
}

interface RawQuerySite {
  kind: "table" | "rpc";
  ref: string;
  line: number;
  driver: DbQueryDriver;
}

/**
 * Extracts client-side DB query references: Supabase `.from("<table>")` and
 * `.rpc("<fn>")`, Prisma `prisma.<model>.<method>()`, Drizzle query builders
 * (`db.select().from(table)`, `db.insert(table)`, ...), and raw SQL query
 * strings. Names are normalized so they can be compared against tables and
 * routines parsed from SQL migrations.
 */
export function extractDbQueries(worktreePath: string, relFiles: string[]): DbQueryReference[] {
  // 1. Build a Drizzle schema-var -> table-name map across all candidate files
  //    so `db.select().from(users)` resolves to the real table name.
  const drizzleVarToTable = new Map<string, string>();
  const rawPerFile = new Map<string, { masked: string; lines: string[] }>();

  for (const rel of relFiles) {
    if (!isScannableFile(rel)) continue;
    const full = path.join(worktreePath, rel);
    const text = readSourceFile(full);
    if (text === null) continue;
    if (rel.endsWith(".ts") || rel.endsWith(".tsx") || rel.endsWith(".js") || rel.endsWith(".mjs")) {
      const masked = maskJsComments(text);
      rawPerFile.set(rel, { masked, lines: masked.split(/\r?\n/) });
      if (DRIZZLE_SCHEMA_HELPERS.test(masked)) {
        const schemaVarRe =
          /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
        let sm: RegExpExecArray | null;
        while ((sm = schemaVarRe.exec(masked)) !== null) {
          if (sm[1] && sm[2]) drizzleVarToTable.set(sm[1], sm[2]);
        }
      }
    } else {
      rawPerFile.set(rel, { masked: text, lines: text.split(/\r?\n/) });
    }
  }

  const queries: DbQueryReference[] = [];

  for (const [rel, { lines }] of rawPerFile) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      const rawsites: RawQuerySite[] = [];

      // 2. Supabase / PostgREST-style query builders.
      for (const m of line.matchAll(/\.from\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g)) {
        if (m[1]) rawsites.push({ kind: "table", ref: m[1], line: i + 1, driver: "supabase" });
      }
      for (const m of line.matchAll(/\.rpc\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g)) {
        if (m[1]) rawsites.push({ kind: "rpc", ref: m[1], line: i + 1, driver: "supabase" });
      }

      // 3. Prisma client calls: prisma.<model>.<method>() (receiver often `db`).
      for (const m of line.matchAll(
        /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\s*\(/g,
      )) {
        const receiver = m[1] ?? "";
        const model = m[2];
        if (!model || !PRISMA_METHODS.has(m[3] ?? "")) continue;
        if (!PRISMA_RECEIVERS.has(receiver)) continue;
        rawsites.push({
          kind: "table",
          ref: normalizeTableOrModelName(model),
          line: i + 1,
          driver: "prisma",
        });
      }

      // 4. Drizzle query builders.
      const selectFrom = /\b(db|database)\s*\.\s*(?:select|selectDistinct)\s*\([^)]*\)\s*\.\s*from\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(
        line,
      );
      if (selectFrom && selectFrom[2]) {
        rawsites.push({
          kind: "table",
          ref: identifierToTable(selectFrom[2], drizzleVarToTable),
          line: i + 1,
          driver: "drizzle",
        });
      }
      const insertUpdateDelete =
        /\b(db|database)\s*\.\s*(?:insert|update|delete)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(line);
      if (insertUpdateDelete && insertUpdateDelete[2]) {
        rawsites.push({
          kind: "table",
          ref: identifierToTable(insertUpdateDelete[2], drizzleVarToTable),
          line: i + 1,
          driver: "drizzle",
        });
      }

      // 5. Raw SQL query strings.
      if (/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(line)) {
        for (const m of line.matchAll(
          /\b(?:FROM|INTO|JOIN)\s+["'`]?([A-Za-z_][A-Za-z0-9_]+)/gi,
        )) {
          if (m[1] && !/^(?:THE|THIS|THOSE|HERE|THEM)$/.test(m[1].toUpperCase())) {
            rawsites.push({ kind: "table", ref: m[1], line: i + 1, driver: "sql" });
          }
        }
        for (const m of line.matchAll(/\bUPDATE\s+["'`]?([A-Za-z_][A-Za-z0-9_]+)/gi)) {
          if (m[1]) rawsites.push({ kind: "table", ref: m[1], line: i + 1, driver: "sql" });
        }
      }

      const seenOnLine = new Set<string>();
      for (const site of rawsites) {
        const key = `${site.kind}:${site.ref}:${site.driver}`;
        if (seenOnLine.has(key)) continue;
        seenOnLine.add(key);
        queries.push({
          kind: site.kind,
          ref: normalizeTableOrModelName(site.ref),
          filePath: rel,
          line: site.line,
          driver: site.driver,
        });
      }
    }
  }

  return queries;
}

/** Python ORM modules the seam engine cannot verify against migrations. */
const UNSUPPORTED_PYTHON_ORM_RE =
  /\b(?:from\s+django\.db|import\s+sqlalchemy|from\s+sqlalchemy|import\s+peewee|from\s+pony(?:\.orm)?)\b/;

/**
 * Detects supported-in-the-wild but unimplemented seam layers so coverage can
 * report them as "unsupported" instead of silently pretending they are absent.
 */
export function detectUnsupportedDbLayers(
  worktreePath: string,
  relFiles: string[],
): UnsupportedSeamLayer[] {
  const unsupported: UnsupportedSeamLayer[] = [];
  let pythonOrm = false;

  for (const rel of relFiles) {
    if (!rel.endsWith(".py")) continue;
    const text = readSourceFile(path.join(worktreePath, rel));
    if (text === null) continue;
    if (UNSUPPORTED_PYTHON_ORM_RE.test(text)) pythonOrm = true;
  }

  if (pythonOrm) {
    unsupported.push({
      layer: "db-query",
      reason:
        "Python ORM (django.db.models, sqlalchemy, peewee or pony) detected; extracting query-driver references from Python ORM code is unsupported, so table/rpc mismatches there are not checked",
    });
  }

  return unsupported;
}

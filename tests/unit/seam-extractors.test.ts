import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractApiEndpoints,
  extractDbAndOrmModels,
  extractEnvReferences,
  extractFrontendApiCalls,
  maskJsComments,
  normalizeTableOrModelName,
} from "../../src/mcp/engines/seam/extractors/index.ts";
import { routePathMatches } from "../../src/mcp/engines/seam/graph.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(testDir, "../fixtures/seam");

function listFiles(root: string, current = root, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      listFiles(root, full, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(root, full));
    }
  }
  return acc;
}

describe("seam extractor normalization", () => {
  it("pairs pluralized SQL tables with singular Prisma models and parses nested column types", () => {
    const root = path.join(fixtureRoot, "db");
    const models = extractDbAndOrmModels(root, listFiles(root));
    const sqlModels = models.filter((model) => model.source === "sql");
    const ormModels = models.filter((model) => model.source === "prisma");

    const sqlNames = sqlModels.map((model) => model.tableName).sort();
    const ormNames = ormModels.map((model) => model.tableName).sort();
    expect(sqlNames).toEqual([
      "address",
      "analysis",
      "category",
      "company",
      "status",
      "user",
    ]);
    expect(ormNames).toEqual(sqlNames);

    expect(sqlModels.some((model) => model.tableName === "analysis")).toBe(true);
    expect(ormModels.some((model) => model.tableName === "analysis")).toBe(true);
    expect(sqlModels.some((model) => model.tableName === "status")).toBe(true);
    expect(ormModels.some((model) => model.tableName === "status")).toBe(true);
    expect(sqlModels.some((model) => model.tableName === "address")).toBe(true);
    expect(ormModels.some((model) => model.tableName === "address")).toBe(true);

    for (const sqlModel of sqlModels) {
      const ormModel = ormModels.find((model) => model.tableName === sqlModel.tableName);
      expect(ormModel, `missing ORM model for ${sqlModel.tableName}`).toBeDefined();
      if (!ormModel) continue;
      for (const field of sqlModel.fields) {
        expect(ormModel.fields.has(field), `${sqlModel.tableName}.${field}`).toBe(true);
      }
    }

    const users = sqlModels.find((model) => model.tableName === "user");
    expect(users).toBeDefined();
    if (!users) return;
    expect(users.fields.has("amount")).toBe(true);
    expect(users.fields.has("note")).toBe(true);
    expect(users.fields.has("parentid")).toBe(true);
    expect(users.fields.has("displayname")).toBe(true);
  });

  it("discovers Next.js app/pages routes with groups, dynamic, catch-all, and optional catch-all segments", () => {
    const root = path.join(fixtureRoot, "next");
    const endpoints = extractApiEndpoints(root, listFiles(root));

    const methodsAt = (routePath: string): string[] =>
      endpoints
        .filter((endpoint) => endpoint.path === routePath)
        .map((endpoint) => endpoint.method)
        .sort();

    expect(methodsAt("/api/users")).toEqual(["GET", "POST"]);
    expect(methodsAt("/api/users/:param")).toEqual(["GET"]);
    expect(methodsAt("/api/orphans/*")).toEqual(["GET"]);
    expect(methodsAt("/api/orphans/optional/*")).toEqual(["GET"]);
    expect(methodsAt("/api/health")).toEqual(["GET"]);
  });

  it("applies same-file Express/Fastify mount prefixes", () => {
    const root = path.join(fixtureRoot, "fastify");
    const endpoints = extractApiEndpoints(root, ["server.ts"]);
    expect(
      endpoints.some(
        (endpoint) => endpoint.path === "/api/v1/users" && endpoint.method === "GET",
      ),
    ).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.path.includes("commented"))).toBe(false);
  });

  it("resolves frontend base constants, template literals, concat, query/hash stripping, and static assets", () => {
    const root = path.join(fixtureRoot, "client");
    const calls = extractFrontendApiCalls(root, ["client.ts"]);

    const methodsAt = (callPath: string): string[] =>
      calls.filter((call) => call.path === callPath).map((call) => call.method).sort();

    expect(methodsAt("/api/users")).toEqual(["GET", "POST"]);
    expect(methodsAt("/health")).toEqual(["GET"]);
    expect(methodsAt("/v1/users")).toEqual(["GET"]);
    expect(methodsAt("/api/v1/users")).toEqual(["GET", "POST"]);
    expect(calls.some((call) => call.path === "/commented-out-users")).toBe(false);
    expect(calls.some((call) => /\.png$/i.test(call.path))).toBe(false);
  });

  it("detects every supported environment syntax while excluding builtins", () => {
    const root = path.join(fixtureRoot, "env");
    const refs = extractEnvReferences(root, listFiles(root));
    const keys = new Set(refs.map((ref) => ref.key));

    for (const expected of [
      "API_KEY",
      "DB_URL",
      "VITE_URL",
      "DENO_KEY",
      "GO_KEY",
      "RUBY_KEY",
      "RUBY_FETCH_KEY",
      "PHP_KEY",
      "PHP_GETENV_KEY",
      "JAVA_KEY",
      "CS_KEY",
    ]) {
      expect(keys.has(expected), expected).toBe(true);
    }
    expect(keys.has("NODE_ENV")).toBe(false);
    expect(keys.has("PORT")).toBe(false);
    expect(keys.has("COMMENTED_KEY")).toBe(false);
  });
});

describe("routePathMatches", () => {
  it("matches :param against exactly one segment", () => {
    expect(routePathMatches("/api/users/:param", "/api/users/42")).toBe(true);
    expect(routePathMatches("/api/users/:param", "/api/users")).toBe(false);
    expect(routePathMatches("/api/users/:param", "/api/users/42/profile")).toBe(false);
  });

  it("matches * against zero or more remaining segments", () => {
    expect(routePathMatches("/api/orphans/*", "/api/orphans")).toBe(true);
    expect(routePathMatches("/api/orphans/*", "/api/orphans/a")).toBe(true);
    expect(routePathMatches("/api/orphans/*", "/api/orphans/a/b/c")).toBe(true);
  });

  it("does not produce false matches", () => {
    expect(routePathMatches("/api/users", "/api/accounts")).toBe(false);
    expect(routePathMatches("/api/users", "/api/users/42")).toBe(false);
    expect(routePathMatches("/api/users/42", "/api/users/43")).toBe(false);
  });
});

describe("maskJsComments", () => {
  it("masks a large unclosed block comment in linear time while preserving length and newlines", () => {
    const text = `/*${"a\n".repeat(100_000)}${"x".repeat(100_000)}`;
    const masked = maskJsComments(text);
    const countNewlines = (value: string): number => value.match(/\n/g)?.length ?? 0;

    expect(masked.length).toBe(text.length);
    expect(countNewlines(masked)).toBe(countNewlines(text));
    expect(masked.replace(/\s/g, "")).toBe("");
  });

  it("preserves URLs and masks only line comments", () => {
    const urlLine = 'const url = "http://example.com/api";';
    expect(maskJsComments(urlLine)).toBe(urlLine);

    const code = "const value = 1; // remove me\nconst next = 2;";
    const masked = maskJsComments(code);
    expect(masked).toContain("const value = 1;");
    expect(masked).toContain("const next = 2;");
    expect(masked).not.toContain("remove me");
    expect(masked.length).toBe(code.length);
  });
});

describe("normalizeTableOrModelName", () => {
  it("does not read inherited prototype members", () => {
    expect(normalizeTableOrModelName("constructor")).toBe("constructor");
    expect(normalizeTableOrModelName("__proto__")).toBe("__proto__");
    expect(normalizeTableOrModelName("toString")).toBe("to_string");
    expect(normalizeTableOrModelName("ToString")).toBe("to_string");
    expect(typeof normalizeTableOrModelName("toString")).toBe("string");
    expect(typeof normalizeTableOrModelName("ToString")).toBe("string");
  });

  it("singularizes plural and already-singular names", () => {
    expect(normalizeTableOrModelName("analyses")).toBe("analysis");
    expect(normalizeTableOrModelName("bases")).toBe("base");
    expect(normalizeTableOrModelName("movies")).toBe("movie");
    expect(normalizeTableOrModelName("statuses")).toBe("status");
    expect(normalizeTableOrModelName("users")).toBe("user");
  });
});

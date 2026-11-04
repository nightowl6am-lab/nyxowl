import fs from "node:fs";
import path from "node:path";

export interface DbTableModel {
  source: "sql" | "prisma" | "drizzle";
  tableName: string;
  fields: Set<string>;
  filePath: string;
}

export interface ApiEndpoint {
  framework: "express" | "fastify" | "hono" | "nextjs" | "fastapi" | "chi";
  method: string;
  path: string;
  responseFields: Set<string>;
  filePath: string;
}

export interface FrontendApiCall {
  method: string;
  path: string;
  expectedFields: Set<string>;
  filePath: string;
  line: number;
}

export interface EnvReference {
  key: string;
  filePath: string;
  line: number;
}

export interface SeamExtractor<T> {
  id: string;
  layer: "db" | "orm" | "api" | "client" | "env";
  extract(worktreePath: string, files: string[]): T[];
}

function normalizeTableOrModelName(raw: string): string {
  return raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/s$/, "");
}

function normalizeRoutePath(rawPath: string): string {
  return (
    rawPath
      .trim()
      .split("?")[0]!
      // Normalize :id, [id], {id}, ${...} to :param
      .replace(/\$\{[^}]+\}/g, ":param")
      .replace(/\[[^\]]+\]/g, ":param")
      .replace(/\{[^}]+\}/g, ":param")
      .replace(/:[A-Za-z0-9_]+/g, ":param")
      .replace(/\/+$/, "") || "/"
  );
}

export function extractDbAndOrmModels(
  worktreePath: string,
  relFiles: string[],
): DbTableModel[] {
  const models: DbTableModel[] = [];

  for (const rel of relFiles) {
    const full = path.join(worktreePath, rel);
    if (!fs.existsSync(full)) continue;

    // 1. Prisma schema
    if (rel.endsWith(".prisma")) {
      const text = fs.readFileSync(full, "utf8");
      const modelRe = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g;
      let m: RegExpExecArray | null;
      while ((m = modelRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        const fields = new Set<string>();
        for (const rawLine of m[2].split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
          const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z0-9_?[\]]+/.exec(line);
          if (fieldMatch && fieldMatch[1]) {
            fields.add(fieldMatch[1].toLowerCase().replace(/_/g, ""));
          }
        }
        models.push({
          source: "prisma",
          tableName: normalizeTableOrModelName(m[1]),
          fields,
          filePath: rel,
        });
      }
      continue;
    }

    // 2. SQL migrations
    if (rel.endsWith(".sql")) {
      const text = fs.readFileSync(full, "utf8");
      const createTableRe =
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?[A-Za-z0-9_]+["`]?\.|)?["`]?([A-Za-z0-9_]+)["`]?\s*\(([\s\S]*?)\);/gi;
      let m: RegExpExecArray | null;
      while ((m = createTableRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        const fields = new Set<string>();
        for (const rawLine of m[2].split(",")) {
          const line = rawLine.trim();
          if (
            !line ||
            /^(?:PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK|INDEX|KEY)\b/i.test(line)
          ) {
            continue;
          }
          const colMatch = /^["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+[A-Za-z]+/.exec(line);
          if (colMatch && colMatch[1]) {
            fields.add(colMatch[1].toLowerCase().replace(/_/g, ""));
          }
        }
        models.push({
          source: "sql",
          tableName: normalizeTableOrModelName(m[1]),
          fields,
          filePath: rel,
        });
      }
      continue;
    }

    // 3. Drizzle ORM schema files
    if (/\.(?:ts|js)$/.test(rel)) {
      const text = fs.readFileSync(full, "utf8");
      if (!/pgTable|mysqlTable|sqliteTable/.test(text)) continue;
      const drizzleRe =
        /(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*,\s*\{([\s\S]*?)\}\s*(?:,|\))/g;
      let m: RegExpExecArray | null;
      while ((m = drizzleRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        const fields = new Set<string>();
        const propRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
        let pm: RegExpExecArray | null;
        while ((pm = propRe.exec(m[2])) !== null) {
          if (pm[1]) {
            fields.add(pm[1].toLowerCase().replace(/_/g, ""));
          }
        }
        models.push({
          source: "drizzle",
          tableName: normalizeTableOrModelName(m[1]),
          fields,
          filePath: rel,
        });
      }
    }
  }

  return models;
}

export function extractApiEndpoints(
  worktreePath: string,
  relFiles: string[],
): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];

  for (const rel of relFiles) {
    const full = path.join(worktreePath, rel);
    if (!fs.existsSync(full)) continue;
    const normRel = rel.replace(/\\/g, "/");

    // 1. Next.js App Router route handlers: app/api/.../route.ts
    const nextRouteMatch = /(?:^|\/)app\/(api\/.*)\/route\.(?:ts|tsx|js|jsx)$/.exec(normRel);
    if (nextRouteMatch && nextRouteMatch[1]) {
      const text = fs.readFileSync(full, "utf8");
      const routePath = normalizeRoutePath("/" + nextRouteMatch[1]);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(text)) {
          endpoints.push({
            framework: "nextjs",
            method,
            path: routePath,
            responseFields: extractReturnedJsonFields(text),
            filePath: rel,
          });
        }
      }
      continue;
    }

    // 2. Express / Fastify / Hono TS/JS routes
    if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(rel)) {
      const text = fs.readFileSync(full, "utf8");
      const routeRe =
        /\b(?:app|fastify|server|router|api)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]([\s\S]{0,400}?)\)/gi;
      let m: RegExpExecArray | null;
      while ((m = routeRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        const method = m[1].toUpperCase();
        const routePath = normalizeRoutePath(m[2]);
        const bodySnippet = m[3] ?? "";
        endpoints.push({
          framework: /fastify/i.test(text)
            ? "fastify"
            : /hono/i.test(text)
              ? "hono"
              : "express",
          method,
          path: routePath,
          responseFields: extractReturnedJsonFields(bodySnippet),
          filePath: rel,
        });
      }
      continue;
    }

    // 3. Python FastAPI routes
    if (rel.endsWith(".py")) {
      const text = fs.readFileSync(full, "utf8");
      const pyRouteRe =
        /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["'][^>]*\)[\s\S]{0,400}?return\s+\{([^}]*)\}/gi;
      let m: RegExpExecArray | null;
      while ((m = pyRouteRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        const fields = new Set<string>();
        const dictBody = m[3] ?? "";
        const keyRe = /["']([A-Za-z_][A-Za-z0-9_]*)["']\s*:/g;
        let km: RegExpExecArray | null;
        while ((km = keyRe.exec(dictBody)) !== null) {
          if (km[1]) fields.add(km[1]);
        }
        endpoints.push({
          framework: "fastapi",
          method: m[1].toUpperCase(),
          path: normalizeRoutePath(m[2]),
          responseFields: fields,
          filePath: rel,
        });
      }
      // Also match FastAPI routes without inline dict return
      const simplePyRe = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi;
      while ((m = simplePyRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        const method = m[1].toUpperCase();
        const rPath = normalizeRoutePath(m[2]);
        if (!endpoints.some((e) => e.method === method && e.path === rPath)) {
          endpoints.push({
            framework: "fastapi",
            method,
            path: rPath,
            responseFields: new Set<string>(),
            filePath: rel,
          });
        }
      }
      continue;
    }

    // 4. Go Chi routes
    if (rel.endsWith(".go")) {
      const text = fs.readFileSync(full, "utf8");
      const chiRe = /\b(?:r|router|mux)\.(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = chiRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        endpoints.push({
          framework: "chi",
          method: m[1].toUpperCase(),
          path: normalizeRoutePath(m[2]),
          responseFields: new Set<string>(),
          filePath: rel,
        });
      }
    }
  }

  return endpoints;
}

function extractReturnedJsonFields(snippet: string): Set<string> {
  const fields = new Set<string>();
  const returnObjRe = /(?:return|json|send)\s*\(?\s*\{([^{}]{1,300})\}/g;
  let m: RegExpExecArray | null;
  while ((m = returnObjRe.exec(snippet)) !== null) {
    const inner = m[1] ?? "";
    const propRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?::|,|\})/g;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(inner)) !== null) {
      if (pm[1] && pm[1] !== "return" && pm[1] !== "await") {
        fields.add(pm[1]);
      }
    }
  }
  return fields;
}

export function extractFrontendApiCalls(
  worktreePath: string,
  relFiles: string[],
): FrontendApiCall[] {
  const calls: FrontendApiCall[] = [];

  for (const rel of relFiles) {
    if (!/\.(?:ts|tsx|js|jsx|vue|svelte)$/.test(rel)) continue;
    // Skip test files
    if (/(?:\.test|\.spec)\.|(?:^|\/)tests?\//i.test(rel)) continue;
    const full = path.join(worktreePath, rel);
    if (!fs.existsSync(full)) continue;

    const text = fs.readFileSync(full, "utf8");
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const windowSlice = lines.slice(i, i + 6).join(" ");

      // 1. fetch('/api/...', { method: 'POST' })
      const fetchMatch = /\bfetch\s*\(\s*["'`](\/api\/[^"'`\s)]*)["'`](?:\s*,\s*\{([^}]*)\})?/.exec(
        windowSlice,
      );
      if (fetchMatch && fetchMatch[1] && line.includes("fetch(")) {
        const opts = fetchMatch[2] ?? "";
        const methodMatch = /method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(opts);
        const method = methodMatch?.[1]?.toUpperCase() ?? "GET";
        const expectedFields = new Set<string>();

        // Look for typed response fields on same/adjacent lines: e.g. NyxSeamExpect<foo, bar> or data.someField
        const surrounding = lines.slice(Math.max(0, i - 2), i + 8).join("\n");
        const fieldAccessRe = /\b(?:data|res|json|item)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
        let fm: RegExpExecArray | null;
        while ((fm = fieldAccessRe.exec(surrounding)) !== null) {
          if (
            fm[1] &&
            !["json", "ok", "status", "headers", "text", "then", "catch", "map", "length"].includes(
              fm[1],
            )
          ) {
            expectedFields.add(fm[1]);
          }
        }

        calls.push({
          method,
          path: normalizeRoutePath(fetchMatch[1]),
          expectedFields,
          filePath: rel,
          line: i + 1,
        });
      }

      // 2. axios.get('/api/...') / axios.post('/api/...')
      const axiosMatch =
        /\baxios\.(get|post|put|patch|delete)\s*(?:<[^>]+>)?\s*\(\s*["'`](\/api\/[^"'`\s)]*)["'`]/i.exec(
          line,
        );
      if (axiosMatch && axiosMatch[1] && axiosMatch[2]) {
        calls.push({
          method: axiosMatch[1].toUpperCase(),
          path: normalizeRoutePath(axiosMatch[2]),
          expectedFields: new Set<string>(),
          filePath: rel,
          line: i + 1,
        });
      }
    }
  }

  return calls;
}

export function extractEnvReferences(
  worktreePath: string,
  relFiles: string[],
): EnvReference[] {
  const refs: EnvReference[] = [];
  const builtinKeys = new Set(["NODE_ENV", "PORT", "HOST", "CI", "PATH", "HOME", "TZ"]);

  for (const rel of relFiles) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|py|go)$/.test(rel)) continue;
    if (/(?:\.test|\.spec)\.|(?:^|\/)tests?\//i.test(rel)) continue;
    const full = path.join(worktreePath, rel);
    if (!fs.existsSync(full)) continue;

    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const matches = [
        ...line.matchAll(/\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g),
        ...line.matchAll(/\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)\b/g),
        ...line.matchAll(/\bos\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g),
        ...line.matchAll(/\bos\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g),
      ];
      for (const m of matches) {
        if (m[1] && !builtinKeys.has(m[1])) {
          refs.push({
            key: m[1],
            filePath: rel,
            line: i + 1,
          });
        }
      }
    }
  }

  return refs;
}

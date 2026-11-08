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

const IRREGULAR_SINGULARS: Record<string, string> = {
  analyses: "analysis",
  theses: "thesis",
  crises: "crisis",
  diagnoses: "diagnosis",
  hypotheses: "hypothesis",
  syntheses: "synthesis",
  emphases: "emphasis",
  statuses: "status",
  buses: "bus",
  viruses: "virus",
  campuses: "campus",
  aliases: "alias",
  canvases: "canvas",
  atlases: "atlas",
  biases: "bias",
  gases: "gas",
  movies: "movie",
  cookies: "cookie",
  zombies: "zombie",
  calories: "calorie",
  people: "person",
  children: "child",
  data: "data",
  media: "media",
  news: "news",
  series: "series",
  species: "species",
  fish: "fish",
  sheep: "sheep",
  information: "information",
  equipment: "equipment",
  analysis: "analysis",
  thesis: "thesis",
  crisis: "crisis",
  diagnosis: "diagnosis",
  hypothesis: "hypothesis",
  synthesis: "synthesis",
  emphasis: "emphasis",
  basis: "basis",
  axis: "axis",
  oasis: "oasis",
  alias: "alias",
  canvas: "canvas",
  atlas: "atlas",
  bias: "bias",
  gas: "gas",
  chaos: "chaos",
  cosmos: "cosmos",
};

function singularize(word: string): string {
  if (Object.hasOwn(IRREGULAR_SINGULARS, word)) {
    return IRREGULAR_SINGULARS[word] ?? word;
  }
  // Words ending in -is are already singular (analysis, thesis, crisis, ...).
  if (word.endsWith("is")) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) {
    return word.slice(0, -1);
  }
  return word;
}

export function normalizeTableOrModelName(raw: string): string {
  const snake = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return singularize(snake);
}

function normalizeRoutePath(rawPath: string): string {
  let cleaned = rawPath.trim();
  const queryIndex = cleaned.search(/[?#]/);
  if (queryIndex >= 0) cleaned = cleaned.slice(0, queryIndex);

  cleaned = cleaned
    // Normalize ${...} to :param (client template literals)
    .replace(/\$\{[^}]+\}/g, ":param")
    // Next.js catch-all / optional catch-all segments
    .replace(/\[\[\.\.\.[^\]]*\]\]/g, "*")
    .replace(/\[\.\.\.[^\]]*\]/g, "*")
    .replace(/\[[^\]]+\]/g, ":param")
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/:[A-Za-z0-9_]+/g, ":param")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");

  if (!cleaned.startsWith("/")) cleaned = `/${cleaned}`;
  return cleaned === "" ? "/" : cleaned;
}

function splitTopLevelColumns(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (const ch of body) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  parts.push(current);
  return parts;
}

function maskLineComments(text: string): string {
  return text.replace(
    /(^|[^:])\/\/.*$/gm,
    (match: string, prefix: string) =>
      prefix + " ".repeat(match.length - prefix.length),
  );
}

export function maskJsComments(text: string): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const open = text.indexOf("/*", i);
    if (open === -1) {
      return out + maskLineComments(text.slice(i));
    }

    out += maskLineComments(text.slice(i, open));
    const close = text.indexOf("*/", open + 2);
    const end = close === -1 ? text.length : close + 2;
    out += text.slice(open, end).replace(/[^\n]/g, " ");
    if (close === -1) break;
    i = end;
  }

  return out;
}

function transformPathSegment(segment: string): string | null {
  // Next.js route groups `(marketing)` and parallel slots `@modal`.
  if (/^\(.*\)$/.test(segment) || segment.startsWith("@")) return null;
  if (/^\[\[\.\.\..+\]\]$/.test(segment) || /^\[\.\.\..+\]$/.test(segment)) return "*";
  if (/^\[.+\]$/.test(segment)) return ":param";
  return segment;
}

function nextAppRoutePath(rel: string): string | null {
  const normRel = rel.replace(/\\/g, "/");
  const match = /(?:^|\/)(?:src\/)?app(?:\/(.+?))?\/route\.(?:ts|tsx|js|jsx)$/.exec(
    normRel,
  );
  if (!match) return null;

  const inner = match[1];
  if (inner === undefined) return "/";

  const parts: string[] = [];
  for (const segment of inner.split("/")) {
    if (!segment) continue;
    const transformed = transformPathSegment(segment);
    if (transformed !== null) parts.push(transformed);
  }
  return normalizeRoutePath(`/${parts.join("/")}`);
}

function pagesApiRoutePath(rel: string): string | null {
  const normRel = rel.replace(/\\/g, "/");
  const match = /(?:^|\/)(?:src\/)?pages\/api\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(normRel);
  if (!match || !match[1]) return null;

  const segments = match[1].split("/");
  if (segments[segments.length - 1] === "index") segments.pop();

  const parts: string[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    const transformed = transformPathSegment(segment);
    if (transformed !== null) parts.push(transformed);
  }

  const suffix = parts.length > 0 ? `/${parts.join("/")}` : "";
  return normalizeRoutePath(`/api${suffix}`);
}

function hasNextMethod(text: string, method: string): boolean {
  return (
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(text) ||
    new RegExp(`export\\s+(?:const|let)\\s+${method}\\b`).test(text)
  );
}

function pagesMethods(text: string): string[] {
  const methods = new Set<string>();
  const methodRe =
    /(?:case\s*["'](GET|POST|PUT|PATCH|DELETE)["']|req\.method\s*===?\s*["'](GET|POST|PUT|PATCH|DELETE)["'])/g;
  let match: RegExpExecArray | null;
  while ((match = methodRe.exec(text)) !== null) {
    const method = match[1] ?? match[2];
    if (method) methods.add(method.toUpperCase());
  }
  if (methods.size === 0) methods.add("GET");
  return [...methods];
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
      const text = readSourceFile(full);
      if (text === null) continue;
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
      const text = readSourceFile(full);
      if (text === null) continue;
      const createTableRe =
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?[A-Za-z0-9_]+["`]?\.|)?["`]?([A-Za-z0-9_]+)["`]?\s*\(([\s\S]*?)\);/gi;
      let m: RegExpExecArray | null;
      while ((m = createTableRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        const fields = new Set<string>();
        for (const rawColumn of splitTopLevelColumns(m[2])) {
          const line = rawColumn.trim();
          if (
            !line ||
            /^(?:PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK|INDEX|KEY|EXCLUDE)\b/i.test(line)
          ) {
            continue;
          }
          const colMatch = /^["`']?([A-Za-z_][A-Za-z0-9_]*)["`']?\s+[A-Za-z]/.exec(line);
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
      const text = readSourceFile(full);
      if (text === null) continue;
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

    // 1. Next.js App Router route handlers
    const nextPath = nextAppRoutePath(normRel);
    if (nextPath !== null) {
      const text = readSourceFile(full);
      if (text === null) continue;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (hasNextMethod(text, method)) {
          endpoints.push({
            framework: "nextjs",
            method,
            path: nextPath,
            responseFields: extractReturnedJsonFields(text),
            filePath: rel,
          });
        }
      }
      continue;
    }

    // 2. Next.js Pages Router API handlers
    const pagesPath = pagesApiRoutePath(normRel);
    if (pagesPath !== null) {
      const text = readSourceFile(full);
      if (text === null) continue;
      for (const method of pagesMethods(text)) {
        endpoints.push({
          framework: "nextjs",
          method,
          path: pagesPath,
          responseFields: extractReturnedJsonFields(text),
          filePath: rel,
        });
      }
      continue;
    }

    // 3. Express / Fastify / Hono TS/JS routes
    if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(rel)) {
      const sourceText = readSourceFile(full);
      if (sourceText === null) continue;
      const text = maskJsComments(sourceText);

      const httpVars = new Set(["app", "fastify", "server", "router", "api"]);
      const instanceRe =
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:Hono|Fastify|Router|Express|express)\s*\(/g;
      const expressAssignRe = /\b([A-Za-z_$][\w$]*)\s*=\s*express\s*\(/g;
      let im: RegExpExecArray | null;
      while ((im = instanceRe.exec(text)) !== null) {
        if (im[1]) httpVars.add(im[1]);
      }
      while ((im = expressAssignRe.exec(text)) !== null) {
        if (im[1]) httpVars.add(im[1]);
      }

      const mountPrefix = new Map<string, string>();
      const mountRe =
        /\b(?:app|server|fastify)\.use\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)/g;
      let mm: RegExpExecArray | null;
      while ((mm = mountRe.exec(text)) !== null) {
        if (mm[1] !== undefined && mm[2]) mountPrefix.set(mm[2], mm[1]);
      }

      const routeRe =
        /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]([\s\S]{0,400}?)\)/gi;
      let m: RegExpExecArray | null;
      while ((m = routeRe.exec(text)) !== null) {
        const variable = m[1];
        const method = m[2];
        const registeredPath = m[3];
        if (!variable || !method || registeredPath === undefined) continue;
        if (!httpVars.has(variable)) continue;

        const prefix = mountPrefix.get(variable) ?? "";
        const bodySnippet = m[4] ?? "";
        endpoints.push({
          framework: /fastify/i.test(text)
            ? "fastify"
            : /hono/i.test(text)
              ? "hono"
              : "express",
          method: method.toUpperCase(),
          path: normalizeRoutePath(`${prefix}${registeredPath}`),
          responseFields: extractReturnedJsonFields(bodySnippet),
          filePath: rel,
        });
      }
      continue;
    }

    // 4. Python FastAPI routes
    if (rel.endsWith(".py")) {
      const text = readSourceFile(full);
      if (text === null) continue;

      const routerPrefixes = new Map<string, string>();
      const routerRe = /\b([A-Za-z_$][\w$]*)\s*=\s*APIRouter\s*\(([^)]*)\)/g;
      let rm: RegExpExecArray | null;
      while ((rm = routerRe.exec(text)) !== null) {
        if (!rm[1] || rm[2] === undefined) continue;
        const prefixMatch = /prefix\s*=\s*["']([^"']*)["']/.exec(rm[2]);
        if (prefixMatch && prefixMatch[1] !== undefined) {
          routerPrefixes.set(rm[1], prefixMatch[1]);
        }
      }

      const pyRouteRe =
        /@([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["'][^)]{0,400}\)(?:(?!\n\s*@[A-Za-z_$][\w$]*\.(?:get|post|put|patch|delete)\s*\()[\s\S]){0,400}?return\s+\{([^}]*)\}/gi;
      let m: RegExpExecArray | null;
      while ((m = pyRouteRe.exec(text)) !== null) {
        const variable = m[1];
        const method = m[2];
        const route = m[3];
        if (!variable || !method || route === undefined) continue;
        const fields = new Set<string>();
        const dictBody = m[4] ?? "";
        const keyRe = /["']([A-Za-z_][A-Za-z0-9_]*)["']\s*:/g;
        let km: RegExpExecArray | null;
        while ((km = keyRe.exec(dictBody)) !== null) {
          if (km[1]) fields.add(km[1]);
        }
        endpoints.push({
          framework: "fastapi",
          method: method.toUpperCase(),
          path: normalizeRoutePath(`${routerPrefixes.get(variable) ?? ""}${route}`),
          responseFields: fields,
          filePath: rel,
        });
      }

      // Also match FastAPI routes without inline dict return
      const simplePyRe =
        /@([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi;
      while ((m = simplePyRe.exec(text)) !== null) {
        const variable = m[1];
        const method = m[2];
        const route = m[3];
        if (!variable || !method || route === undefined) continue;
        const normalizedMethod = method.toUpperCase();
        const routePath = normalizeRoutePath(
          `${routerPrefixes.get(variable) ?? ""}${route}`,
        );
        if (
          !endpoints.some(
            (endpoint) =>
              endpoint.method === normalizedMethod && endpoint.path === routePath,
          )
        ) {
          endpoints.push({
            framework: "fastapi",
            method: normalizedMethod,
            path: routePath,
            responseFields: new Set<string>(),
            filePath: rel,
          });
        }
      }
      continue;
    }

    // 5. Go Chi routes
    if (rel.endsWith(".go")) {
      const text = readSourceFile(full);
      if (text === null) continue;
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

const EXPECTED_FIELD_META = new Set([
  "json",
  "ok",
  "status",
  "headers",
  "text",
  "then",
  "catch",
  "map",
  "length",
]);

function extractExpectedFields(text: string): Set<string> {
  const fields = new Set<string>();
  const fieldAccessRe = /\b(?:data|res|json|item)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldAccessRe.exec(text)) !== null) {
    const field = fm[1];
    if (field && !EXPECTED_FIELD_META.has(field)) fields.add(field);
  }
  return fields;
}

function expandLeadingTemplate(
  inner: string,
  baseConstants: Map<string, string>,
): string | null {
  const match = /^\$\{([A-Za-z_$][\w$]*)\}([\s\S]*)$/.exec(inner);
  if (!match) return inner;
  const name = match[1];
  if (!name) return null;
  const base = baseConstants.get(name);
  if (base === undefined) return null;
  return `${base}${match[2] ?? ""}`;
}

function sanitizeClientPath(raw: string): string | null {
  let cleaned = raw.trim();
  const cut = cleaned.search(/[?#]/);
  if (cut >= 0) cleaned = cleaned.slice(0, cut);
  if (!cleaned) return null;
  if (/^https?:\/\//i.test(cleaned)) return null;
  if (
    /\.(?:png|jpe?g|gif|svg|ico|css|js|mjs|json|woff2?|ttf|map|pdf|zip|webp)$/i.test(
      cleaned,
    )
  ) {
    return null;
  }
  if (!cleaned.startsWith("/")) cleaned = `/${cleaned}`;
  return normalizeRoutePath(cleaned);
}

function fetchMethodFromWindow(windowText: string): string {
  const match = /method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(windowText);
  return match?.[1]?.toUpperCase() ?? "GET";
}

interface DetectedClientCall {
  method: string;
  rawPath: string;
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

    const sourceText = readSourceFile(full);
    if (sourceText === null) continue;
    const text = maskJsComments(sourceText);
    const lines = text.split(/\r?\n/);

    const baseConstants = new Map<string, string>();
    const baseRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']*)["']/g;
    let bm: RegExpExecArray | null;
    while ((bm = baseRe.exec(text)) !== null) {
      if (bm[1] && bm[2] !== undefined) baseConstants.set(bm[1], bm[2]);
    }

    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (
        !/\bfetch\s*\(|\baxios\.|\bky\.|\$fetch\s*\(|\bapi\.|\bclient\.|\bhttp\./.test(
          line,
        )
      ) {
        continue;
      }

      const windowText = lines.slice(i, i + 9).join("\n");
      let detected: DetectedClientCall | null = null;

      // 1. fetch(`${API_BASE}/users`, ...)
      const templateMatch = /\bfetch\s*\(\s*`([^`]*)`/.exec(line);
      if (templateMatch && templateMatch[1] !== undefined) {
        const expanded = expandLeadingTemplate(templateMatch[1], baseConstants);
        if (expanded === null) continue;
        detected = { method: fetchMethodFromWindow(windowText), rawPath: expanded };
      }

      // 2. fetch(API_BASE + "/users", ...)
      if (!detected) {
        const concatMatch =
          /\bfetch\s*\(\s*([A-Za-z_$][\w$]*)\s*\+\s*["'`]([^"'`]*)["'`]/.exec(line);
        if (concatMatch && concatMatch[1] && concatMatch[2] !== undefined) {
          const base = baseConstants.get(concatMatch[1]);
          if (base !== undefined) {
            detected = {
              method: fetchMethodFromWindow(windowText),
              rawPath: `${base}${concatMatch[2]}`,
            };
          }
        }
      }

      // 3. fetch("/users") / $fetch("/users")
      if (!detected) {
        const literalMatch = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/.exec(line);
        if (literalMatch && literalMatch[1]) {
          detected = {
            method: fetchMethodFromWindow(windowText),
            rawPath: literalMatch[1],
          };
        }
      }

      // 4. axios.get("/users") / ky.post("/users") / api.get("/users") ...
      if (!detected) {
        const verbMatch =
          /\b(?:axios|ky|api|client|http)\.(get|post|put|patch|delete)\s*(?:<[^>]+>)?\s*\(\s*["'`]([^"'`]+)["'`]/i.exec(
            line,
          );
        if (verbMatch && verbMatch[1] && verbMatch[2]) {
          detected = {
            method: verbMatch[1].toUpperCase(),
            rawPath: verbMatch[2],
          };
        }
      }

      if (!detected) continue;

      const targetPath = sanitizeClientPath(detected.rawPath);
      if (targetPath === null) continue;

      const dedupeKey = `${rel}:${i + 1}:${detected.method}:${targetPath}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const surrounding = lines.slice(Math.max(0, i - 2), i + 8).join("\n");
      calls.push({
        method: detected.method,
        path: targetPath,
        expectedFields: extractExpectedFields(surrounding),
        filePath: rel,
        line: i + 1,
      });
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
  const patterns: RegExp[] = [
    /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\bprocess\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\bDeno\.env\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /\bos\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /\bos\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /\bos\.Getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /\bENV\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /\bENV\.fetch\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /\$_ENV\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /(?<![.\w])getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /\bSystem\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /\bEnvironment\.GetEnvironmentVariable\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
  ];

  for (const rel of relFiles) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|py|go|rb|php|java|cs)$/.test(rel)) continue;
    if (/(?:\.test|\.spec)\.|(?:^|\/)tests?\//i.test(rel)) continue;
    const full = path.join(worktreePath, rel);
    if (!fs.existsSync(full)) continue;

    const sourceText = readSourceFile(full);
    if (sourceText === null) continue;
    const lines = sourceText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("#")
      ) {
        continue;
      }
      const keysOnLine = new Set<string>();
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        for (const m of line.matchAll(pattern)) {
          const key = m[1];
          if (key && !builtinKeys.has(key)) keysOnLine.add(key);
        }
      }
      for (const key of keysOnLine) {
        refs.push({
          key,
          filePath: rel,
          line: i + 1,
        });
      }
    }
  }

  return refs;
}

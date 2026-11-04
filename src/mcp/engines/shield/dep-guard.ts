import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { defineTool } from "../../tool.ts";

export const ecosystemSchema = z.enum([
  "npm",
  "pypi",
  "crates",
  "go",
  "rubygems",
  "packagist",
  "maven",
  "nuget",
  "hex",
]);

export type PackageEcosystem = z.infer<typeof ecosystemSchema>;

export interface PackageRegistryMetadata {
  exists: boolean;
  latestVersion: string;
  publishedAt?: string;
  weeklyDownloads?: number;
  hasInstallScripts?: boolean;
  deprecated?: boolean;
  hasRepositoryUrl?: boolean;
  osvVulnerabilities?: string[];
}

export type RegistryFetcherFn = (
  packageName: string,
  ecosystem: PackageEcosystem,
  requestedVersion?: string,
) => Promise<PackageRegistryMetadata>;

let customRegistryFetcher: RegistryFetcherFn | null = null;
let customFetchImpl: typeof fetch | null = null;

export function setDepGuardRegistryFetcher(fn: RegistryFetcherFn | null): void {
  customRegistryFetcher = fn;
}

export function setDepGuardFetchImpl(fn: typeof fetch | null): void {
  customFetchImpl = fn;
}

function depGuardFetch(): typeof fetch {
  return customFetchImpl ?? globalThis.fetch;
}

/**
 * Computes standard Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  const prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  const curr = new Array<number>(t.length + 1).fill(0);

  for (let i = 0; i < s.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < t.length; j++) {
      const cost = s[i] === t[j] ? 0 : 1;
      curr[j + 1] = Math.min(
        curr[j]! + 1,
        prev[j + 1]! + 1,
        prev[j]! + cost,
      );
    }
    for (let j = 0; j <= t.length; j++) {
      prev[j] = curr[j]!;
    }
  }
  return prev[t.length]!;
}

function loadPopularPackages(ecosystem: PackageEcosystem): string[] {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    let root = thisDir;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(root, "data", "popular-packages", `${ecosystem}.json`);
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, "utf8")) as string[];
      }
      root = path.dirname(root);
    }
  } catch {
    // Ignore
  }
  return [];
}

export function findTyposquatMatch(
  packageName: string,
  ecosystem: PackageEcosystem,
): { matchedPopular: string; distance: number } | null {
  const popular = loadPopularPackages(ecosystem);
  const cleanName = packageName.trim().toLowerCase();
  if (popular.some((p) => p.toLowerCase() === cleanName)) {
    return null;
  }

  let best: { matchedPopular: string; distance: number } | null = null;
  for (const pop of popular) {
    const popLower = pop.toLowerCase();
    if (Math.abs(popLower.length - cleanName.length) > 2) continue;
    const dist = levenshteinDistance(cleanName, popLower);
    if (dist >= 1 && dist <= 2 && cleanName.length >= 4) {
      if (!best || dist < best.distance) {
        best = { matchedPopular: pop, distance: dist };
      }
    }
  }
  return best;
}

// nyx-allow: hardcoded-url — official npm registry API endpoint
const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
// nyx-allow: hardcoded-url — official npm downloads API endpoint
const NPM_DOWNLOADS_BASE = "https://api.npmjs.org/downloads/point/last-week";
// nyx-allow: hardcoded-url — official PyPI JSON API endpoint
const PYPI_BASE = "https://pypi.org/pypi";
// nyx-allow: hardcoded-url — official crates.io API endpoint
const CRATES_BASE = "https://crates.io/api/v1/crates";
// nyx-allow: hardcoded-url — official Go module proxy endpoint
const GO_PROXY_BASE = "https://proxy.golang.org";
// nyx-allow: hardcoded-url — official RubyGems API endpoint
const RUBYGEMS_BASE = "https://rubygems.org/api/v1/gems";
// nyx-allow: hardcoded-url — official Packagist API endpoint
const PACKAGIST_BASE = "https://repo.packagist.org/p2";
// nyx-allow: hardcoded-url — official Maven Central search API endpoint
const MAVEN_SEARCH_BASE = "https://search.maven.org/solrsearch/select";
// nyx-allow: hardcoded-url — official NuGet flat-container API endpoint
const NUGET_BASE = "https://api.nuget.org/v3-flatcontainer";
// nyx-allow: hardcoded-url — official Hex API endpoint
const HEX_BASE = "https://hex.pm/api/packages";
// nyx-allow: hardcoded-url — official OSV query API endpoint
const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isJsonRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function firstRecord(value: unknown): JsonRecord | undefined {
  const entries = asArray(value);
  return entries ? asRecord(entries[0]) : undefined;
}

function toIsoString(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

type RegistryJsonResult = { kind: "missing" } | { kind: "ok"; data: unknown };

async function fetchRegistryJson(
  url: string,
  init?: RequestInit,
): Promise<RegistryJsonResult> {
  const res = await depGuardFetch()(url, init);
  if (res.status === 404 || res.status === 410) {
    return { kind: "missing" };
  }
  if (!res.ok) {
    throw new Error(`Registry request failed (${res.status}) for ${url}`);
  }
  try {
    return { kind: "ok", data: await res.json() };
  } catch {
    throw new Error(`Registry returned malformed JSON for ${url}`);
  }
}

function missingPackage(): PackageRegistryMetadata {
  return { exists: false, latestVersion: "0.0.0" };
}

export async function fetchRegistryMetadata(
  packageName: string,
  ecosystem: PackageEcosystem,
): Promise<PackageRegistryMetadata> {
  switch (ecosystem) {
    case "npm": {
      const result = await fetchRegistryJson(
        `${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}`,
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const distTags = asRecord(data["dist-tags"]);
      const latest = asString(distTags?.["latest"]) ?? "1.0.0";
      const time = asRecord(data["time"]);
      const versions = asRecord(data["versions"]);
      const latestMeta = asRecord(versions?.[latest]);
      const scripts = asRecord(latestMeta?.["scripts"]);
      const hasInstallScripts = Boolean(
        asString(scripts?.["preinstall"]) ||
          asString(scripts?.["install"]) ||
          asString(scripts?.["postinstall"]),
      );
      const createdStr =
        asString(time?.["created"]) ?? asString(time?.[latest]);

      let weeklyDownloads: number | undefined;
      try {
        const downloadsRes = await depGuardFetch()(
          `${NPM_DOWNLOADS_BASE}/${encodeURIComponent(packageName)}`,
        );
        if (downloadsRes.ok) {
          const downloadsData = asRecord(await downloadsRes.json());
          weeklyDownloads = asNumber(downloadsData?.["downloads"]);
        }
      } catch {
        // Optional enrichment: downloads lookup failure must not fail the audit.
      }

      return {
        exists: true,
        latestVersion: latest,
        ...(createdStr !== undefined ? { publishedAt: createdStr } : {}),
        ...(weeklyDownloads !== undefined ? { weeklyDownloads } : {}),
        hasInstallScripts,
        deprecated: Boolean(latestMeta?.["deprecated"]),
        hasRepositoryUrl: Boolean(latestMeta?.["repository"]),
      };
    }

    case "pypi": {
      const result = await fetchRegistryJson(
        `${PYPI_BASE}/${encodeURIComponent(packageName)}/json`,
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const info = asRecord(data["info"]);
      const firstUrl = firstRecord(data["urls"]);
      const publishedAt =
        asString(firstUrl?.["upload_time_iso_8601"]) ??
        asString(firstUrl?.["upload_time"]);
      const projectUrls = asRecord(info?.["project_urls"]);
      return {
        exists: true,
        latestVersion: asString(info?.["version"]) ?? "1.0.0",
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        hasRepositoryUrl: Boolean(asString(info?.["home_page"]) || projectUrls),
      };
    }

    case "crates": {
      const result = await fetchRegistryJson(
        `${CRATES_BASE}/${encodeURIComponent(packageName)}`,
        { headers: { "user-agent": "nyxowl" } },
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const crate = asRecord(data["crate"]);
      const recentDownloads = asNumber(crate?.["recent_downloads"]);
      const publishedAt = asString(crate?.["created_at"]);
      return {
        exists: true,
        latestVersion: asString(crate?.["max_version"]) ?? "0.0.0",
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        ...(recentDownloads !== undefined
          ? { weeklyDownloads: Math.floor(recentDownloads / 13) }
          : {}),
        hasRepositoryUrl: Boolean(asString(crate?.["repository"])),
      };
    }

    case "go": {
      const escapedModule = packageName.replace(/[A-Z]/g, (ch) => `!${ch.toLowerCase()}`);
      const result = await fetchRegistryJson(
        `${GO_PROXY_BASE}/${escapedModule}/@latest`,
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const publishedAt = asString(data["Time"]);
      return {
        exists: true,
        latestVersion: asString(data["Version"]) ?? "0.0.0",
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      };
    }

    case "rubygems": {
      const result = await fetchRegistryJson(
        `${RUBYGEMS_BASE}/${encodeURIComponent(packageName)}.json`,
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const publishedAt = asString(data["version_created_at"]);
      return {
        exists: true,
        latestVersion: asString(data["version"]) ?? "0.0.0",
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        hasRepositoryUrl: Boolean(
          asString(data["source_code_uri"]) || asString(data["homepage_uri"]),
        ),
      };
    }

    case "packagist": {
      const slash = packageName.indexOf("/");
      if (slash <= 0 || slash >= packageName.length - 1) return missingPackage();
      const vendor = packageName.slice(0, slash);
      const pkg = packageName.slice(slash + 1);
      const result = await fetchRegistryJson(
        `${PACKAGIST_BASE}/${encodeURIComponent(vendor)}/${encodeURIComponent(pkg)}.json`,
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const packages = asRecord(data["packages"]);
      const first = firstRecord(packages?.[packageName]);
      const source = asRecord(first?.["source"]);
      const publishedAt = asString(first?.["time"]);
      return {
        exists: true,
        latestVersion: asString(first?.["version"]) ?? "0.0.0",
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        hasRepositoryUrl: Boolean(asString(source?.["url"])),
      };
    }

    case "maven": {
      const colon = packageName.indexOf(":");
      const group = colon > 0 ? packageName.slice(0, colon) : packageName;
      const artifact = colon > 0 ? packageName.slice(colon + 1) : packageName;
      const query = `g:"${group}" AND a:"${artifact}"`;
      const result = await fetchRegistryJson(
        `${MAVEN_SEARCH_BASE}?q=${encodeURIComponent(query)}&rows=1&wt=json`,
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const response = asRecord(data["response"]);
      const first = firstRecord(response?.["docs"]);
      const publishedAt = toIsoString(asNumber(first?.["timestamp"]));
      return {
        exists: true,
        latestVersion: asString(first?.["latestVersion"]) ?? "0.0.0",
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      };
    }

    case "nuget": {
      const result = await fetchRegistryJson(
        `${NUGET_BASE}/${encodeURIComponent(packageName.toLowerCase())}/index.json`,
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const versions = asArray(data["versions"]);
      const lastVersion =
        versions && versions.length > 0
          ? asString(versions[versions.length - 1])
          : undefined;
      return {
        exists: true,
        latestVersion: lastVersion ?? "0.0.0",
      };
    }

    case "hex": {
      const result = await fetchRegistryJson(
        `${HEX_BASE}/${encodeURIComponent(packageName)}`,
      );
      if (result.kind === "missing") return missingPackage();
      const data = asRecord(result.data);
      if (!data) return missingPackage();
      const first = firstRecord(data["releases"]);
      const downloads = asRecord(data["downloads"]);
      const weeklyDownloads = asNumber(downloads?.["week"]);
      const meta = asRecord(data["meta"]);
      const links = asRecord(meta?.["links"]);
      const publishedAt = asString(first?.["inserted_at"]);
      return {
        exists: true,
        latestVersion: asString(first?.["version"]) ?? "0.0.0",
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        ...(weeklyDownloads !== undefined ? { weeklyDownloads } : {}),
        hasRepositoryUrl: Boolean(
          asString(links?.["GitHub"]) || asString(links?.["Repository"]),
        ),
      };
    }

    default:
      throw new Error(`Unsupported package ecosystem: ${String(ecosystem)}`);
  }
}

const OSV_ECOSYSTEM_MAP: Record<PackageEcosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  crates: "crates.io",
  go: "Go",
  rubygems: "RubyGems",
  packagist: "Packagist",
  maven: "Maven",
  nuget: "NuGet",
  hex: "Hex",
};

export async function queryOsvVulnerabilities(
  packageName: string,
  ecosystem: PackageEcosystem,
  version: string,
): Promise<string[]> {
  const res = await depGuardFetch()(OSV_QUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      package: { name: packageName, ecosystem: OSV_ECOSYSTEM_MAP[ecosystem] },
      version,
    }),
  });
  if (!res.ok) {
    throw new Error(`OSV API returned ${res.status}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("OSV API returned malformed JSON");
  }

  const root = asRecord(data);
  const vulns = asArray(root?.["vulns"]);
  if (!vulns) return [];
  const ids: string[] = [];
  for (const vuln of vulns) {
    const id = asRecord(vuln)?.["id"];
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

export function resolveOsvVersion(
  requestedVersion: string | undefined,
  latestVersion: string,
): string {
  return requestedVersion && requestedVersion !== "latest"
    ? requestedVersion
    : latestVersion;
}

const liveRegistryFetcher: RegistryFetcherFn = async (
  packageName,
  ecosystem,
  requestedVersion,
) => {
  const meta = await fetchRegistryMetadata(packageName, ecosystem);
  if (!meta.exists) return meta;
  const osvVersion = resolveOsvVersion(requestedVersion, meta.latestVersion);
  const osvVulnerabilities = await queryOsvVulnerabilities(
    packageName,
    ecosystem,
    osvVersion,
  );
  return { ...meta, osvVulnerabilities };
};

export const depGuardInputSchema = z.object({
  packages: z.array(z.string().min(1)).min(1),
  ecosystem: ecosystemSchema.default("npm"),
  repoPath: z.string().optional(),
});

export const depGuardOutputSchema = z.object({
  allApproved: z.boolean(),
  results: z.array(
    z.object({
      packageSpec: z.string(),
      packageName: z.string(),
      version: z.string(),
      approved: z.boolean(),
      findings: z.array(z.string()),
    }),
  ),
});

export function parsePackageSpec(spec: string): { name: string; version: string } {
  const trimmed = spec.trim();
  if (trimmed.startsWith("@")) {
    const secondAt = trimmed.indexOf("@", 1);
    if (secondAt > 1) {
      return {
        name: trimmed.slice(0, secondAt),
        version: trimmed.slice(secondAt + 1) || "latest",
      };
    }
    return { name: trimmed, version: "latest" };
  }
  const atIdx = trimmed.indexOf("@");
  if (atIdx > 0) {
    return {
      name: trimmed.slice(0, atIdx),
      version: trimmed.slice(atIdx + 1) || "latest",
    };
  }
  return { name: trimmed, version: "latest" };
}

export const nyxDepGuardTool = defineTool({
  name: "nyx_dep_guard",
  description: "Audits packages against typosquatting, age <30d, install scripts, OSV vulns, and fails closed offline.",
  annotations: {
    title: "Anti-Slopsquatting Package Guard",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: depGuardInputSchema,
  outputSchema: depGuardOutputSchema,
  handler: async (input, ctx) => {
    const fetcher = customRegistryFetcher ?? liveRegistryFetcher;
    const allowSet = new Set(ctx.config.deps.allow.map((s) => s.toLowerCase()));
    const denySet = new Set(ctx.config.deps.deny.map((s) => s.toLowerCase()));

    const results: Array<{
      packageSpec: string;
      packageName: string;
      version: string;
      approved: boolean;
      findings: string[];
    }> = [];

    for (const rawSpec of input.packages) {
      const { name, version } = parsePackageSpec(rawSpec);
      const findings: string[] = [];

      if (denySet.has(name.toLowerCase()) || denySet.has(rawSpec.toLowerCase())) {
        findings.push("explicitly-denied-by-config");
      }

      if (allowSet.has(name.toLowerCase()) || allowSet.has(rawSpec.toLowerCase())) {
        const pkgKey = `${input.ecosystem}:${name}@${version}`;
        ctx.db.withImmediateTransaction(() => {
          ctx.db.db
            .prepare(
              `INSERT INTO dep_approvals (pkg_key, package_name, version, ecosystem, approved, findings_json, created_at)
               VALUES (?, ?, ?, ?, 1, '[]', ?)
               ON CONFLICT(pkg_key) DO UPDATE SET approved = 1, findings_json = '[]', created_at = excluded.created_at`,
            )
            .run(pkgKey, name, version, input.ecosystem, new Date().toISOString());
        });
        results.push({
          packageSpec: rawSpec,
          packageName: name,
          version,
          approved: true,
          findings: [],
        });
        continue;
      }

      // 1. Check typosquat distance against popular packages
      const typo = findTyposquatMatch(name, input.ecosystem);
      if (typo) {
        findings.push(
          `typosquat: edit distance ${typo.distance} to popular package "${typo.matchedPopular}"`,
        );
      }

      // 2. Query registry (fail-closed when offline per §1.3.5)
      let meta: PackageRegistryMetadata;
      try {
        meta = await fetcher(name, input.ecosystem, version);
      } catch (err) {
        if (ctx.config.network.depGuard === "fail-closed") {
          throw new NyxError(
            "ERR_NETWORK_BLOCKED",
            `nyx_dep_guard failed closed (offline or registry unreachable for ${name}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        meta = { exists: true, latestVersion: version };
      }

      const resolvedVersion = version === "latest" ? meta.latestVersion : version;

      if (!meta.exists) {
        findings.push(`hallucinated-package: "${name}" does not exist on ${input.ecosystem}`);
      } else {
        if (meta.publishedAt) {
          const ageMs = Date.now() - new Date(meta.publishedAt).getTime();
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          if (ageDays < 30) {
            findings.push(`young-package: published ${Math.floor(ageDays)} days ago (< 30 days)`);
          }
        }
        if (meta.weeklyDownloads !== undefined && meta.weeklyDownloads < 100) {
          findings.push(`low-downloads: ${meta.weeklyDownloads} weekly downloads`);
        }
        if (meta.hasInstallScripts) {
          findings.push("install-scripts: package defines preinstall/install/postinstall scripts");
        }
        if (meta.deprecated) {
          findings.push("deprecated: package is marked deprecated");
        }
        if (meta.hasRepositoryUrl === false) {
          findings.push("missing-repo: package metadata has no repository link");
        }
        if (meta.osvVulnerabilities && meta.osvVulnerabilities.length > 0) {
          findings.push(`osv-vulnerability: ${meta.osvVulnerabilities.join(", ")}`);
        }
      }

      const approved = findings.length === 0;
      const pkgKey = `${input.ecosystem}:${name}@${resolvedVersion}`;
      const nowIso = new Date().toISOString();

      ctx.db.withImmediateTransaction(() => {
        ctx.db.db
          .prepare(
            `INSERT INTO dep_approvals (pkg_key, package_name, version, ecosystem, approved, findings_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(pkg_key) DO UPDATE SET
               approved = excluded.approved,
               findings_json = excluded.findings_json,
               created_at = excluded.created_at`,
          )
          .run(
            pkgKey,
            name,
            resolvedVersion,
            input.ecosystem,
            approved ? 1 : 0,
            JSON.stringify(findings),
            nowIso,
          );
      });

      results.push({
        packageSpec: rawSpec,
        packageName: name,
        version: resolvedVersion,
        approved,
        findings,
      });
    }

    return {
      allApproved: results.every((r) => r.approved),
      results,
    };
  },
});

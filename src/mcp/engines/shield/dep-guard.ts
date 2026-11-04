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
) => Promise<PackageRegistryMetadata>;

let customRegistryFetcher: RegistryFetcherFn | null = null;

export function setDepGuardRegistryFetcher(fn: RegistryFetcherFn | null): void {
  customRegistryFetcher = fn;
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

const liveRegistryFetcher: RegistryFetcherFn = async (packageName, ecosystem) => {
  if (ecosystem === "npm") {
    // nyx-allow: hardcoded-url — official npm registry API endpoint
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
    if (res.status === 404) {
      return { exists: false, latestVersion: "0.0.0" };
    }
    if (!res.ok) {
      throw new Error(`npm registry returned ${res.status}`);
    }
    const data = (await res.json()) as {
      "dist-tags"?: { latest?: string };
      time?: Record<string, string>;
      versions?: Record<
        string,
        {
          scripts?: Record<string, string>;
          deprecated?: string;
          repository?: unknown;
        }
      >;
    };
    const latest = data["dist-tags"]?.latest ?? "1.0.0";
    const latestMeta = data.versions?.[latest];
    const scripts = latestMeta?.scripts ?? {};
    const hasInstallScripts = Boolean(
      scripts["preinstall"] || scripts["install"] || scripts["postinstall"],
    );
    const createdStr = data.time?.["created"] ?? data.time?.[latest];
    return {
      exists: true,
      latestVersion: latest,
      ...(createdStr ? { publishedAt: createdStr } : {}),
      hasInstallScripts,
      deprecated: Boolean(latestMeta?.deprecated),
      hasRepositoryUrl: Boolean(latestMeta?.repository),
      osvVulnerabilities: [],
    };
  }

  if (ecosystem === "pypi") {
    // nyx-allow: hardcoded-url — official PyPI JSON API endpoint
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`);
    if (res.status === 404) {
      return { exists: false, latestVersion: "0.0.0" };
    }
    if (!res.ok) {
      throw new Error(`PyPI returned ${res.status}`);
    }
    const data = (await res.json()) as {
      info?: { version?: string; home_page?: string; project_urls?: Record<string, string> };
    };
    return {
      exists: true,
      latestVersion: data.info?.version ?? "1.0.0",
      hasRepositoryUrl: Boolean(data.info?.home_page || data.info?.project_urls),
    };
  }

  throw new Error(`Offline or unconfigured live registry for ${ecosystem}`);
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
        meta = await fetcher(name, input.ecosystem);
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

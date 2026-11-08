import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchRegistryMetadata,
  findTyposquatMatch,
  levenshteinDistance,
  parsePackageSpec,
  queryOsvVulnerabilities,
  resolveOsvVersion,
  setDepGuardFetchImpl,
  setDepGuardRegistryFetcher,
  type PackageEcosystem,
  type PackageRegistryMetadata,
} from "../../src/mcp/engines/shield/dep-guard.ts";
import { nyxDepGuardTool } from "../../src/mcp/engines/shield/index.ts";
import { invokeToolDefinition } from "../../src/mcp/tool.ts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface Route {
  match: string;
  body: unknown;
  status?: number;
}

interface EcosystemCase {
  ecosystem: PackageEcosystem;
  packageName: string;
  routes: Route[];
  latestVersion: string;
  check: (meta: PackageRegistryMetadata) => void;
}

interface OsvRequestBody {
  package?: { name?: string; ecosystem?: string };
  version?: string;
}

interface CapturedRequest {
  url: string;
  method: string | undefined;
  body: OsvRequestBody | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function routedFetch(routes: Route[]): typeof fetch {
  return async (input) => {
    const url = requestUrl(input);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    return jsonResponse(route.body, route.status ?? 200);
  };
}

function capturingFetch(
  captured: CapturedRequest[],
  responseBody: unknown,
  status = 200,
): typeof fetch {
  return async (input, init: FetchInit) => {
    captured.push({
      url: requestUrl(input),
      method: init?.method,
      body:
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as OsvRequestBody),
    });
    return jsonResponse(responseBody, status);
  };
}

const ecosystemCases: EcosystemCase[] = [
  {
    ecosystem: "npm",
    packageName: "zod",
    latestVersion: "3.23.8",
    routes: [
      {
        match: "registry.npmjs.org/zod",
        body: {
          "dist-tags": { latest: "3.23.8" },
          time: {
            created: "2020-01-01T00:00:00.000Z",
            "3.23.8": "2024-05-01T00:00:00.000Z",
          },
          versions: {
            "3.23.8": {
              scripts: { postinstall: "node setup.js" },
              deprecated: "use zod v4",
              repository: { type: "git", url: "https://github.com/colinhacks/zod" },
            },
          },
        },
      },
      {
        match: "api.npmjs.org/downloads/point/last-week/zod",
        body: { downloads: 5_000_000 },
      },
    ],
    check: (meta) => {
      expect(meta.publishedAt).toBe("2020-01-01T00:00:00.000Z");
      expect(meta.hasInstallScripts).toBe(true);
      expect(meta.deprecated).toBe(true);
      expect(meta.hasRepositoryUrl).toBe(true);
      expect(meta.weeklyDownloads).toBe(5_000_000);
    },
  },
  {
    ecosystem: "pypi",
    packageName: "requests",
    latestVersion: "2.32.3",
    routes: [
      {
        match: "pypi.org/pypi/requests/json",
        body: {
          info: {
            version: "2.32.3",
            home_page: "https://requests.readthedocs.io",
            project_urls: { Source: "https://github.com/psf/requests" },
          },
          urls: [
            {
              upload_time_iso_8601: "2024-05-20T00:00:00.000Z",
              upload_time: "2024-05-20T00:00:00",
            },
          ],
        },
      },
    ],
    check: (meta) => {
      expect(meta.publishedAt).toBe("2024-05-20T00:00:00.000Z");
      expect(meta.hasRepositoryUrl).toBe(true);
    },
  },
  {
    ecosystem: "crates",
    packageName: "serde",
    latestVersion: "1.0.203",
    routes: [
      {
        match: "crates.io/api/v1/crates/serde",
        body: {
          crate: {
            max_version: "1.0.203",
            created_at: "2014-12-01T00:00:00.000Z",
            recent_downloads: 1_300_000,
            repository: "https://github.com/serde-rs/serde",
          },
        },
      },
    ],
    check: (meta) => {
      expect(meta.publishedAt).toBe("2014-12-01T00:00:00.000Z");
      expect(meta.weeklyDownloads).toBe(100_000);
      expect(meta.hasRepositoryUrl).toBe(true);
    },
  },
  {
    ecosystem: "go",
    packageName: "github.com/BurntSushi/toml",
    latestVersion: "v1.4.0",
    routes: [
      {
        match: "proxy.golang.org/github.com/!burnt!sushi/toml/@latest",
        body: { Version: "v1.4.0", Time: "2024-05-01T00:00:00Z" },
      },
    ],
    check: (meta) => {
      expect(meta.publishedAt).toBe("2024-05-01T00:00:00Z");
    },
  },
  {
    ecosystem: "rubygems",
    packageName: "rails",
    latestVersion: "7.1.3",
    routes: [
      {
        match: "rubygems.org/api/v1/gems/rails.json",
        body: {
          version: "7.1.3",
          version_created_at: "2024-01-16T00:00:00.000Z",
          source_code_uri: "https://github.com/rails/rails",
          homepage_uri: "https://rubyonrails.org",
        },
      },
    ],
    check: (meta) => {
      expect(meta.publishedAt).toBe("2024-01-16T00:00:00.000Z");
      expect(meta.hasRepositoryUrl).toBe(true);
    },
  },
  {
    ecosystem: "packagist",
    packageName: "symfony/console",
    latestVersion: "v7.1.1",
    routes: [
      {
        match: "repo.packagist.org/p2/symfony/console.json",
        body: {
          packages: {
            "symfony/console": [
              {
                version: "v7.1.1",
                time: "2024-06-01T00:00:00+00:00",
                source: { url: "https://github.com/symfony/console.git" },
              },
            ],
          },
        },
      },
    ],
    check: (meta) => {
      expect(meta.publishedAt).toBe("2024-06-01T00:00:00+00:00");
      expect(meta.hasRepositoryUrl).toBe(true);
    },
  },
  {
    ecosystem: "maven",
    packageName: "org.springframework:spring-core",
    latestVersion: "6.1.8",
    routes: [
      {
        match: "search.maven.org/solrsearch/select",
        body: {
          response: {
            docs: [{ latestVersion: "6.1.8", timestamp: 1_717_200_000_000 }],
          },
        },
      },
    ],
    check: (meta) => {
      expect(meta.publishedAt).toBe(new Date(1_717_200_000_000).toISOString());
    },
  },
  {
    ecosystem: "nuget",
    packageName: "Newtonsoft.Json",
    latestVersion: "13.0.3",
    routes: [
      {
        match: "api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json",
        body: { versions: ["12.0.1", "13.0.3"] },
      },
    ],
    check: () => {
      // nuget only exposes a version list; latestVersion is asserted by the shared check.
    },
  },
  {
    ecosystem: "hex",
    packageName: "phoenix",
    latestVersion: "1.7.14",
    routes: [
      {
        match: "hex.pm/api/packages/phoenix",
        body: {
          releases: [{ version: "1.7.14", inserted_at: "2024-06-01T00:00:00Z" }],
          downloads: { week: 123_456 },
          meta: {
            links: { GitHub: "https://github.com/phoenixframework/phoenix" },
          },
        },
      },
    ],
    check: (meta) => {
      expect(meta.publishedAt).toBe("2024-06-01T00:00:00Z");
      expect(meta.weeklyDownloads).toBe(123_456);
      expect(meta.hasRepositoryUrl).toBe(true);
    },
  },
];

describe("nyx_dep_guard registry metadata", () => {
  afterEach(() => {
    setDepGuardFetchImpl(null);
    setDepGuardRegistryFetcher(null);
  });

  it.each(ecosystemCases)(
    "fetches $ecosystem metadata",
    async (testCase) => {
      setDepGuardFetchImpl(routedFetch(testCase.routes));
      const meta = await fetchRegistryMetadata(
        testCase.packageName,
        testCase.ecosystem,
      );
      expect(meta.exists).toBe(true);
      expect(meta.latestVersion).toBe(testCase.latestVersion);
      testCase.check(meta);
    },
  );

  it("treats npm and nuget 404 responses as missing packages", async () => {
    setDepGuardFetchImpl(
      routedFetch([
        { match: "registry.npmjs.org/ghost", body: {}, status: 404 },
        {
          match: "api.nuget.org/v3-flatcontainer/ghost/index.json",
          body: {},
          status: 410,
        },
      ]),
    );

    await expect(fetchRegistryMetadata("ghost", "npm")).resolves.toEqual({
      exists: false,
      latestVersion: "0.0.0",
    });
    await expect(fetchRegistryMetadata("Ghost", "nuget")).resolves.toEqual({
      exists: false,
      latestVersion: "0.0.0",
    });
  });

  it("does not crash on unknown or malformed payloads", async () => {
    setDepGuardFetchImpl(async () => jsonResponse(null));
    await expect(fetchRegistryMetadata("mystery", "npm")).resolves.toEqual({
      exists: false,
      latestVersion: "0.0.0",
    });

    setDepGuardFetchImpl(async () => new Response("not json", { status: 200 }));
    await expect(fetchRegistryMetadata("mystery", "npm")).rejects.toThrow(
      /malformed JSON/,
    );
  });
});

describe("queryOsvVulnerabilities", () => {
  afterEach(() => {
    setDepGuardFetchImpl(null);
    setDepGuardRegistryFetcher(null);
  });

  it("maps ecosystem names and returns string vulnerability IDs", async () => {
    const captured: CapturedRequest[] = [];
    setDepGuardFetchImpl(
      capturingFetch(captured, { vulns: [{ id: "OSV-1" }, { id: 7 }, {}] }),
    );

    const ecosystems: PackageEcosystem[] = [
      "npm",
      "pypi",
      "crates",
      "go",
      "rubygems",
      "packagist",
      "maven",
      "nuget",
      "hex",
    ];
    const expectedMappings = [
      "npm",
      "PyPI",
      "crates.io",
      "Go",
      "RubyGems",
      "Packagist",
      "Maven",
      "NuGet",
      "Hex",
    ];

    for (const ecosystem of ecosystems) {
      await expect(
        queryOsvVulnerabilities("example", ecosystem, "1.2.3"),
      ).resolves.toEqual(["OSV-1"]);
    }

    expect(captured).toHaveLength(ecosystems.length);
    expect(captured.map((request) => request.body?.package?.ecosystem)).toEqual(
      expectedMappings,
    );
    for (const request of captured) {
      expect(request.url).toBe("https://api.osv.dev/v1/query");
      expect(request.method).toBe("POST");
      expect(request.body?.package?.name).toBe("example");
      expect(request.body?.version).toBe("1.2.3");
    }
  });

  it("rejects when OSV returns a non-ok response", async () => {
    setDepGuardFetchImpl(async () => jsonResponse({ error: "unavailable" }, 503));
    await expect(
      queryOsvVulnerabilities("zod", "npm", "1.0.0"),
    ).rejects.toThrow(/OSV API returned 503/);
  });
});

describe("nyx_dep_guard tool integration", () => {
  afterEach(() => {
    setDepGuardFetchImpl(null);
    setDepGuardRegistryFetcher(null);
  });

  it("surfaces OSV vulnerabilities as findings through the live fetcher", async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-dep-guard-repo-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-dep-guard-home-"));

    try {
      setDepGuardRegistryFetcher(null);
      setDepGuardFetchImpl(
        routedFetch([
          {
            match: "registry.npmjs.org/zod",
            body: {
              "dist-tags": { latest: "3.23.8" },
              time: {
                created: "2020-01-01T00:00:00.000Z",
                "3.23.8": "2024-05-01T00:00:00.000Z",
              },
              versions: {
                "3.23.8": {
                  repository: {
                    type: "git",
                    url: "https://github.com/colinhacks/zod",
                  },
                },
              },
            },
          },
          {
            match: "api.npmjs.org/downloads/point/last-week/zod",
            body: { downloads: 5_000_000 },
          },
          {
            match: "api.osv.dev/v1/query",
            body: { vulns: [{ id: "OSV-1" }] },
          },
        ]),
      );

      const res = await invokeToolDefinition(
        nyxDepGuardTool,
        { packages: ["zod"], ecosystem: "npm", repoPath: repoDir },
        { defaultProjectPath: repoDir, nyxHome: homeDir },
      );

      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as {
        results: Array<{ findings: string[] }>;
      };
      expect(data.results[0]?.findings).toContain("osv-vulnerability: OSV-1");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});


describe("resolveOsvVersion", () => {
  it("prefers an explicit requested version over the registry latest", () => {
    expect(resolveOsvVersion("3.22.4", "3.23.8")).toBe("3.22.4");
    expect(resolveOsvVersion("latest", "3.23.8")).toBe("3.23.8");
    expect(resolveOsvVersion(undefined, "3.23.8")).toBe("3.23.8");
  });
});

describe("dep-guard pure helpers", () => {
  it("computes Levenshtein distance including empty and case-insensitive inputs", () => {
    expect(levenshteinDistance("zod", "zod")).toBe(0);
    expect(levenshteinDistance("ZOD", "zod")).toBe(0);
    expect(levenshteinDistance("", "react")).toBe(5);
    expect(levenshteinDistance("react", "")).toBe(5);
    expect(levenshteinDistance("zodd", "zod")).toBe(1);
    expect(levenshteinDistance("reac", "react")).toBe(1);
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });

  it("detects typosquats only for near-length, non-exact popular names", () => {
    expect(findTyposquatMatch("zod", "npm")).toBeNull();
    expect(findTyposquatMatch(" ZOD ", "npm")).toBeNull();
    expect(findTyposquatMatch("zodd", "npm")).toEqual({
      matchedPopular: "zod",
      distance: 1,
    });
    expect(findTyposquatMatch("reac", "npm")).toEqual({
      matchedPopular: "react",
      distance: 1,
    });
    // Too short: no typo classification below 4 characters.
    expect(findTyposquatMatch("abc", "npm")).toBeNull();
    expect(findTyposquatMatch("this-name-is-nothing-like-a-popular-package", "npm")).toBeNull();
  });

  it("parses plain, scoped, and versioned package specs", () => {
    expect(parsePackageSpec("zod")).toEqual({ name: "zod", version: "latest" });
    expect(parsePackageSpec("zod@3.23.8")).toEqual({ name: "zod", version: "3.23.8" });
    expect(parsePackageSpec("zod@")).toEqual({ name: "zod", version: "latest" });
    expect(parsePackageSpec("@scope/pkg")).toEqual({
      name: "@scope/pkg",
      version: "latest",
    });
    expect(parsePackageSpec("@scope/pkg@1.2.3")).toEqual({
      name: "@scope/pkg",
      version: "1.2.3",
    });
    expect(parsePackageSpec("@scope/pkg@")).toEqual({
      name: "@scope/pkg",
      version: "latest",
    });
    expect(parsePackageSpec("  padded@1.0.0  ")).toEqual({
      name: "padded",
      version: "1.0.0",
    });
  });
});

describe("fetchRegistryMetadata missing and sparse payloads", () => {
  const ecosystems: PackageEcosystem[] = [
    "npm",
    "pypi",
    "crates",
    "go",
    "rubygems",
    "packagist",
    "maven",
    "nuget",
    "hex",
  ];
  const names: Record<PackageEcosystem, string> = {
    npm: "ghost",
    pypi: "ghost",
    crates: "ghost",
    go: "example.com/ghost",
    rubygems: "ghost",
    packagist: "vendor/ghost",
    maven: "group:ghost",
    nuget: "Ghost",
    hex: "ghost",
  };

  afterEach(() => {
    setDepGuardFetchImpl(null);
  });

  it.each(ecosystems)("treats a 404/410 as a missing %s package", async (ecosystem) => {
    setDepGuardFetchImpl(async () => new Response("{}", { status: 404 }));
    await expect(fetchRegistryMetadata(names[ecosystem], ecosystem)).resolves.toEqual({
      exists: false,
      latestVersion: "0.0.0",
    });
  });

  it.each(ecosystems)("treats a non-object %s payload as missing", async (ecosystem) => {
    setDepGuardFetchImpl(async () => jsonResponse(null));
    await expect(fetchRegistryMetadata(names[ecosystem], ecosystem)).resolves.toEqual({
      exists: false,
      latestVersion: "0.0.0",
    });
  });

  it("throws for non-ok registry responses", async () => {
    setDepGuardFetchImpl(async () => new Response("{}", { status: 500 }));
    await expect(fetchRegistryMetadata("zod", "npm")).rejects.toThrow(
      /Registry request failed \(500\)/,
    );
  });

  it("fills npm defaults when dist-tags, time, and downloads are absent", async () => {
    setDepGuardFetchImpl(
      routedFetch([
        {
          match: "registry.npmjs.org/zod",
          body: { versions: { "1.0.0": {} } },
        },
        {
          match: "api.npmjs.org/downloads/point/last-week/zod",
          body: { error: "nope" },
          status: 500,
        },
      ]),
    );
    await expect(fetchRegistryMetadata("zod", "npm")).resolves.toEqual({
      exists: true,
      latestVersion: "1.0.0",
      hasInstallScripts: false,
      deprecated: false,
      hasRepositoryUrl: false,
    });
  });

  it("falls back to the latest version timestamp and detects preinstall scripts", async () => {
    setDepGuardFetchImpl(
      routedFetch([
        {
          match: "registry.npmjs.org/zod",
          body: {
            "dist-tags": { latest: "2.0.0" },
            time: { "2.0.0": "2020-02-02T00:00:00.000Z" },
            versions: {
              "2.0.0": {
                scripts: { preinstall: "node pre.js" },
                repository: { url: "https://github.com/colinhacks/zod" },
                deprecated: "",
              },
            },
          },
        },
        {
          match: "api.npmjs.org/downloads/point/last-week/zod",
          body: { downloads: 42 },
        },
      ]),
    );
    const meta = await fetchRegistryMetadata("zod", "npm");
    expect(meta.publishedAt).toBe("2020-02-02T00:00:00.000Z");
    expect(meta.hasInstallScripts).toBe(true);
    expect(meta.deprecated).toBe(false);
    expect(meta.weeklyDownloads).toBe(42);
    expect(meta.hasRepositoryUrl).toBe(true);
  });

  it("handles pypi upload_time fallback and missing metadata", async () => {
    setDepGuardFetchImpl(
      routedFetch([
        {
          match: "pypi.org/pypi/requests/json",
          body: {
            info: {},
            urls: [{ upload_time: "2021-01-01T00:00:00" }],
          },
        },
      ]),
    );
    const meta = await fetchRegistryMetadata("requests", "pypi");
    expect(meta.latestVersion).toBe("1.0.0");
    expect(meta.publishedAt).toBe("2021-01-01T00:00:00");
    expect(meta.hasRepositoryUrl).toBe(false);

    setDepGuardFetchImpl(async () => jsonResponse({ info: { project_urls: {} } }));
    const sparse = await fetchRegistryMetadata("requests", "pypi");
    expect(sparse.publishedAt).toBeUndefined();
    expect(sparse.hasRepositoryUrl).toBe(true);
  });

  it("handles sparse crates, go, rubygems, and hex payloads", async () => {
    setDepGuardFetchImpl(async () => jsonResponse({ crate: {} }));
    await expect(fetchRegistryMetadata("serde", "crates")).resolves.toEqual({
      exists: true,
      latestVersion: "0.0.0",
      hasRepositoryUrl: false,
    });

    setDepGuardFetchImpl(async () => jsonResponse({}));
    await expect(fetchRegistryMetadata("example.com/ghost", "go")).resolves.toEqual({
      exists: true,
      latestVersion: "0.0.0",
    });

    setDepGuardFetchImpl(async () => jsonResponse({}));
    await expect(fetchRegistryMetadata("rails", "rubygems")).resolves.toEqual({
      exists: true,
      latestVersion: "0.0.0",
      hasRepositoryUrl: false,
    });

    setDepGuardFetchImpl(async () => jsonResponse({ homepage_uri: "https://rubyonrails.org" }));
    const homepage = await fetchRegistryMetadata("rails", "rubygems");
    expect(homepage.hasRepositoryUrl).toBe(true);

    setDepGuardFetchImpl(async () => jsonResponse({}));
    await expect(fetchRegistryMetadata("phoenix", "hex")).resolves.toEqual({
      exists: true,
      latestVersion: "0.0.0",
      hasRepositoryUrl: false,
    });
  });

  it("rejects malformed packagist names without fetching", async () => {
    let calls = 0;
    setDepGuardFetchImpl(async () => {
      calls++;
      return jsonResponse({});
    });
    for (const name of ["noslash", "/leading", "trailing/"]) {
      await expect(fetchRegistryMetadata(name, "packagist")).resolves.toEqual({
        exists: false,
        latestVersion: "0.0.0",
      });
    }
    expect(calls).toBe(0);

    setDepGuardFetchImpl(async () => jsonResponse({ packages: {} }));
    await expect(fetchRegistryMetadata("vendor/pkg", "packagist")).resolves.toEqual({
      exists: true,
      latestVersion: "0.0.0",
      hasRepositoryUrl: false,
    });
  });

  it("supports maven coordinates without a colon and rejects invalid timestamps", async () => {
    const urls: string[] = [];
    setDepGuardFetchImpl(async (input) => {
      urls.push(requestUrl(input));
      return jsonResponse({ response: { docs: [] } });
    });
    await expect(fetchRegistryMetadata("plainartifact", "maven")).resolves.toEqual({
      exists: true,
      latestVersion: "0.0.0",
    });
    expect(urls[0]).toContain(encodeURIComponent('g:"plainartifact" AND a:"plainartifact"'));

    setDepGuardFetchImpl(async () =>
      jsonResponse({ response: { docs: [{ latestVersion: "1.0.0", timestamp: 1e300 }] } }),
    );
    const invalidDate = await fetchRegistryMetadata("group:artifact", "maven");
    expect(invalidDate.publishedAt).toBeUndefined();
  });

  it("handles empty nuget version lists", async () => {
    setDepGuardFetchImpl(async () => jsonResponse({ versions: [] }));
    await expect(fetchRegistryMetadata("Ghost", "nuget")).resolves.toEqual({
      exists: true,
      latestVersion: "0.0.0",
    });

    setDepGuardFetchImpl(async () => jsonResponse({}));
    await expect(fetchRegistryMetadata("Ghost", "nuget")).resolves.toEqual({
      exists: true,
      latestVersion: "0.0.0",
    });
  });

  it("rejects unsupported ecosystems", async () => {
    await expect(
      fetchRegistryMetadata("thing", "cargo" as PackageEcosystem),
    ).rejects.toThrow(/Unsupported package ecosystem/);
  });
});

describe("queryOsvVulnerabilities malformed payloads", () => {
  afterEach(() => {
    setDepGuardFetchImpl(null);
  });

  it("returns an empty list when vulns is absent or not an array", async () => {
    setDepGuardFetchImpl(async () => jsonResponse({ vulns: "nope" }));
    await expect(queryOsvVulnerabilities("zod", "npm", "1.0.0")).resolves.toEqual([]);

    setDepGuardFetchImpl(async () => jsonResponse([]));
    await expect(queryOsvVulnerabilities("zod", "npm", "1.0.0")).resolves.toEqual([]);
  });

  it("throws on malformed JSON", async () => {
    setDepGuardFetchImpl(async () => new Response("not json", { status: 200 }));
    await expect(queryOsvVulnerabilities("zod", "npm", "1.0.0")).rejects.toThrow(
      /malformed JSON/,
    );
  });
});

describe("nyx_dep_guard tool policy and finding branches", () => {
  afterEach(() => {
    setDepGuardFetchImpl(null);
    setDepGuardRegistryFetcher(null);
  });

  function makeRepo(prefix: string, config?: unknown): { repoDir: string; homeDir: string } {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), `nyx-dep-guard-${prefix}-`));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `nyx-dep-guard-${prefix}-home-`));
    if (config !== undefined) {
      fs.mkdirSync(path.join(repoDir, ".nyxowl"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".nyxowl", "config.json"),
        JSON.stringify(config),
      );
    }
    return { repoDir, homeDir };
  }

  async function run(
    packages: string[],
    repoDir: string,
    homeDir: string,
  ): Promise<{
    allApproved: boolean;
    results: Array<{ version: string; approved: boolean; findings: string[] }>;
  }> {
    const res = await invokeToolDefinition(
      nyxDepGuardTool,
      { packages, ecosystem: "npm", repoPath: repoDir },
      { defaultProjectPath: repoDir, nyxHome: homeDir },
    );
    expect(res.isError).toBeFalsy();
    return res.structuredContent as {
      allApproved: boolean;
      results: Array<{ version: string; approved: boolean; findings: string[] }>;
    };
  }

  it("records explicit deny findings and deny-by-raw-spec", async () => {
    const { repoDir, homeDir } = makeRepo("deny", {
      deps: { deny: ["evilpkg", "badpkg@1.0.0"] },
    });
    setDepGuardRegistryFetcher(async () => ({
      exists: true,
      latestVersion: "1.0.0",
      publishedAt: "2020-01-01T00:00:00.000Z",
      weeklyDownloads: 10_000,
      hasRepositoryUrl: true,
    }));
    try {
      const data = await run(["evilpkg", "badpkg@1.0.0"], repoDir, homeDir);
      expect(data.allApproved).toBe(false);
      expect(data.results[0]?.findings).toContain("explicitly-denied-by-config");
      expect(data.results[1]?.findings).toContain("explicitly-denied-by-config");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("approves allow-listed packages without querying the registry", async () => {
    const { repoDir, homeDir } = makeRepo("allow", {
      deps: { allow: ["safe-pkg", "pinned@2.0.0"] },
    });
    setDepGuardRegistryFetcher(async () => {
      throw new Error("registry must not be called for allow-listed packages");
    });
    try {
      const data = await run(["safe-pkg", "pinned@2.0.0"], repoDir, homeDir);
      expect(data.allApproved).toBe(true);
      expect(data.results[0]?.findings).toEqual([]);
      expect(data.results[0]?.version).toBe("latest");
      expect(data.results[1]?.version).toBe("2.0.0");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("fails open only when depGuard policy is warn", async () => {
    const { repoDir, homeDir } = makeRepo("warn", {
      network: { depGuard: "warn" },
    });
    setDepGuardRegistryFetcher(async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const data = await run(["zod@1.2.3"], repoDir, homeDir);
      expect(data.allApproved).toBe(true);
      expect(data.results[0]?.version).toBe("1.2.3");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("flags hallucinated packages and sparse metadata findings", async () => {
    const { repoDir, homeDir } = makeRepo("findings");
    try {
      setDepGuardRegistryFetcher(async () => ({
        exists: false,
        latestVersion: "0.0.0",
      }));
      const missing = await run(["ghost-package"], repoDir, homeDir);
      expect(missing.results[0]?.findings).toEqual([
        'hallucinated-package: "ghost-package" does not exist on npm',
      ]);

      setDepGuardRegistryFetcher(async () => ({
        exists: true,
        latestVersion: "1.0.0",
        publishedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        weeklyDownloads: 99,
        deprecated: true,
        hasRepositoryUrl: false,
        osvVulnerabilities: ["OSV-1", "OSV-2"],
      }));
      const flagged = await run(["zod"], repoDir, homeDir);
      const findings = flagged.results[0]?.findings ?? [];
      expect(findings).toContain("low-downloads: 99 weekly downloads");
      expect(findings).toContain("deprecated: package is marked deprecated");
      expect(findings).toContain("missing-repo: package metadata has no repository link");
      expect(findings).toContain("osv-vulnerability: OSV-1, OSV-2");
      expect(findings.some((f) => f.startsWith("young-package"))).toBe(false);
      expect(flagged.results[0]?.approved).toBe(false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("ignores exactly-at-threshold downloads, old packages, and empty OSV lists", async () => {
    const { repoDir, homeDir } = makeRepo("thresholds");
    try {
      setDepGuardRegistryFetcher(async () => ({
        exists: true,
        latestVersion: "1.0.0",
        publishedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
        weeklyDownloads: 100,
        hasRepositoryUrl: true,
        osvVulnerabilities: [],
      }));
      const data = await run(["zod"], repoDir, homeDir);
      expect(data.allApproved).toBe(true);
      expect(data.results[0]?.findings).toEqual([]);

      setDepGuardRegistryFetcher(async () => ({
        exists: true,
        latestVersion: "1.0.0",
        publishedAt: "not-a-date",
        weeklyDownloads: 100,
        hasRepositoryUrl: true,
      }));
      const invalidDate = await run(["zod"], repoDir, homeDir);
      expect(invalidDate.allApproved).toBe(true);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("nyx_dep_guard OSV version selection", () => {
  afterEach(() => {
    setDepGuardFetchImpl(null);
    setDepGuardRegistryFetcher(null);
  });

  it("sends the requested version to OSV and falls back to latest", async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-dep-guard-osv-"));
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nyx-dep-guard-osv-home-"),
    );

    try {
      const osvVersions: string[] = [];
      const baseFetch = routedFetch([
        {
          match: "registry.npmjs.org/zod",
          body: {
            "dist-tags": { latest: "3.23.8" },
            time: { created: "2020-01-01T00:00:00.000Z" },
            versions: {
              "3.23.8": {
                repository: {
                  type: "git",
                  url: "https://github.com/colinhacks/zod",
                },
              },
            },
          },
        },
        {
          match: "api.npmjs.org/downloads/point/last-week/zod",
          body: { downloads: 5_000_000 },
        },
        {
          match: "api.osv.dev/v1/query",
          body: { vulns: [{ id: "OSV-1" }] },
        },
      ]);

      setDepGuardFetchImpl(async (input, init) => {
        if (requestUrl(input).includes("api.osv.dev")) {
          const body = JSON.parse(String(init?.body)) as OsvRequestBody;
          if (body.version !== undefined) osvVersions.push(body.version);
        }
        return baseFetch(input, init);
      });

      const pinned = await invokeToolDefinition(
        nyxDepGuardTool,
        { packages: ["zod@3.22.4"], ecosystem: "npm", repoPath: repoDir },
        { defaultProjectPath: repoDir, nyxHome: homeDir },
      );
      expect(pinned.isError).toBeFalsy();
      expect(osvVersions).toEqual(["3.22.4"]);

      const latest = await invokeToolDefinition(
        nyxDepGuardTool,
        { packages: ["zod"], ecosystem: "npm", repoPath: repoDir },
        { defaultProjectPath: repoDir, nyxHome: homeDir },
      );
      expect(latest.isError).toBeFalsy();
      expect(osvVersions).toEqual(["3.22.4", "3.23.8"]);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

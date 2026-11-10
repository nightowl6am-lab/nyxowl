import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type NyxConfig } from "../../src/core/config.ts";
import { execCommand } from "../../src/core/exec.ts";
import { computeRepoId, getHeadTreeHash } from "../../src/core/git.ts";
import { ensureProjectLayout } from "../../src/core/paths.ts";
import {
  ensureReceiptKey,
  generateUlid,
  signReceipt,
  type ReceiptKind,
} from "../../src/core/receipts.ts";
import { nyxExploitProbeTool } from "../../src/mcp/engines/probe-exploit/index.ts";
import {
  isValidHealthRoute,
  preflightTarget,
} from "../../src/mcp/engines/probe-exploit/exploit/index.ts";
import {
  detectUnsupportedDbLayers,
  extractDbQueries,
  extractDbRoutines,
  SQL_RESERVED_WORDS,
} from "../../src/mcp/engines/seam/extractors/db-queries.ts";
import {
  extractServerCandidates,
  serverCandidateSummary,
} from "../../src/mcp/engines/seam/extractors/server-layers.ts";
import { listSeamFiles } from "../../src/mcp/engines/seam/ignore.ts";
import { nyxEnvInspectTool } from "../../src/mcp/engines/shield/env-inspect.ts";
import {
  extractAllowSuppressionsFromDiff,
  formatCoverageCell,
  isRedlineCiPath,
  nyxWorktreePrTool,
  renderCoverageAndLimitationsSection,
  type VerifiedReceiptView,
} from "../../src/mcp/engines/worktree-slice/pr-gate.ts";
import {
  detectLockfileInstallCommand,
  linkEnvFiles,
  provisionWorktree,
} from "../../src/mcp/engines/worktree-slice/provision.ts";
import {
  scanContentForSecrets,
  scanDiffForSecrets,
} from "../../src/mcp/engines/worktree-slice/secret-scan.ts";
import { StateDb } from "../../src/mcp/db/sqlite.ts";
import {
  invokeToolDefinition,
  type ToolDefinition,
  type ToolExecutionContext,
} from "../../src/mcp/tool.ts";

/**
 * Branch-coverage regression tests for src/mcp/engines/**.
 *
 * Every fixture lives in a throwaway temp directory. No real project, no
 * network egress (only loopback 127.0.0.1 servers), and no .env values ever
 * appear in assertions.
 */

function mkTmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nyx-cov-${label}-`));
}

function rmTmp(tmpRoot: string): void {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nyxowl Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Nyxowl Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function initCommittedRepo(dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  await execCommand("git", ["init", "-b", "main"], { cwd: dir, throwOnNonZero: true });
  await execCommand("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execCommand("git", ["config", "user.name", "Nyx Test"], { cwd: dir });
  await execCommand("git", ["add", "-A"], { cwd: dir, throwOnNonZero: true });
  await execCommand("git", ["commit", "-m", "init"], { cwd: dir, throwOnNonZero: true });
  return dir;
}

function expectToolErrorCode(payload: unknown, code: string): void {
  const record = payload as { code?: string } | undefined;
  expect(record?.code).toBe(code);
}

async function failingTool(
  tool: ToolDefinition,
  rawArgs: Record<string, unknown>,
  options: { defaultProjectPath: string; nyxHome: string },
  expectedCode: string,
): Promise<Record<string, unknown>> {
  const response = await invokeToolDefinition(tool, rawArgs, options);
  expect(response.isError).toBe(true);
  const payload = response.structuredContent as Record<string, unknown>;
  expectToolErrorCode(payload, expectedCode);
  return payload;
}

describe("pr-gate — redline CI paths, suppression extraction, coverage rendering", () => {
  it("classifies every CI/CD red-line path and keeps product files allowed", () => {
    expect(isRedlineCiPath(".github/workflows/ci.yml")).toBe(true);
    expect(isRedlineCiPath(".github/workflows\\windows\\run.yml")).toBe(true);
    expect(isRedlineCiPath(".gitlab-ci.yml")).toBe(true);
    expect(isRedlineCiPath(".gitlab-ci.yaml")).toBe(true);
    expect(isRedlineCiPath(".circleci/config.yml")).toBe(true);
    expect(isRedlineCiPath("Jenkinsfile")).toBe(true);
    expect(isRedlineCiPath("azure-pipelines.yml")).toBe(true);
    expect(isRedlineCiPath("src/ci.yml")).toBe(false);
    expect(isRedlineCiPath(".github/workflow-helper/ci.yml")).toBe(false);
  });

  it("extracts nyx-allow suppression directives only from added diff lines", () => {
    const diff = [
      "--- a/service.ts",
      "+++ b/service.ts",
      "@@ -1,3 +1,4 @@",
      " const existing = 1;",
      "-// nyx-allow: removed-line — deletions never suppress",
      "+ // nyx-allow: hardcoded-url — synthetic CORS origin probe",
      "+// nyx-allow: bounded-loop — probe loops are bounded",
      "+++// nyx-allow: file-header — +++ header lines are not additions",
      " context without directive",
    ].join("\n");

    expect(extractAllowSuppressionsFromDiff(diff)).toEqual([
      "hardcoded-url: synthetic CORS origin probe",
      "bounded-loop: probe loops are bounded",
    ]);
    expect(extractAllowSuppressionsFromDiff("no directive at all")).toEqual([]);
  });

  it("renders coverage cells as reported, never defaulting to full", () => {
    expect(formatCoverageCell("full")).toBe("full");
    expect(formatCoverageCell("partial")).toBe("partial");
    expect(formatCoverageCell("none")).toBe("none");
    expect(formatCoverageCell(undefined)).toBe("not reported");
    expect(formatCoverageCell(null)).toBe("not reported");
    expect(formatCoverageCell("")).toBe("not reported");
  });

  it("renders surface not-reported for a receipt with only configured-step notes", () => {
    const body = renderCoverageAndLimitationsSection([
      {
        id: "01VERIFY",
        kind: "verify",
        status: "GREEN",
        coverageNotes: ["configured-step: executed 2/2 configured code step(s)"],
      },
    ]).join("\n");

    expect(body).toContain("coverage: not reported");
    expect(body).toContain(
      "Surface coverage:** not reported — no coverage note states whether the running surface was exercised",
    );
    expect(body).toContain("PR-level surface coverage:** not-reported.");
    expect(body).toContain(
      "no receipt coverage note states whether the running surface was exercised.",
    );
  });

  it("adds per-receipt none and partial coverage caveats", () => {
    const views: VerifiedReceiptView[] = [
      { id: "01A", kind: "verify", status: "GREEN", coverage: "partial" },
      { id: "01B", kind: "seam", status: "GREEN", coverage: "none" },
    ];
    const body = renderCoverageAndLimitationsSection(views).join("\n");

    expect(body).toContain(
      "`seam`: coverage recorded as `none` — this gate exercised no coverage at all.",
    );
    expect(body).toContain(
      "`verify`: coverage recorded as `partial` — only part of the configured work was exercised.",
    );
    expect(body).toContain("Coverage caveat — this PR is not fully verified.");
  });

  it("states surface exercised and not-exercised from the coverage notes", () => {
    const exercised = renderCoverageAndLimitationsSection([
      {
        id: "01X",
        kind: "verify",
        status: "GREEN",
        coverageNotes: ["surface:exercised: browser/e2e step ran and passed"],
      },
    ]).join("\n");
    expect(exercised).toContain("Surface coverage:** exercised");
    expect(exercised).not.toContain("Coverage caveat");

    const notExercised = renderCoverageAndLimitationsSection([
      {
        id: "01Y",
        kind: "seam",
        status: "GREEN",
        coverageNotes: ["surface:not-exercised: browser: none — no configured e2e step"],
      },
    ]).join("\n");
    expect(notExercised).toContain("Surface coverage:** not exercised");
    expect(notExercised).toContain(
      "the receipt coverage notes record that the running surface was NOT exercised.",
    );
  });

  it("renders an empty notes receipt with the none-recorded placeholders", () => {
    const body = renderCoverageAndLimitationsSection([
      { id: "01E", kind: "slop", status: "NA" },
    ]).join("\n");
    expect(body).toContain("Coverage notes (verbatim):");
    expect(body).toContain("- _none recorded_");
    expect(body).toContain("Limitations (verbatim):");
  });
});

describe("pr-gate — dispatch, receipt validation and mode branches", () => {
  let tmpRoot: string;
  let nyxHome: string;

  beforeEach(() => {
    tmpRoot = mkTmp("prgate");
    nyxHome = path.join(tmpRoot, "nyx-home");
  });

  afterEach(() => {
    rmTmp(tmpRoot);
  });

  interface CtxBag {
    wt: string;
    repoDir: string;
  }

  async function setupWorktreeRepo(sub: string): Promise<CtxBag> {
    const repoDir = await initCommittedRepo(path.join(tmpRoot, `${sub}-main`));
    const wt = await initCommittedRepo(path.join(tmpRoot, `${sub}-wt`));
    return { wt, repoDir };
  }

  async function commitIn(wt: string, mutate: () => void): Promise<string> {
    // The slice commit lands on a branch so that the auto-derived base
    // ("main") stays an ancestor and `git diff main...HEAD` is non-empty.
    await execCommand("git", ["checkout", "-b", "fixture-slice-branch"], {
      cwd: wt,
      throwOnNonZero: true,
    });
    mutate();
    await execCommand("git", ["add", "-A"], { cwd: wt, throwOnNonZero: true });
    await execCommand("git", ["commit", "-m", "slice commit"], { cwd: wt, throwOnNonZero: true });
    return getHeadTreeHash(wt);
  }

  async function insertReceipt(
    wt: string,
    kind: ReceiptKind,
    opts: {
      status: "GREEN" | "NA";
      treeHash: string;
      coverage?: "full" | "partial" | "none" | null;
      coverageNotes?: string[];
      limitations?: string[];
      naJustification?: string;
    },
  ): Promise<string> {
    const key = ensureReceiptKey(nyxHome);
    const signed = signReceipt(
      {
        id: generateUlid(),
        kind,
        status: opts.status,
        ...(opts.coverage ? { coverage: opts.coverage } : {}),
        ...(opts.coverageNotes ? { coverageNotes: opts.coverageNotes } : {}),
        ...(opts.limitations ? { limitations: opts.limitations } : {}),
        worktree: wt,
        branch: "nyx/demo",
        treeHash: opts.treeHash,
        baseSha: "b".repeat(40),
        commandsHash: "c".repeat(64),
        evidenceArtifactId: null,
        ...(opts.naJustification ? { naJustification: opts.naJustification } : {}),
        createdAt: new Date().toISOString(),
      },
      key,
    );
    const repoId = await computeRepoId(wt);
    const db = new StateDb(ensureProjectLayout(repoId, nyxHome).stateDbPath);
    try {
      db.db
        .prepare(
          `INSERT INTO receipts (
             id, kind, status, coverage, coverage_notes, limitations, worktree, branch,
             tree_hash, base_sha, commands_hash, evidence_artifact_id, na_justification,
             created_at, hmac
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          signed.id,
          signed.kind,
          signed.status,
          signed.coverage ?? null,
          opts.coverageNotes ? JSON.stringify(opts.coverageNotes) : null,
          opts.limitations ? JSON.stringify(opts.limitations) : null,
          signed.worktree,
          signed.branch,
          signed.treeHash,
          signed.baseSha,
          signed.commandsHash,
          signed.evidenceArtifactId,
          signed.naJustification ?? null,
          signed.createdAt,
          signed.hmac,
        );
    } finally {
      db.close();
    }
    return signed.id;
  }

  function prArgs(seed: CtxBag, title: string): Record<string, unknown> {
    return {
      taskSlug: path.basename(seed.wt).replace(/-wt$/, ""),
      title,
      summary: `${title}: regression slice coverage for the PR gate branches.`,
      worktreePath: seed.wt,
    };
  }

  it("fails with ERR_WORKTREE_NOT_FOUND when no worktree is registered and none provided", async () => {
    const payload = await failingTool(
      nyxWorktreePrTool,
      { taskSlug: "ghost-task", title: "feat: ghost", summary: "No worktree exists for this slug." },
      { defaultProjectPath: tmpRoot, nyxHome },
      "ERR_WORKTREE_NOT_FOUND",
    );
    expect(String(payload["message"])).toContain("ghost-task");
  });

  it("falls back to derived branch names for an unregistered worktree", async () => {
    const seed = await setupWorktreeRepo("unregistered");
    await failingTool(
      nyxWorktreePrTool,
      prArgs(seed, "feat: unregistered"),
      { defaultProjectPath: seed.repoDir, nyxHome },
      "ERR_RECEIPT_MISSING",
    );
  });

  it("blocks the PR when the worktree has uncommitted changes", async () => {
    const seed = await setupWorktreeRepo("dirty");
    fs.writeFileSync(path.join(seed.wt, "uncommitted.txt"), "pending\n");
    await failingTool(
      nyxWorktreePrTool,
      prArgs(seed, "feat: dirty"),
      { defaultProjectPath: seed.repoDir, nyxHome },
      "ERR_WORKTREE_DIRTY",
    );
  });

  it("rejects a stale GREEN receipt bound to a different tree hash", async () => {
    const seed = await setupWorktreeRepo("stale");
    await insertReceipt(seed.wt, "verify", { status: "GREEN", treeHash: "a".repeat(40) });
    const payload = await failingTool(
      nyxWorktreePrTool,
      prArgs(seed, "feat: stale"),
      { defaultProjectPath: seed.repoDir, nyxHome },
      "ERR_RECEIPT_STALE_TREE",
    );
    expect(String(payload["message"])).toContain("treeHash");
  });

  it("rejects an NA exploit receipt when the DNA declares an HTTP surface", async () => {
    const seed = await setupWorktreeRepo("httpsurface");
    const headTreeHash = await getHeadTreeHash(seed.wt);
    for (const kind of ["verify", "seam", "slop"] as ReceiptKind[]) {
      await insertReceipt(seed.wt, kind, { status: "GREEN", treeHash: headTreeHash });
    }
    await insertReceipt(seed.wt, "exploit", {
      status: "NA",
      treeHash: headTreeHash,
      naJustification: "no HTTP surface discovered",
    });

    const repoId = await computeRepoId(seed.wt);
    const db = new StateDb(ensureProjectLayout(repoId, nyxHome).stateDbPath);
    try {
      db.db
        .prepare(
          "INSERT INTO dna (repo_id, manifest_hash, dna_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          repoId,
          "manifest-hash-fixture",
          JSON.stringify({ httpSurface: true }),
          new Date().toISOString(),
        );
    } finally {
      db.close();
    }

    await failingTool(
      nyxWorktreePrTool,
      prArgs(seed, "feat: na-exploit"),
      { defaultProjectPath: seed.repoDir, nyxHome },
      "ERR_RECEIPT_INVALID",
    );
  });

  it("blocks the PR when the diff contains a planted secret", async () => {
    const seed = await setupWorktreeRepo("secrets");
    const headTreeHash = await commitIn(seed.wt, () => {
      fs.writeFileSync(
        path.join(seed.wt, "service.js"),
        'const stripeKey = "sk_live_FIRSTORDERSECONDBGROUNDTHEME";\n',
      );
    });
    for (const kind of ["verify", "seam", "slop", "exploit"] as ReceiptKind[]) {
      await insertReceipt(seed.wt, kind, {
        status: kind === "exploit" ? "NA" : "GREEN",
        treeHash: headTreeHash,
        ...(kind === "exploit" ? { naJustification: "no HTTP surface discovered" } : {}),
      });
    }
    await failingTool(
      nyxWorktreePrTool,
      prArgs(seed, "feat: secret"),
      { defaultProjectPath: seed.repoDir, nyxHome },
      "ERR_SECRET_DETECTED",
    );
  });

  it("requires explicit confirmation before CI workflow files change", async () => {
    const seed = await setupWorktreeRepo("ciwarn");
    const headTreeHash = await commitIn(seed.wt, () => {
      fs.mkdirSync(path.join(seed.wt, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(seed.wt, ".github", "workflows", "ci.yml"), "jobs: []\n");
    });
    for (const kind of ["verify", "seam", "slop", "exploit"] as ReceiptKind[]) {
      await insertReceipt(seed.wt, kind, {
        status: kind === "exploit" ? "NA" : "GREEN",
        treeHash: headTreeHash,
        ...(kind === "exploit" ? { naJustification: "no HTTP surface discovered" } : {}),
      });
    }
    await failingTool(
      nyxWorktreePrTool,
      prArgs(seed, "feat: ci"),
      { defaultProjectPath: seed.repoDir, nyxHome },
      "ERR_REDLINE_BLOCKED",
    );
  });

  it("writes a local PR file with verbatim receipts when gh is unavailable", async () => {
    const seed = await setupWorktreeRepo("localpr");
    const headTreeHash = await commitIn(seed.wt, () => {
      fs.mkdirSync(path.join(seed.wt, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(seed.wt, ".github", "workflows", "ci.yml"), "jobs: []\n");
      fs.writeFileSync(
        path.join(seed.wt, "probe.ts"),
        "// nyx-allow: file-redirect — fixture allows CI probes\n",
      );
    });
    await insertReceipt(seed.wt, "verify", {
      status: "GREEN",
      treeHash: headTreeHash,
      coverage: "partial",
      coverageNotes: ["configured-step: executed 1/1 configured code step(s)"],
    });
    await insertReceipt(seed.wt, "seam", { status: "GREEN", treeHash: headTreeHash, coverage: "full" });
    await insertReceipt(seed.wt, "slop", { status: "GREEN", treeHash: headTreeHash, coverage: null });
    await insertReceipt(seed.wt, "exploit", {
      status: "NA",
      treeHash: headTreeHash,
      naJustification: "no HTTP surface discovered",
    });

    const args = prArgs(seed, "feat: local pr");
    args["allowCiChanges"] = true;
    const response = await invokeToolDefinition(nyxWorktreePrTool, args, {
      defaultProjectPath: seed.repoDir,
      nyxHome,
    });
    expect(response.isError).toBeFalsy();
    const data = response.structuredContent as {
      mode?: string;
      prUrl?: string | null;
      localPrFilePath?: string | null;
      prBody?: string;
      suppressions?: string[];
      notice?: string;
    };
    expect(data.mode).toBe("local");
    expect(data.prUrl).toBeNull();
    expect(data.suppressions).toEqual(["file-redirect: fixture allows CI probes"]);
    expect(String(data.prBody)).toContain("## Nyxowl Verification Receipts");
    expect(String(data.prBody)).toContain("coverage: not reported");
    expect(String(data.prBody)).toContain("Slop Gate Suppressions");
    expect(data.notice).toContain("run \"gh auth login\" to enable automatic PRs");
    expect(fs.readFileSync(data.localPrFilePath as string, "utf8")).toContain("# feat: local pr");
  });

  it("lists disabled gates in the PR body when the worktree config turns a gate off", async () => {
    const seed = await setupWorktreeRepo("gatesoff");
    const headTreeHash = await commitIn(seed.wt, () => {
      fs.mkdirSync(path.join(seed.wt, ".nyxowl"), { recursive: true });
      fs.writeFileSync(
        path.join(seed.wt, ".nyxowl", "config.json"),
        JSON.stringify({ version: 1, gates: { slop: "off" } }),
      );
    });
    for (const kind of ["verify", "seam", "slop", "exploit"] as ReceiptKind[]) {
      await insertReceipt(seed.wt, kind, {
        status: kind === "exploit" ? "NA" : "GREEN",
        treeHash: headTreeHash,
        ...(kind === "exploit" ? { naJustification: "no HTTP surface discovered" } : {}),
      });
    }

    const response = await invokeToolDefinition(nyxWorktreePrTool, prArgs(seed, "feat: gates off"), {
      defaultProjectPath: seed.repoDir,
      nyxHome,
    });
    expect(response.isError).toBeFalsy();
    const data = response.structuredContent as {
      prBody?: string;
      verifiedReceipts?: Array<{ id: string }>;
      notice?: string;
    };
    expect(String(data.prBody)).toContain("Disabled gates per config: slop");
    expect(data.verifiedReceipts).toHaveLength(3);
  });
});

describe("worktree provisioning — lockfile, node_modules and env links", () => {
  let tmpRoot: string;
  let nyxHome: string;
  const offlineFlag = "NYXOWL_OFFLINE_PROVISION";

  beforeEach(() => {
    tmpRoot = mkTmp("provision");
    nyxHome = path.join(tmpRoot, "nyx-home");
    delete process.env[offlineFlag];
  });

  afterEach(() => {
    delete process.env[offlineFlag];
    rmTmp(tmpRoot);
  });

  function layout(repoKey: string) {
    return ensureProjectLayout(`provision-${repoKey}`, nyxHome);
  }

  function dbFor(repoKey: string): StateDb {
    return new StateDb(layout(repoKey).stateDbPath);
  }

  function config(overrides?: Partial<NyxConfig["provision"]>): NyxConfig {
    return {
      ...DEFAULT_CONFIG,
      provision: { install: "auto", linkEnv: true, ...overrides },
    };
  }

  it("skips install when configured off and skips env linking when disabled", async () => {
    const main = path.join(tmpRoot, "main-off");
    fs.mkdirSync(main, { recursive: true });
    fs.writeFileSync(path.join(main, ".env"), "MAIN_ONLY=fixture-only\n");
    const wt = path.join(tmpRoot, "wt-off");
    fs.mkdirSync(wt, { recursive: true });

    const result = await provisionWorktree(main, wt, config({ install: "off", linkEnv: false }), dbFor("off"), layout("off"));
    expect(result).toEqual({
      linkedEnvFiles: [],
      installCommand: null,
      installStatus: "skipped",
      installArtifactId: null,
    });
  });

  it("skips install when no lockfile is detected and falls back to linked node_modules", async () => {
    const main = path.join(tmpRoot, "main-nm");
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(path.join(main, "node_modules"), { recursive: true });
    const wt = path.join(tmpRoot, "wt-nm");
    fs.mkdirSync(wt, { recursive: true });

    const linked = await provisionWorktree(main, wt, config(), dbFor("nm"), layout("nm"));
    expect(linked.installStatus).toBe("linked-fallback");
    expect(linked.installCommand).toBe("symlink:node_modules");
    expect(fs.statSync(path.join(wt, "node_modules")).isDirectory()).toBe(true);

    const wtExisting = path.join(tmpRoot, "wt-nm-existing");
    fs.mkdirSync(wtExisting, { recursive: true });
    fs.mkdirSync(path.join(wtExisting, "node_modules"), { recursive: true });
    const skipped = await provisionWorktree(main, wtExisting, config(), dbFor("nm"), layout("nm"));
    expect(skipped).toEqual({
      linkedEnvFiles: [],
      installCommand: null,
      installStatus: "skipped",
      installArtifactId: null,
    });
  });

  it("links main node_modules offline when the lockfile install is bypassed", async () => {
    const main = path.join(tmpRoot, "main-offline");
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(path.join(main, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(main, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
    const wt = path.join(tmpRoot, "wt-offline");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');

    process.env[offlineFlag] = "1";
    const result = await provisionWorktree(main, wt, config(), dbFor("offline"), layout("offline"));
    expect(result.installCommand).toBe("npm ci --ignore-scripts");
    expect(result.installStatus).toBe("installed");
    expect(result.installArtifactId).not.toBeNull();
    expect(fs.statSync(path.join(wt, "node_modules")).isDirectory()).toBe(true);
  });

  it("falls back to linking node_modules when the lockfile install fails, else reports failed", async () => {
    const writeLockfile = (wt: string): void => {
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(wt, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
    };

    const mainEmpty = path.join(tmpRoot, "main-fail-empty");
    fs.mkdirSync(mainEmpty, { recursive: true });
    const wtEmpty = path.join(tmpRoot, "wt-fail-empty");
    writeLockfile(wtEmpty);
    const failed = await provisionWorktree(mainEmpty, wtEmpty, config(), dbFor("failed"), layout("failed"));
    expect(failed.installCommand).toBe("npm ci --ignore-scripts");
    expect(failed.installStatus).toBe("failed");
    expect(failed.installArtifactId).not.toBeNull();

    const mainNm = path.join(tmpRoot, "main-fail-nm");
    fs.mkdirSync(mainNm, { recursive: true });
    fs.mkdirSync(path.join(mainNm, "node_modules"), { recursive: true });
    const wtNm = path.join(tmpRoot, "wt-fail-nm");
    writeLockfile(wtNm);
    const fallback = await provisionWorktree(mainNm, wtNm, config(), dbFor("fallback"), layout("fallback"));
    expect(fallback.installStatus).toBe("linked-fallback");
    expect(fs.statSync(path.join(wtNm, "node_modules")).isDirectory()).toBe(true);
  });

  it("detects the install command for supported lockfiles and none without", () => {
    const dir = mkTmp("lockfiles");
    try {
      expect(detectLockfileInstallCommand(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "fixture\n");
      expect(detectLockfileInstallCommand(dir)?.cmd).toBe("pnpm");
      fs.rmSync(path.join(dir, "pnpm-lock.yaml"));
      fs.writeFileSync(path.join(dir, "package-lock.json"), "fixture\n");
      expect(detectLockfileInstallCommand(dir)?.cmd).toBe("npm");
      fs.rmSync(path.join(dir, "package-lock.json"));
      fs.writeFileSync(path.join(dir, "uv.lock"), "fixture\n");
      expect(detectLockfileInstallCommand(dir)?.cmd).toBe("uv");
      fs.rmSync(path.join(dir, "uv.lock"));
      fs.writeFileSync(path.join(dir, "Cargo.lock"), "fixture\n");
      expect(detectLockfileInstallCommand(dir)?.cmd).toBe("cargo");
      fs.rmSync(path.join(dir, "Cargo.lock"));
      fs.writeFileSync(path.join(dir, "Gemfile.lock"), "fixture\n");
      expect(detectLockfileInstallCommand(dir)?.cmd).toBe("bundle");
      fs.rmSync(path.join(dir, "Gemfile.lock"));
      fs.writeFileSync(path.join(dir, "go.sum"), "fixture\n");
      expect(detectLockfileInstallCommand(dir)?.cmd).toBe("go");
      fs.rmSync(path.join(dir, "go.sum"));
      fs.writeFileSync(path.join(dir, "bun.lock"), "fixture\n");
      expect(detectLockfileInstallCommand(dir)?.cmd).toBe("bun");
      fs.rmSync(path.join(dir, "bun.lock"));
      expect(detectLockfileInstallCommand(dir)).toBeNull();
    } finally {
      rmTmp(dir);
    }
  });

  it("links nothing when the main checkout or its env candidates are missing", async () => {
    const wt = path.join(tmpRoot, "wt-empty");
    fs.mkdirSync(wt, { recursive: true });
    expect(await linkEnvFiles(path.join(tmpRoot, "does-not-exist"), wt)).toEqual([]);
    const emptyMain = path.join(tmpRoot, "main-no-env");
    fs.mkdirSync(emptyMain, { recursive: true });
    expect(await linkEnvFiles(emptyMain, wt)).toEqual([]);
  });

  it("falls back to name-based linking when git check-ignore cannot answer", async () => {
    const main = await initCommittedRepo(path.join(tmpRoot, "main-corrupt"));
    const apiDir = path.join(main, "packages", "api");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, "package.json"), '{"name":"api"}');
    fs.writeFileSync(path.join(apiDir, ".env"), "API_KEY=fixture-only\n");
    fs.writeFileSync(path.join(apiDir, ".env.local"), "API_LOCAL=fixture-only\n");
    git(["add", "-A"], main);
    git(["commit", "-m", "fixture"], main);

    const wt = path.join(tmpRoot, "wt-corrupt");
    fs.mkdirSync(wt, { recursive: true });
    // A corrupt index makes `git check-ignore --stdin` fail hard while
    // rev-parse still resolves the repository root.
    fs.writeFileSync(path.join(main, ".git", "index"), "definitely-not-an-index");

    const linked = await linkEnvFiles(main, wt);
    expect(linked).toEqual(["packages/api/.env", "packages/api/.env.local"]);
    expect(fs.lstatSync(path.join(wt, "packages", "api", ".env")).isSymbolicLink()).toBe(true);
  });

  it("skips a candidate whose source disappears during provisioning", async () => {
    const main = path.join(tmpRoot, "main-deleted");
    fs.mkdirSync(main, { recursive: true });
    fs.writeFileSync(path.join(main, ".env.vanishing"), "VANISH=fixture-only\n");
    const wt = path.join(tmpRoot, "wt-deleted");
    fs.mkdirSync(wt, { recursive: true });

    // Hold the git-root resolution open until the source file is removed, so
    // the deletion deterministically lands between discovery and the symlink
    // loop.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualExec = vi.importActual<typeof import("../../src/core/exec.ts")>(
      "../../src/core/exec.ts",
    );
    vi.doMock("../../src/core/exec.ts", async () => {
      const actual = await actualExec;
      return {
        ...actual,
        execCommand: (
          command: string,
          args: string[],
          options: Parameters<typeof actual.execCommand>[2],
        ) => {
          if (command === "git" && args.includes("rev-parse")) {
            return gate.then(() => actual.execCommand(command, args, options));
          }
          return actual.execCommand(command, args, options);
        },
      };
    });
    try {
      const { linkEnvFiles: gatedLinkEnvFiles } = await import(
        "../../src/mcp/engines/worktree-slice/provision.ts"
      );
      const promise = gatedLinkEnvFiles(main, wt);
      fs.rmSync(path.join(main, ".env.vanishing"));
      release();
      expect(await promise).toEqual([]);
    } finally {
      vi.doUnmock("../../src/core/exec.ts");
      vi.resetModules();
    }
  });
});

describe("secret scan — rule matrix and diff parser branches", () => {
  it("detects each planted secret class with its rule id", () => {
    const fixtures: Array<[string, string, string]> = [
      ["-----BEGIN RSA PRIVATE KEY-----", "pem-private-key", "pem"],
      ["const token = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';", "github-token", "gh-token"],
      ["key=AKIASOJAKZ6RZOSOAUR9", "aws-access-key", "aws"],
      ["key=AIzaSyAlpha_alpha-alphaAlphaAAAAAlphAA0", "gcp-api-key", "gcp"],
      ["key='sk_test_FIRSTORDERSECONDBGROUNDTHEME'", "stripe-key", "stripe"],
      ["xoxb-123456789012-abcdefg", "slack-token", "slack"],
      ["const key = 'sk-ant-alphaLLLalphaLLLalpha';", "ai-api-key", "ai"],
      ["postgresql://svc:sup3rs3cret@db.internal/app", "url-with-credentials", "db-uri"],
      ['db_password: "a16charcharcharcha"', "hardcoded-secret-assignment", "assignment"],
    ];
    for (const [line, ruleId, label] of fixtures) {
      const findings = scanContentForSecrets(line, "service.ts");
      expect(findings, label).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe(ruleId);
    }
    expect(scanContentForSecrets("const safe = 1;", "clean.ts")).toEqual([]);
  });

  it("counts added lines only and tracks the file and line of each finding", async () => {
    const tmp = mkTmp("secretdiff");
    try {
      const repo = await initCommittedRepo(path.join(tmp, "repo"));
      fs.writeFileSync(path.join(repo, "leak.js"), "const base = 1;\n");
      git(["add", "-A"], repo);
      git(["commit", "-m", "base"], repo);
      fs.writeFileSync(path.join(repo, "leak.js"), 'const apiKey = "aaaaaaaaaaaaaaaaaaaaaaaa";\n');
      git(["add", "-A"], repo);
      git(["commit", "-m", "leak"], repo);

      const findings = await scanDiffForSecrets(repo, "HEAD~1");
      expect(findings).toHaveLength(1);
      expect(findings[0]?.filePath).toBe("leak.js");
      expect(findings[0]?.line).toBe(1);
      expect(findings[0]?.ruleId).toBe("hardcoded-secret-assignment");
      expect(findings[0]?.snippet).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
    } finally {
      rmTmp(tmp);
    }
  });
});

describe("server-layer extractors — server actions, loaders and negatives", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkTmp("serverlayers");
  });

  afterEach(() => {
    rmTmp(tmpRoot);
  });

  function candidatesFor(files: Record<string, string>): ReturnType<typeof extractServerCandidates> {
    const rels = Object.keys(files);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(tmpRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return extractServerCandidates(tmpRoot, rels);
  }

  it("extracts whole-file and inline server actions", () => {
    const files = {
      "src/actions.ts": [
        '"use server";',
        "export async function createRecord(formData: FormData): Promise<void> {}",
        "async function tweak(input: string): Promise<string> {",
        '  "use server";',
        "  return input;",
        "}",
        "export const destroyRecord = async (id: string): Promise<void> => {};",
      ].join("\n"),
    };
    const names = candidatesFor(files).filter((c) => c.kind === "server-action").map((c) => c.name);
    expect(names).toEqual(["createRecord", "destroyRecord", "tweak"]);
  });

  it("deduplicates repeated candidate names in the same file", () => {
    const files = {
      "src/dup.ts": ['"use server";', "export async function alpha() {}", "export async function alpha() {}"].join(
        "\n",
      ),
    };
    const names = candidatesFor(files).filter((c) => c.kind === "server-action").map((c) => c.name);
    expect(names).toEqual(["alpha"]);
  });

  it("extracts getServerSideProps, getStaticProps, remix loaders and const loaders", () => {
    const files = {
      "src/pages/demo.tsx": [
        "export function getServerSideProps(context: unknown): object { return { props: {} }; }",
      ].join("\n"),
      "src/pages/static.tsx": [
        "export async function getStaticProps(): Promise<object> { return { props: {} }; }",
      ].join("\n"),
      "src/routes/about.ts": [
        "export async function loader(request: Request): Promise<Response> {",
        "  return Response.json({ ok: true });",
        "}",
      ].join("\n"),
      "src/remix.ts": ["export const loader = async (args: unknown): Promise<object> => ({});"].join("\n"),
    };
    const loaders = candidatesFor(files).filter((c) => c.kind === "loader").map((c) => c.name);
    expect(loaders).toEqual(["getServerSideProps", "getStaticProps", "loader", "loader"]);
  });

  it("detects App Router server components that fetch data and skips client components", () => {
    const files = {
      "src/app/dashboard/page.tsx": [
        "async function load(): Promise<object> {",
        '  const res = await fetch("/api/dashboard");',
        "  const rows = await prisma.dashboard.findMany();",
        "  return { res, rows };",
        "}",
        "export default async function DashboardPage() {",
        "  const data = await load();",
        "  return <main>{JSON.stringify(data)}</main>;",
        "}",
      ].join("\n"),
      "src/app/admin/page.tsx": [
        '"use client";',
        "export default async function AdminPage() { const data = await fetch('/api/admin'); return <>{data}</>; }",
      ].join("\n"),
      "src/app/plain/page.tsx": ["export default function PlainPage() { return <h1>plain</h1>; }"].join("\n"),
    };
    const defaults = candidatesFor(files).filter((c) => c.kind === "loader" && c.name === "default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.filePath).toBe("src/app/dashboard/page.tsx");
    expect(defaults[0]?.line).toBe(1);
  });

  it("skips unscannable rels: tests/spec paths, directories, oversized and missing files", () => {
    fs.mkdirSync(path.join(tmpRoot, "blob.tsx"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "huge.tsx"), "x".repeat(3 * 1024 * 1024));
    const candidates = extractServerCandidates(tmpRoot, [
      "tests/app.ts",
      "spec/app.spec.ts",
      "blob.tsx",
      "huge.tsx",
      "ghost.tsx",
    ]);
    expect(candidates).toEqual([]);
  });

  it("summarizes the server layers explicitly as unsupported", () => {
    expect(serverCandidateSummary([])).toEqual([]);
    const summary = serverCandidateSummary([
      { kind: "server-action", name: "a1", filePath: "a.ts", line: 1 },
      { kind: "server-action", name: "a2", filePath: "a.ts", line: 2 },
      { kind: "loader", name: "loader", filePath: "b.ts", line: 1 },
    ]);
    expect(summary).toHaveLength(2);
    expect(summary[0]?.layer).toBe("server-actions");
    expect(String(summary[0]?.reason)).toContain("2 server action(s)");
    expect(summary[1]?.layer).toBe("server-loaders");
    expect(String(summary[1]?.reason)).toContain("1 server-side data loader");
  });
});

describe("db-query extractors — drivers, reserved words and negatives", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkTmp("dbqueries");
  });

  afterEach(() => {
    rmTmp(tmpRoot);
  });

  function treeFor(files: Record<string, string>): Array<string> {
    const rels = Object.keys(files);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(tmpRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    // Nonexistent rels and a directory named like a source file exercise the
    // readSourceFile failure paths.
    rels.push("ghost.ts", "ghost.sql", "ghost.py");
    fs.mkdirSync(path.join(tmpRoot, "broken.sql"), { recursive: true });
    rels.push("broken.sql");
    return rels;
  }

  it("extracts supabase, prisma and mapped drizzle references", () => {
    const rels = treeFor({
      "src/queries.ts": [
        "import { pgTable } from 'drizzle-orm/pg-core';",
        "const users = pgTable('app_users');",
        "const rows = db.select().from(users);",
        "client.from('profiles').select();",
        "const data = await supabase.rpc('get_stats');",
        "prisma.user.findMany({ where: {} });",
        "db.user.findUnique({ where: {} });",
        "orm.business.findMany();",
        "prisma.user.findStaleAndSlow();",
      ].join("\n"),
    });
    const refs = extractDbQueries(tmpRoot, rels);
    const keys = refs.map((ref) => `${ref.kind}:${ref.ref}:${ref.driver}`);
    expect(keys).toContain("table:app_user:drizzle");
    expect(keys).toContain("table:profile:supabase");
    expect(keys).toContain("rpc:get_stat:supabase");
    expect(keys).toContain("table:user:prisma");
    // Unsupported receivers and unknown methods must never be reported.
    expect(keys).not.toContain("table:business:prisma");
    for (const ref of refs) {
      expect(Number.isInteger(ref.line)).toBe(true);
    }
  });

  it("keeps an unmapped drizzle identifier with its raw name", () => {
    const rels = treeFor({
      "src/ooo.ts": ["const rel = db.select().from(ghost_tbl);"].join("\n"),
    });
    const refs = extractDbQueries(tmpRoot, rels);
    const keys = refs.map((ref) => `${ref.kind}:${ref.ref}:${ref.driver}`);
    expect(keys).toContain("table:ghost_tbl:drizzle");
  });

  it("filters SQL reserved words but keeps legitimate table names", () => {
    expect(SQL_RESERVED_WORDS.has("set")).toBe(true);
    expect(SQL_RESERVED_WORDS.has("update_log")).toBe(false);
    const rels = treeFor({
      "src/raw.ts": [
        'const ups = "INSERT INTO item SELECT id FROM set";',
        'const conflict = "ON CONFLICT DO UPDATE SET v = 1";',
        'console.log("UPDATE log");',
        'const del = "DELETE FROM items";',
      ].join("\n"),
    });
    const refs = extractDbQueries(tmpRoot, rels);
    const sqlRefs = refs.filter((ref) => ref.driver === "sql").map((ref) => ref.ref);
    expect(sqlRefs).toContain("log");
    expect(sqlRefs).toContain("item");
    expect(sqlRefs).not.toContain("set");
  });

  it("deduplicates identical references seen twice on one line", () => {
    const rels = treeFor({
      "src/dup.ts": ["client.from('profiles'); client2.from('profiles');"].join("\n"),
    });
    const refs = extractDbQueries(tmpRoot, rels);
    const profileRefs = refs.filter((ref) => ref.driver === "supabase" && ref.ref === "profile");
    expect(profileRefs).toHaveLength(1);
  });

  it("parses migration routines from SQL files", () => {
    const rels = treeFor({
      "migrations/001_init.sql": [
        "CREATE OR REPLACE FUNCTION get_stats() RETURNS SETOF record AS $$",
        "CREATE FUNCTION add_item(item_id int) RETURNS void AS $$",
        "CREATE PROCEDURE purge_old()",
      ].join("\n"),
    });
    const routines = extractDbRoutines(tmpRoot, rels);
    expect(Array.from(routines).sort()).toEqual(["add_item", "get_stat", "purge_old"]);
  });

  it("skips masked comment lines and star-prefixed continuation lines", () => {
    const rels = treeFor({
      "src/chain.ts": [
        "const report = db.prepare('SELECT id FROM report_row');",
        "const scaled = report_count",
        "  * report_scale;",
      ].join("\n"),
      "src/legacy.go": [
        "// SELECT id FROM legacy_go_table must not leak from a Go comment",
        'const q = ("SELECT id FROM go_items");',
        'const real = ("SELECT id FROM go_real_items");',
      ].join("\n"),
    });
    const refs = extractDbQueries(tmpRoot, rels);
    const sqlRefs = refs.filter((ref) => ref.driver === "sql").map((ref) => ref.ref);
    expect(sqlRefs).not.toContain("legacy_go_table");
    expect(sqlRefs).toContain("report_row");
    expect(sqlRefs).toContain("go_item");
    expect(sqlRefs).toContain("go_real_item");
  });

  it("reports Python ORM layers as unsupported with a reason", () => {
    const rels = treeFor({
      "app/orm.py": ["from sqlalchemy import create_engine", "engine = create_engine(url)"].join("\n"),
      "app/clean.py": ["x = 1"].join("\n"),
    });
    const layers: Array<{ layer: string; reason: string }> = [
      ...detectUnsupportedDbLayers(tmpRoot, rels),
    ];
    expect(layers).toHaveLength(1);
    expect(layers[0]?.layer).toBe("db-query");
    expect(layers[0]?.reason).toContain("sqlalchemy");
    expect(layers[0]?.reason).toContain("django.db.models");
    expect(layers[0]?.reason).toContain("peewee");
  });
});

describe("seam ignore — walker fallback and git listing edge cases", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkTmp("seamignore");
  });

  afterEach(() => {
    rmTmp(tmpRoot);
  });

  it("returns an empty list for a missing worktree", async () => {
    expect(await listSeamFiles(path.join(tmpRoot, "missing"))).toEqual([]);
  });

  it("falls back to the pruning walker for an empty git repository", async () => {
    const repo = path.join(tmpRoot, "empty");
    fs.mkdirSync(repo, { recursive: true });
    git(["init", "-q"], repo);
    expect(await listSeamFiles(repo)).toEqual([]);
  });

  it("excludes symlinked directory entries from the git listing", async () => {
    const repo = path.join(tmpRoot, "symlinked");
    fs.mkdirSync(path.join(repo, "real-dir"), { recursive: true });
    fs.writeFileSync(path.join(repo, "real-dir", "inner.ts"), "export const inner = 1;\n");
    fs.writeFileSync(path.join(repo, "top.ts"), "export const top = 1;\n");
    fs.symlinkSync(path.join(repo, "real-dir"), path.join(repo, "link"));
    git(["init", "-q"], repo);
    git(["add", "-A"], repo);
    git(["commit", "-m", "fixture"], repo);

    const files = await listSeamFiles(repo);
    expect(files.sort()).toEqual(["real-dir/inner.ts", "top.ts"]);
  });
});

describe("env-inspect — package reports, shapes and runner-role gate", () => {
  let tmpRoot: string;
  let wt: string;
  let roleBackup: string | undefined;

  interface EnvInspectData {
    envFilesFound: string[];
    exampleFilesFound: string[];
    keys: Array<{ name: string; presence: string }>;
    drift: {
      missingFromEnvButInExample: string[];
      missingFromEnvButReferencedInCode: string[];
      undocumentedInExample: string[];
    };
    packages: Array<{
      packagePath: string;
      envFiles: string[];
      linkedEnvFiles: string[];
      missingKeys: string[];
    }>;
    run?: { exitCode: number | null; ready: boolean; timedOut: boolean };
  }

  beforeEach(() => {
    tmpRoot = mkTmp("envinspect");
    wt = path.join(tmpRoot, "wt");
    fs.mkdirSync(wt, { recursive: true });
    roleBackup = process.env["NYXOWL_ROLE"];
    delete process.env["NYXOWL_ROLE"];
  });

  afterEach(() => {
    if (roleBackup === undefined) {
      delete process.env["NYXOWL_ROLE"];
    } else {
      process.env["NYXOWL_ROLE"] = roleBackup;
    }
    rmTmp(tmpRoot);
  });

  function envFixture(): void {
    fs.writeFileSync(path.join(wt, "package.json"), '{"name":"root"}');
    fs.writeFileSync(
      path.join(wt, ".env"),
      ["ROOT_SET=fixture-value", "ROOT_EMPTY=", "UNDOC_IN_ENV=1", "CODE_EMPTY_KEY="].join("\n"),
    );
    fs.writeFileSync(
      path.join(wt, ".env.example"),
      ["ROOT_SET=", "ROOT_EMPTY=", "EXAMPLE_ONLY=1"].join("\n"),
    );
    const pkgDir = path.join(wt, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), '{"name":"pkg"}');
    fs.writeFileSync(path.join(pkgDir, ".env"), "PKG_KEY=1\n");
    fs.writeFileSync(
      path.join(pkgDir, "index.ts"),
      [
        "const a = process.env.PKG_ONLY_KEY;",
        "const b = process.env['CODE_EMPTY_KEY'];",
        "const c = process.env.NODE_ENV;",
        'const d = os.getenv("PKG_ONLY_KEY");',
      ].join("\n"),
    );
    fs.symlinkSync(path.join(pkgDir, ".env"), path.join(pkgDir, ".env.link"));
  }

  it("reports per-package env files, linked files, key presence and drift", async () => {
    envFixture();
    const response = await invokeToolDefinition(
      nyxEnvInspectTool,
      { worktreePath: wt },
      { defaultProjectPath: tmpRoot, nyxHome: tmpRoot },
    );
    expect(response.isError).toBeFalsy();
    const data = response.structuredContent as unknown as EnvInspectData;

    expect(data.envFilesFound.sort()).toEqual([".env"]);
    expect(data.exampleFilesFound.sort()).toEqual([".env.example"]);
    const keys = data.keys;
    const presence = keys.map((k) => `${k.name}=${k.presence}`);
    expect(presence).toEqual(
      expect.arrayContaining(["ROOT_EMPTY=EMPTY", "ROOT_SET=SET", "UNDOC_IN_ENV=SET"]),
    );
    const drift = data.drift;
    expect(drift.missingFromEnvButInExample).toEqual(["EXAMPLE_ONLY", "ROOT_EMPTY"]);
    expect(drift.missingFromEnvButReferencedInCode).toContain("PKG_ONLY_KEY");
    expect(drift.missingFromEnvButReferencedInCode).toContain("CODE_EMPTY_KEY");
    expect(drift.missingFromEnvButReferencedInCode).not.toContain("NODE_ENV");
    expect(drift.undocumentedInExample).toEqual(["CODE_EMPTY_KEY", "UNDOC_IN_ENV"]);

    const packages = data.packages;
    const root = packages.find((p) => p.packagePath === ".");
    const pkg = packages.find((p) => p.packagePath === "pkg");
    expect(root?.envFiles).toEqual([".env"]);
    expect(root?.linkedEnvFiles).toEqual([]);
    expect(pkg?.envFiles).toEqual([".env", ".env.link"]);
    expect(pkg?.linkedEnvFiles).toEqual([".env.link"]);
    expect(pkg?.missingKeys).toEqual(expect.arrayContaining(["CODE_EMPTY_KEY", "PKG_ONLY_KEY"]));
  });

  it("denies non-runner roles and honors the server-declared role for runs", async () => {
    envFixture();
    const deniedCall = nyxEnvInspectTool.handler(
      { worktreePath: wt, run: { command: "/bin/true" } },
      { callerRole: "nyx-probe" } as unknown as ToolExecutionContext,
    );
    await expect(deniedCall).rejects.toThrow(/nyx-probe/);

    // A whitespace-only declared role falls back to the denied caller role.
    process.env["NYXOWL_ROLE"] = "   ";
    await expect(
      nyxEnvInspectTool.handler(
        { worktreePath: wt, run: { command: "/bin/true" } },
        { callerRole: "nyx-probe" } as unknown as ToolExecutionContext,
      ),
    ).rejects.toThrow(/nyx-probe/);

    // A declared role wins over a denied caller role.
    process.env["NYXOWL_ROLE"] = "nyx-devops";
    const allowed = await invokeToolDefinition(
      nyxEnvInspectTool,
      { worktreePath: wt, run: { command: "/bin/true" } },
      { defaultProjectPath: tmpRoot, nyxHome: tmpRoot, callerRole: "nyx-probe" },
    );
    expect(allowed.isError).toBeFalsy();
    const data = allowed.structuredContent as unknown as EnvInspectData;
    expect(data.run?.exitCode).toBe(0);
    expect(data.run?.ready).toBe(false);
    expect(data.run?.timedOut).toBe(false);
  });

  it("returns empty package data for a missing worktree and omits run when not requested", async () => {
    const result = await nyxEnvInspectTool.handler(
      { worktreePath: path.join(tmpRoot, "missing-wt") },
      { callerRole: "nyx-devops" } as unknown as ToolExecutionContext,
    );
    const data = result as EnvInspectData;
    expect(data.envFilesFound).toEqual([]);
    expect(data.packages).toEqual([]);
    expect(data.keys).toEqual([]);
    expect("run" in data).toBe(false);
  });
});

function listenHttp(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no ephemeral loopback port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeHttp(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("exploit — health route validation and preflight status classes", () => {
  it("accepts only same-origin health routes", () => {
    expect(isValidHealthRoute("/health")).toBe(true);
    expect(isValidHealthRoute("/api/../status")).toBe(true);
    expect(isValidHealthRoute("/a\\b")).toBe(false);
    expect(isValidHealthRoute("//health")).toBe(false);
    expect(isValidHealthRoute("health")).toBe(false);
    expect(isValidHealthRoute("/health\u0000")).toBe(false);
    expect(isValidHealthRoute("/health ")).toBe(false);
    expect(isValidHealthRoute("/health\u007f")).toBe(false);
  });

  it("reports every non-2xx preflight class with the matching error code", async () => {
    const cases: Array<[number, string]> = [
      [404, "ERR_PREFLIGHT_404"],
      [400, "ERR_PREFLIGHT_4XX"],
      [302, "ERR_PREFLIGHT_REDIRECT"],
      [500, "ERR_PREFLIGHT_5XX"],
    ];
    for (const [status, expectedCode] of cases) {
      const server = http.createServer((_req, res) => {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end("fixture");
      });
      try {
        const port = await listenHttp(server);
        const preflight = await preflightTarget(new URL(`http://127.0.0.1:${port}`));
        expect(preflight.rendered).toBe(false);
        expect(preflight.evidence[0]?.errorCode).toBe(expectedCode);
        expect(preflight.evidence[0]?.statusCode).toBe(status);
        expect(preflight.evidence[0]?.rendered).toBe(false);
      } finally {
        await closeHttp(server);
      }
    }
  });

  it("renders a custom health route before falling back to root", async () => {
    const server = http.createServer((req, res) => {
      if (req.headers.accept === "*/*" && req.url === "/internal/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("healthy");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not here");
    });
    try {
      const port = await listenHttp(server);
      const preflight = await preflightTarget(new URL(`http://127.0.0.1:${port}`), {
        healthRoute: "/internal/health",
      });
      expect(preflight.rendered).toBe(true);
      expect(preflight.evidence).toHaveLength(1);
      expect(preflight.evidence[0]?.route).toBe("/internal/health");
      expect(preflight.evidence[0]?.statusCode).toBe(200);
      expect(preflight.evidence[0]?.errorCode).toBeNull();
      expect(preflight.evidence[0]?.detail).toContain("HTTP 200 from /internal/health");
    } finally {
      await closeHttp(server);
    }
  });

  it("reports an unreachable preflight with a null status and evidence for every route", async () => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("listening", () => {
        const address = probe.address();
        if (!address || typeof address === "string") {
          reject(new Error("no ephemeral loopback port"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const preflight = await preflightTarget(new URL(`http://127.0.0.1:${port}/app`));
    expect(preflight.rendered).toBe(false);
    expect(preflight.evidence).toHaveLength(2);
    for (const entry of preflight.evidence) {
      expect(entry.statusCode).toBeNull();
      expect(entry.errorClass).toBe("TypeError");
      expect(typeof entry.errorCode).toBe("string");
      expect(entry.rendered).toBe(false);
    }
  });
});

describe("exploit — vector probes against loopback fixtures", () => {
  let tmpRoot: string;
  let nyxHome: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpRoot = mkTmp("expprobe");
    nyxHome = path.join(tmpRoot, "nyx-home");
    repoDir = path.join(tmpRoot, "repo");
    await initCommittedRepo(repoDir);
    await execCommand("git", ["commit", "--allow-empty", "-m", "empty"], { cwd: repoDir });
  });

  afterEach(() => {
    rmTmp(tmpRoot);
  });

  interface ProbeData {
    status?: string;
    findings?: Array<{ vector: string; vulnerable: boolean; severity: string; details: string }>;
  }

  async function probe(
    server: http.Server,
    vectors: string[],
  ): Promise<ProbeData> {
    const port = await listenHttp(server);
    try {
      const response = await invokeToolDefinition(
        nyxExploitProbeTool,
        {
          targetUrlOrHandler: `http://127.0.0.1:${port}`,
          worktreePath: repoDir,
          vectors,
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(response.isError).toBeFalsy();
      return response.structuredContent as ProbeData;
    } finally {
      await closeHttp(server);
    }
  }

  function behaviorServer(behavior: (req: http.IncomingMessage, res: http.ServerResponse, call: number) => void): http.Server {
    let call = 0;
    return http.createServer((req, res) => {
      call += 1;
      behavior(req, res, call);
    });
  }

  function ok(_req: http.IncomingMessage, res: http.ServerResponse, _call: number): void {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  }

  it("reports a RED medium rate-limit finding when all burst requests are accepted", async () => {
    const data = await probe(behaviorServer(ok), ["rate-limit"]);
    expect(data.status).toBe("RED");
    const finding = data.findings?.[0];
    expect(finding?.vector).toBe("rate-limit");
    expect(finding?.vulnerable).toBe(true);
    expect(finding?.severity).toBe("medium");
    expect(finding?.details).toContain("Accepted all 10 burst requests");
  });

  it("reports rate limiting observed when bursts answer with retry-after", async () => {
    const data = await probe(
      behaviorServer((_req, res, call) => {
        // Request 1 is the mandatory preflight; requests 2..11 are the burst.
        if (call === 1) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
          return;
        }
        res.writeHead(429, { "content-type": "text/plain", "retry-after": "10" });
        res.end("slow down");
      }),
      ["rate-limit"],
    );
    expect(data.status).toBe("GREEN");
    const finding = data.findings?.[0];
    expect(finding?.details).toContain("Rate limiting observed");
    expect(finding?.vulnerable).toBe(false);
  });

  it("stays inconclusive when bursts answer non-2xx without rate-limit signals", async () => {
    const data = await probe(
      behaviorServer((_req, res, call) => {
        if (call === 1) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
      }),
      ["rate-limit"],
    );
    expect(data.status).toBe("GREEN");
    const finding = data.findings?.[0];
    expect(finding?.details).toContain("non-2xx responses without rate-limit signals (statuses 404");
    expect(finding?.vulnerable).toBe(false);
  });

  it("marks every vector inconclusive when the surface becomes unreachable mid-probe", async () => {
    const data = await probe(
      behaviorServer((req, res, call) => {
        if (call === 1) {
          ok(req, res, call);
          return;
        }
        res.socket?.destroy();
      }),
      ["authz-idor", "sqli-xss", "cors", "mass-assignment", "rate-limit", "secret-leak"],
    );
    expect(data.status).toBe("GREEN");
    expect(data.findings).toHaveLength(6);
    for (const finding of data.findings ?? []) {
      expect(finding.details).toContain("target unreachable");
      expect(finding.vulnerable).toBe(false);
      expect(finding.severity).toBe("none");
    }
  });

  it("flags an IDOR response that exposes another user's data", async () => {
    const data = await probe(
      behaviorServer((req, res, call) => {
        if (call === 1) {
          ok(req, res, call);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ownerId":2,"secretNote":"fixture-pin"}');
      }),
      ["authz-idor"],
    );
    expect(data.status).toBe("RED");
    const finding = data.findings?.[0];
    expect(finding?.vulnerable).toBe(true);
    expect(finding?.severity).toBe("high");
    expect(finding?.details).toContain("IDOR detected at /api/users/2");
  });

  it("flags reflected XSS and SQL-error leaks", async () => {
    const data = await probe(
      behaviorServer((req, res, call) => {
        if (call === 1) {
          ok(req, res, call);
          return;
        }
        const parsed = new URL(req.url ?? "/", `http://127.0.0.1`);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<p>${parsed.searchParams.get("q") ?? ""}PG:: syntax error at or near boom</p>`);
      }),
      ["sqli-xss"],
    );
    expect(data.status).toBe("RED");
    const finding = data.findings?.[0];
    expect(finding?.vector).toBe("sqli-xss");
    expect(finding?.vulnerable).toBe(true);
    expect(finding?.severity).toBe("high");
    expect(finding?.details).toContain("Reflected XSS payload");
  });

  it("reflects an arbitrary origin with credentials and flags the CORS policy", async () => {
    for (const allowOrigin of ["https://evil-attacker.example.com", "*", "null"]) {
      const data = await probe(
        behaviorServer((req, res, call) => {
          if (req.method === "GET" && req.headers.accept === "*/*") {
            ok(req, res, call);
            return;
          }
          res.writeHead(200, {
            "content-type": "text/plain",
            "access-control-allow-origin": allowOrigin,
            "access-control-allow-credentials": "true",
          });
          res.end("pre");
        }),
        ["cors"],
      );
      expect(data.status).toBe("RED");
      const finding = data.findings?.[0];
      expect(finding?.vector).toBe("cors");
      expect(finding?.vulnerable).toBe(true);
      expect(finding?.severity).toBe("high");
    }
  });

  it("flags a mass-assignment endpoint that accepts an unpermitted admin property", async () => {
    const data = await probe(
      behaviorServer((req, res, call) => {
        if (call === 1) {
          ok(req, res, call);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"isAdmin":true,"role":"admin"}');
      }),
      ["mass-assignment"],
    );
    expect(data.status).toBe("RED");
    const finding = data.findings?.[0];
    expect(finding?.vulnerable).toBe(true);
    expect(finding?.severity).toBe("high");
    expect(finding?.details).toContain("accepted an unpermitted isAdmin/role mass-assignment");
  });

  it("flags a leaked private key in the response body", async () => {
    const data = await probe(
      behaviorServer((req, res, call) => {
        if (call === 1) {
          ok(req, res, call);
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("-----BEGIN RSA PRIVATE KEY-----FIXTUREONLY");
      }),
      ["secret-leak"],
    );
    expect(data.status).toBe("RED");
    const finding = data.findings?.[0];
    expect(finding?.vulnerable).toBe(true);
    expect(finding?.severity).toBe("critical");
  });

  it("issues an NA receipt without probes when the handler is none", async () => {
    const response = await invokeToolDefinition(
      nyxExploitProbeTool,
      {
        targetUrlOrHandler: "none",
        worktreePath: repoDir,
        vectors: ["secret-leak"],
      },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(response.isError).toBeFalsy();
    const data = response.structuredContent as ProbeData;
    expect(data.status).toBe("NA");
    expect(data.findings).toEqual([]);

    const ctx = await import("../../src/mcp/tool.ts").then((m) => m.createToolContext(
      { worktreePath: repoDir },
      { defaultProjectPath: repoDir, nyxHome },
    ));
    try {
      const row = ctx.db.db
        .prepare("SELECT branch FROM receipts WHERE status = 'NA' ORDER BY created_at DESC")
        .get() as { branch?: string } | undefined;
      expect(row?.branch).toBeDefined();
    } finally {
      ctx.db.close();
    }
  });
});


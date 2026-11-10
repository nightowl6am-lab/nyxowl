import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.ts";
import { execCommand } from "../../src/core/exec.ts";
import {
  decodeOptionalNoteList,
  ensureReceiptKey,
  verifyReceipt,
} from "../../src/core/receipts.ts";
import {
  allocateFreePort,
  assertPortAvailable,
  isPortAvailable,
  listSpawnedProcs,
  registerSpawnedProc,
  stopAllSpawnedProcs,
  stopSpawnedProc,
} from "../../src/mcp/engines/probe-exploit/proc.ts";
import {
  nyxVerifySliceTool,
  parseReporterCounts,
  resolveE2eBrowserCommands,
} from "../../src/mcp/engines/probe-exploit/verify.ts";
import { createToolContext, invokeToolDefinition } from "../../src/mcp/tool.ts";

/** Synthetic fixture secret. It must NEVER appear in any gate output. */
const FIXTURE_SECRET = "e2e-gate-secret-9137";

const NO_CODE_STEPS = { typecheck: null, lint: null, test: null, build: null };

interface VerifyResult {
  status: "GREEN" | "RED";
  receiptId: string;
  treeHash: string;
  failedStep: string | null;
  summaryOutput: string;
  evidenceArtifactId: string;
  coverage: "full" | "partial" | "none";
  browserCoverage: "ran" | "none" | "failed";
  browserPassed: number | null;
  browserFailed: number | null;
  coverageNotes: string[];
  limitations: string[];
}

describe("nyx_verify_slice — browser/e2e gate (BUG 6), port isolation (BUG 7)", () => {
  let tmpRoot: string;
  let nyxHome: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-verify-e2e-"));
    nyxHome = path.join(tmpRoot, "nyx-home");
  });

  afterEach(() => {
    stopAllSpawnedProcs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function makeGitRepo(name: string): Promise<string> {
    const repoDir = path.join(tmpRoot, name);
    fs.mkdirSync(repoDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: repoDir, throwOnNonZero: true });
    await execCommand("git", ["config", "user.email", "t@nyx.dev"], { cwd: repoDir });
    await execCommand("git", ["config", "user.name", "T"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
    return repoDir;
  }

  async function commitAll(repoDir: string): Promise<void> {
    await execCommand("git", ["add", "-A"], { cwd: repoDir, throwOnNonZero: true });
    await execCommand("git", ["commit", "-m", "fixture"], {
      cwd: repoDir,
      throwOnNonZero: true,
    });
  }

  /** Writes a loopback-only app + e2e fixture that needs the provisioned env. */
  function writeAppAndE2EFixtures(repoDir: string): void {
    fs.writeFileSync(
      path.join(repoDir, ".env"),
      `APP_SECRET=${FIXTURE_SECRET}\n`,
    );
    fs.writeFileSync(
      path.join(repoDir, "server.js"),
      [
        `const http = require("http");`,
        // Prints the provisioned secret: gate output must redact it.
        `console.log("boot secret=" + process.env.APP_SECRET);`,
        `const srv = http.createServer((req, res) => { res.end("ok"); });`,
        `srv.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("listening"));`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repoDir, "e2e.js"),
      [
        `const http = require("http");`,
        `if (!process.env.APP_SECRET) { console.error("missing APP_SECRET"); process.exit(1); }`,
        `http.get(process.env.BASE_URL + "/", (res) => {`,
        `  let body = "";`,
        `  res.on("data", (c) => (body += c));`,
        `  res.on("end", () => {`,
        `    if (res.statusCode === 200 && body.includes("ok")) {`,
        `      console.log("  1 passed (3ms)");`,
        `      process.exit(0);`,
        `    }`,
        `    console.log("  1 failed");`,
        `    process.exit(1);`,
        `  });`,
        `}).on("error", (e) => { console.error(String(e)); console.log("  1 failed"); process.exit(1); });`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "e2e-fixture", version: "1.0.0", scripts: { "test:e2e": "node e2e.js" } }, null, 2),
    );
    fs.writeFileSync(path.join(repoDir, "src-app.txt"), "app source\n");
  }

  describe("config: commands.e2e / commands.browser", () => {
    it("defaults to null, validates like other commands, and preserves backwards compatibility", () => {
      const base = loadConfig({ nyxHome, projectPath: tmpRoot });
      expect(base.commands.e2e).toBeNull();
      expect(base.commands.browser).toBeNull();
      // Existing fields and defaults are preserved.
      expect(base.commands.typecheck).toBeNull();
      expect(base.commands.lint).toBeNull();
      expect(base.commands.test).toBeNull();
      expect(base.commands.build).toBeNull();

      const withE2e = loadConfig({
        nyxHome,
        projectPath: tmpRoot,
        cliOverrides: { commands: { e2e: "npm run test:e2e", browser: "node server.js" } },
      });
      expect(withE2e.commands.e2e).toBe("npm run test:e2e");
      expect(withE2e.commands.browser).toBe("node server.js");

      const explicitNull = loadConfig({
        nyxHome,
        projectPath: tmpRoot,
        cliOverrides: { commands: { typecheck: "tsc", e2e: null, browser: null } },
      });
      expect(explicitNull.commands.typecheck).toBe("tsc");
      expect(explicitNull.commands.e2e).toBeNull();
      expect(explicitNull.commands.browser).toBeNull();

      for (const bad of [{ e2e: 5 }, { browser: ["node"] }, { e2e: true }]) {
        expect(() =>
          loadConfig({
            nyxHome,
            projectPath: tmpRoot,
            cliOverrides: { commands: bad } as never,
          }),
        ).toThrowError(/commands\.(e2e|browser) must be string or null/);
      }

      // Unknown keys inside `commands` remain ignored (pre-existing behavior).
      const ignored = loadConfig({
        nyxHome,
        projectPath: tmpRoot,
        cliOverrides: { commands: { nope: "x" } } as never,
      });
      expect(ignored.commands.e2e).toBeNull();
      expect(ignored.commands.typecheck).toBeNull();

      // Unknown top-level keys are still rejected exactly as before.
      expect(() =>
        loadConfig({
          nyxHome,
          projectPath: tmpRoot,
          cliOverrides: { nope: 1 } as never,
        }),
      ).toThrowError(/unknown config key/);
    });
  });

  describe("resolveE2eBrowserCommands", () => {
    it("prefers explicit config, then DNA, then the project's own e2e script", async () => {
      const repoDir = await makeGitRepo("e2e-resolve");
      fs.writeFileSync(
        path.join(repoDir, "package.json"),
        JSON.stringify({ scripts: { "test:e2e": "node e2e.js" } }),
      );

      // Package script fallback.
      expect(resolveE2eBrowserCommands(repoDir, {})).toEqual({
        e2e: "npm run test:e2e",
        browser: null,
      });

      // "e2e" script as secondary fallback.
      fs.writeFileSync(
        path.join(repoDir, "package.json"),
        JSON.stringify({ scripts: { e2e: "node e2e.js" } }),
      );
      expect(resolveE2eBrowserCommands(repoDir, {}).e2e).toBe("npm run e2e");

      // Explicit config wins over scripts; DNA fills gaps; browser is explicit-only.
      expect(
        resolveE2eBrowserCommands(
          repoDir,
          { e2e: "cfg-e2e", browser: "cfg-start" },
          { e2e: "dna-e2e", browser: "dna-start" },
        ),
      ).toEqual({ e2e: "cfg-e2e", browser: "cfg-start" });
      expect(
        resolveE2eBrowserCommands(repoDir, {}, { e2e: "dna-e2e", browser: "dna-start" }),
      ).toEqual({ e2e: "dna-e2e", browser: "dna-start" });
      expect(resolveE2eBrowserCommands(repoDir, {}, {}).browser).toBeNull();
    });
  });

  describe("parseReporterCounts", () => {
    it("parses Playwright, Vitest, Jest, and Cypress summaries", () => {
      expect(parseReporterCounts("  3 passed (1.2s)\n  1 failed\n  2 skipped")).toEqual({
        passed: 3,
        failed: 1,
        skipped: 2,
      });
      expect(parseReporterCounts("Tests  2 failed | 18 passed (20)")).toEqual({
        passed: 18,
        failed: 2,
        skipped: 0,
      });
      expect(
        parseReporterCounts("Tests:       1 failed, 19 passed, 1 skipped, 21 total"),
      ).toEqual({ passed: 19, failed: 1, skipped: 1 });
      expect(parseReporterCounts("  5 of 5 passed (100%)")).toEqual({
        passed: 5,
        failed: 0,
        skipped: 0,
      });
      expect(parseReporterCounts("no counts here")).toBeNull();
    });
  });

  it(
    "runs the e2e step with internally provisioned env, parses counts, redacts secrets, tears down the app, and claims full coverage",
    async () => {
      const repoDir = await makeGitRepo("e2e-run");
      writeAppAndE2EFixtures(repoDir);
      await commitAll(repoDir);

      const e2ePort = await allocateFreePort();
      const res = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "e2e-run-slice",
          commandsOverride: {
            test: 'node -e "process.exit(0)"',
            e2e: "node e2e.js",
            browser: "node server.js",
          },
          e2ePort,
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as unknown as VerifyResult;

      expect(data.status).toBe("GREEN");
      expect(data.failedStep).toBeNull();
      // Honest coverage: code step + browser step both ran and passed.
      expect(data.coverage).toBe("full");
      expect(data.browserCoverage).toBe("ran");
      expect(data.browserPassed).toBe(1);
      expect(data.browserFailed).toBe(0);
      expect(data.summaryOutput).toContain("Browser/e2e step: ran and passed (1 passed, 0 failed)");
      expect(
        data.coverageNotes.some((n) =>
          n.startsWith("surface:exercised: browser/e2e step ran and passed"),
        ),
      ).toBe(true);
      expect(
        data.coverageNotes.some((n) => n.startsWith("configured-step: executed 1/1")),
      ).toBe(true);

      // Env values never leave the process: the app printed the secret to its
      // own stdout, but no gate output may contain it.
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain(FIXTURE_SECRET);
      const ctx = await createToolContext(
        { worktreePath: repoDir },
        { defaultProjectPath: repoDir, nyxHome },
      );
      const art = ctx.db.db
        .prepare("SELECT file_path FROM artifacts WHERE id = ?")
        .get(data.evidenceArtifactId) as { file_path: string } | undefined;
      expect(art).toBeTruthy();
      const evidenceText = fs.readFileSync(art!.file_path, "utf8");
      expect(evidenceText).not.toContain(FIXTURE_SECRET);

      // The signed receipt carries the honest coverage notes and round-trips
      // through the receipts table (decodeOptionalNoteList contract).
      const row = ctx.db.db
        .prepare("SELECT * FROM receipts WHERE id = ?")
        .get(data.receiptId) as Record<string, unknown>;
      expect(row["coverage"]).toBe("full");
      const storedNotes = decodeOptionalNoteList(row["coverage_notes"] as string);
      expect(storedNotes).toEqual(data.coverageNotes);
      const storedLimitations = decodeOptionalNoteList(row["limitations"] as string);
      const key = ensureReceiptKey(nyxHome);
      const reconstructed = {
        id: row["id"] as string,
        kind: "verify" as const,
        status: row["status"] as "GREEN",
        coverage: row["coverage"] as "full",
        ...(storedNotes !== undefined ? { coverageNotes: storedNotes } : {}),
        ...(storedLimitations !== undefined ? { limitations: storedLimitations } : {}),
        worktree: row["worktree"] as string,
        branch: row["branch"] as string,
        treeHash: row["tree_hash"] as string,
        baseSha: row["base_sha"] as string,
        commandsHash: row["commands_hash"] as string,
        evidenceArtifactId: row["evidence_artifact_id"] as string | null,
        createdAt: row["created_at"] as string,
      };
      const hmac = row["hmac"] as string;
      expect(verifyReceipt({ ...reconstructed, hmac }, key, { expectedTreeHash: row["tree_hash"] as string }).valid).toBe(true);
      ctx.db.close();

      // BUG 7: teardown removed the registry entry and freed the port.
      expect(listSpawnedProcs().length).toBe(0);
      expect(await isPortAvailable(e2ePort)).toBe(true);
    },
    30_000,
  );

  it(
    "fails closed with RED and browser coverage none when the app cannot start (route/status/error-class evidence)",
    async () => {
      const repoDir = await makeGitRepo("e2e-infra");
      writeAppAndE2EFixtures(repoDir);
      await commitAll(repoDir);

      const e2ePort = await allocateFreePort();
      const res = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "e2e-infra-slice",
          commandsOverride: {
            ...NO_CODE_STEPS,
            e2e: "node e2e.js",
            // App dies immediately: the surface can never be exercised.
            browser: 'node -e "process.exit(1)"',
          },
          e2ePort,
          e2eTimeoutMs: 5_000,
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as unknown as VerifyResult;

      expect(data.status).toBe("RED");
      expect(data.failedStep).toBe("e2e");
      expect(data.browserCoverage).toBe("none");
      // Exact redacted evidence: route, status, and error class.
      expect(data.summaryOutput).toContain(`route=tcp://127.0.0.1:${e2ePort}`);
      expect(data.summaryOutput).toContain("status=app-exited-1");
      expect(data.summaryOutput).toContain("errorClass=ERR_E2E_APP_NOT_READY");
      expect(
        data.coverageNotes.some((n) =>
          n.startsWith("surface:not-exercised: browser: none — e2e infrastructure could not start the app"),
        ),
      ).toBe(true);
      expect(data.limitations.length).toBeGreaterThan(0);

      // Teardown still ran on the failure path.
      expect(listSpawnedProcs().length).toBe(0);
      expect(await isPortAvailable(e2ePort)).toBe(true);
    },
    30_000,
  );

  it(
    "fails closed with RED when an explicitly supplied port is occupied (no stale server reuse)",
    async () => {
      const repoDir = await makeGitRepo("e2e-port");
      writeAppAndE2EFixtures(repoDir);
      await commitAll(repoDir);

      const blocker = net.createServer();
      const occupiedPort = await new Promise<number>((resolve) => {
        blocker.listen(0, "127.0.0.1", () => {
          resolve((blocker.address() as net.AddressInfo).port);
        });
      });

      try {
        // The proc-level guard fails clearly on its own too.
        await expect(assertPortAvailable(occupiedPort)).rejects.toThrowError(
          /already in use/,
        );

        const res = await invokeToolDefinition(
          nyxVerifySliceTool,
          {
            worktreePath: repoDir,
            sliceId: "e2e-port-slice",
            commandsOverride: {
              ...NO_CODE_STEPS,
              e2e: "node e2e.js",
              browser: "node server.js",
            },
            e2ePort: occupiedPort,
            e2eTimeoutMs: 5_000,
          },
          { defaultProjectPath: repoDir, nyxHome },
        );
        expect(res.isError).toBeFalsy();
        const data = res.structuredContent as unknown as VerifyResult;

        expect(data.status).toBe("RED");
        expect(data.failedStep).toBe("e2e");
        expect(data.browserCoverage).toBe("none");
        expect(data.summaryOutput).toContain("status=port-occupied");
        expect(data.summaryOutput).toContain(`route=tcp://127.0.0.1:${occupiedPort}`);
        expect(data.coverageNotes.some((n) => n.includes("browser: none"))).toBe(true);
        expect(listSpawnedProcs().length).toBe(0);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    },
    30_000,
  );

  it(
    "reports RED when the configured e2e step runs and fails, with parsed counts and standalone-server limitation",
    async () => {
      const repoDir = await makeGitRepo("e2e-fail");
      await commitAll(repoDir);

      const res = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "e2e-fail-slice",
          commandsOverride: {
            ...NO_CODE_STEPS,
            e2e: `node -e "console.log('  1 failed'); process.exit(1)"`,
          },
          e2eTimeoutMs: 10_000,
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as unknown as VerifyResult;

      expect(data.status).toBe("RED");
      expect(data.failedStep).toBe("e2e");
      expect(data.browserCoverage).toBe("failed");
      expect(data.browserPassed).toBe(0);
      expect(data.browserFailed).toBe(1);
      expect(
        data.coverageNotes.some((n) =>
          n.startsWith("surface:exercised: browser/e2e step ran and failed"),
        ),
      ).toBe(true);
      expect(
        data.limitations.some((l) => l.includes("owned its own server lifecycle")),
      ).toBe(true);
      expect(listSpawnedProcs().length).toBe(0);
    },
    30_000,
  );

  it(
    "keeps verify GREEN with partial coverage and an explicit browser:none note when no e2e step is configured",
    async () => {
      const repoDir = await makeGitRepo("e2e-none");
      await commitAll(repoDir);

      const res = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "e2e-none-slice",
          commandsOverride: { ...NO_CODE_STEPS, test: 'node -e "process.exit(0)"' },
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as unknown as VerifyResult;

      expect(data.status).toBe("GREEN");
      expect(data.coverage).toBe("partial");
      expect(data.browserCoverage).toBe("none");
      expect(data.browserPassed).toBeNull();
      expect(data.browserFailed).toBeNull();
      // The mandated note, verbatim.
      expect(data.coverageNotes).toContain(
        "surface:not-exercised: browser: none — no configured e2e step",
      );
      expect(
        data.limitations.some((l) => l.includes("browser/e2e surface was not exercised")),
      ).toBe(true);
      expect(data.summaryOutput).toContain(
        "Browser/e2e step: none — no configured e2e step.",
      );
    },
    30_000,
  );

  it(
    "claims coverage none when no commands and no browser step ran, and never full without a passing browser step",
    async () => {
      const repoDir = await makeGitRepo("e2e-coverage-none");
      await commitAll(repoDir);

      const nothing = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "e2e-coverage-none-slice",
          commandsOverride: NO_CODE_STEPS,
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      const nothingData = nothing.structuredContent as unknown as VerifyResult;
      expect(nothingData.status).toBe("GREEN");
      expect(nothingData.coverage).toBe("none");
      expect(nothingData.browserCoverage).toBe("none");

      // Code steps passing without a browser step must never claim full.
      const codeOnly = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "e2e-coverage-none-slice",
          commandsOverride: { ...NO_CODE_STEPS, lint: 'node -e "process.exit(0)"' },
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      const codeOnlyData = codeOnly.structuredContent as unknown as VerifyResult;
      expect(codeOnlyData.status).toBe("GREEN");
      expect(codeOnlyData.coverage).toBe("partial");
      expect(codeOnlyData.coverage).not.toBe("full");
    },
    30_000,
  );

  describe("BUG 7 port/process registry regressions", () => {
    it("allocates a fresh free port and tears down registry entries", async () => {
      const port = await allocateFreePort();
      expect(port).toBeGreaterThan(1024);
      expect(await isPortAvailable(port)).toBe(true);

      // A registered proc is removed by stopSpawnedProc (impossibly large pid:
      // killProcessGroup treats it as already-exited and cannot hit a real pid).
      registerSpawnedProc({ name: "verify-e2e-unit-test", pid: 999_999_999, port });
      expect(listSpawnedProcs().some((p) => p.name === "verify-e2e-unit-test")).toBe(true);
      expect(stopSpawnedProc("verify-e2e-unit-test")).toBe(true);
      expect(listSpawnedProcs().some((p) => p.name === "verify-e2e-unit-test")).toBe(false);
      expect(listSpawnedProcs().length).toBe(0);
    });

    it(
      "removes the registry entry and frees the port after the e2e run errors (app supervised, e2e fails)",
      async () => {
        const repoDir = await makeGitRepo("e2e-registry");
        writeAppAndE2EFixtures(repoDir);
        await commitAll(repoDir);

        const e2ePort = await allocateFreePort();
        const res = await invokeToolDefinition(
          nyxVerifySliceTool,
          {
            worktreePath: repoDir,
            sliceId: "e2e-registry-slice",
            commandsOverride: {
              ...NO_CODE_STEPS,
              e2e: 'node -e "console.log(\'  2 failed\'); process.exit(3)"',
              browser: "node server.js",
            },
            e2ePort,
            e2eTimeoutMs: 10_000,
          },
          { defaultProjectPath: repoDir, nyxHome },
        );
        expect(res.isError).toBeFalsy();
        const data = res.structuredContent as unknown as VerifyResult;
        expect(data.status).toBe("RED");
        expect(data.failedStep).toBe("e2e");
        expect(data.browserCoverage).toBe("failed");
        expect(data.browserFailed).toBe(2);
        // Teardown on the error path: registry empty, port free again.
        expect(listSpawnedProcs().length).toBe(0);
        expect(await isPortAvailable(e2ePort)).toBe(true);
      },
      30_000,
    );
  });
});

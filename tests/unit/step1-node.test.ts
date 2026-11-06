import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { loadConfig, parseJsonc } from "../../src/core/config.ts";
import { NyxError } from "../../src/core/errors.ts";
import { execCommand } from "../../src/core/exec.ts";
import {
  computeRepoId,
  computeWorkingTreeHash,
  detectBaseBranch,
  getDirtyFiles,
} from "../../src/core/git.ts";
import { ensureNyxHome } from "../../src/core/paths.ts";
import {
  ensureReceiptKey,
  generateUlid,
  signReceipt,
  verifyReceipt,
} from "../../src/core/receipts.ts";
import { Redactor } from "../../src/core/redact.ts";
import {
  assertWithinTokenBudget,
  enforceTokenBudget,
  estimateTokens,
} from "../../src/core/tokens.ts";
import { StateDb } from "../../src/mcp/db/sqlite.ts";

describe("Step 1 — Core & State Layer", () => {
  it("exec: enforces timeout, kills child process group, caps output, and redacts secrets", async () => {
    const redactor = new Redactor(["SUPER_SECRET_DB_PASS_998877"]);

    // 1. Redaction on stdout/stderr
    const res1 = await execCommand(
      process.execPath,
      ["-e", 'console.log("connecting with SUPER_SECRET_DB_PASS_998877");'],
      { redactor },
    );
    assert.equal(res1.exitCode, 0);
    assert.ok(!res1.stdout.includes("SUPER_SECRET_DB_PASS_998877"));
    assert.ok(res1.stdout.includes("[REDACTED:ENV_SECRET]"));

    // 2. Output cap
    const res2 = await execCommand(
      process.execPath,
      ["-e", 'process.stdout.write("A".repeat(4096));'],
      { maxOutputBytes: 512 },
    );
    assert.equal(res2.truncated, true);
    assert.equal(res2.stdout.length, 512);

    // 3. Timeout + process-group kill
    const res3 = await execCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000);"],
      { timeoutMs: 250 },
    );
    assert.equal(res3.timedOut, true);
  });

  it("git: repo-id is stable across main checkout and worktrees, and temp-index treeHash is deterministic without touching index", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-git-test-"));
    const repoDir = path.join(tmpRoot, "MyRepo");
    const wtDir = path.join(tmpRoot, "wt-1");
    fs.mkdirSync(repoDir, { recursive: true });

    try {
      await execCommand("git", ["init", "-b", "main"], { cwd: repoDir, throwOnNonZero: true });
      await execCommand("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        throwOnNonZero: true,
      });
      await execCommand("git", ["config", "user.name", "Test User"], {
        cwd: repoDir,
        throwOnNonZero: true,
      });

      fs.writeFileSync(path.join(repoDir, ".gitignore"), "ignored.txt\n");
      fs.writeFileSync(path.join(repoDir, "hello.ts"), "export const x = 1;\n");
      await execCommand("git", ["add", "."], { cwd: repoDir, throwOnNonZero: true });
      await execCommand("git", ["commit", "-m", "init"], { cwd: repoDir, throwOnNonZero: true });

      const mainRepoId = await computeRepoId(repoDir);
      await execCommand("git", ["worktree", "add", "-b", "nyx/feat-1", wtDir], {
        cwd: repoDir,
        throwOnNonZero: true,
      });
      const wtRepoId = await computeRepoId(wtDir);
      assert.equal(mainRepoId, wtRepoId, "Main checkout and worktree must share repo-id");

      const baseBranch = await detectBaseBranch(repoDir, "auto");
      assert.equal(baseBranch, "main");

      // Tree hash determinism & sensitivity to untracked non-ignored files
      const hash1 = await computeWorkingTreeHash(wtDir);
      const hash2 = await computeWorkingTreeHash(wtDir);
      assert.equal(hash1, hash2);

      // Adding an ignored file does not change tree hash
      fs.writeFileSync(path.join(wtDir, "ignored.txt"), "secret ignore");
      const hashAfterIgnored = await computeWorkingTreeHash(wtDir);
      assert.equal(hash1, hashAfterIgnored);

      // Adding an untracked non-ignored file DOES change tree hash, while real git index remains untouched
      fs.writeFileSync(path.join(wtDir, "untracked.ts"), "export const y = 2;\n");
      const hashAfterUntracked = await computeWorkingTreeHash(wtDir);
      assert.notEqual(hash1, hashAfterUntracked);

      const stagedCheck = await execCommand("git", ["diff", "--cached", "--name-only"], {
        cwd: wtDir,
      });
      assert.equal(stagedCheck.stdout.trim(), "", "Real git index must not be modified");

      const dirty = await getDirtyFiles(wtDir);
      assert.ok(dirty.some((f) => f.includes("untracked.ts")));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("receipts: signs, verifies, detects tampering, checks treeHash, and enforces NA justification", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-home-receipts-"));
    try {
      const key = ensureReceiptKey(tmpHome);
      const layout = ensureNyxHome(tmpHome);
      const stat = fs.statSync(layout.receiptKeyPath);
      assert.equal(stat.mode & 0o777, 0o600, "receipt.key must be mode 0600");

      const treeHash = "a".repeat(40);
      const signed = signReceipt(
        {
          id: generateUlid(),
          kind: "verify",
          status: "GREEN",
          worktree: "/tmp/wt",
          branch: "nyx/demo",
          treeHash,
          baseSha: "b".repeat(40),
          commandsHash: "c".repeat(64),
          evidenceArtifactId: null,
          createdAt: new Date().toISOString(),
        },
        key,
      );

      assert.equal(verifyReceipt(signed, key, { expectedTreeHash: treeHash }).valid, true);

      // Stale tree
      const stale = verifyReceipt(signed, key, { expectedTreeHash: "d".repeat(40) });
      assert.equal(stale.valid, false);
      assert.ok(stale.reason?.includes("treeHash"));

      // Forged status in DB
      const forged = { ...signed, status: "GREEN" as const, branch: "nyx/hacked" };
      const forgedCheck = verifyReceipt(forged, key);
      assert.equal(forgedCheck.valid, false);
      assert.ok(forgedCheck.reason?.includes("HMAC"));

      // NA without justification throws
      assert.throws(() => {
        signReceipt(
          {
            id: generateUlid(),
            kind: "exploit",
            status: "NA",
            worktree: "/tmp/wt",
            branch: "nyx/demo",
            treeHash,
            baseSha: "b".repeat(40),
            commandsHash: "c".repeat(64),
            evidenceArtifactId: null,
            createdAt: new Date().toISOString(),
          },
          key,
        );
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("redact: strips .env values (raw, base64, url-encoded) and known token patterns while ignoring .env.example", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-redact-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, ".env"),
        'DATABASE_URL="postgres://admin:MyS3cretPass!@db.internal:5432/app"\nCUSTOM_TOKEN=nyx_live_9876543210abcdef\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, ".env.example"),
        "EXAMPLE_PLACEHOLDER_VALUE=keep_this_visible_in_logs\n",
      );

      const redactor = Redactor.fromDirectories([tmpDir]);
      const b64Secret = Buffer.from("nyx_live_9876543210abcdef", "utf8").toString("base64");
      const sampleLog = [
        "Loaded example: keep_this_visible_in_logs",
        "DB error on postgres://admin:MyS3cretPass!@db.internal:5432/app",
        `Base64 leak: ${b64Secret}`,
        "GitHub token: ghp_1234567890abcdefghijklmnopqrstuvwx12",
        "AWS key: AKIAIOSFODNN7EXAMPLE",
        "OpenAI key: sk-proj-1234567890abcdefghijklmnop",
      ].join("\n");

      const redacted = redactor.redact(sampleLog);
      assert.ok(redacted.includes("keep_this_visible_in_logs"), ".env.example values should not be redacted");
      assert.ok(!redacted.includes("MyS3cretPass!"));
      assert.ok(!redacted.includes("nyx_live_9876543210abcdef"));
      assert.ok(!redacted.includes(b64Secret));
      assert.ok(!redacted.includes("ghp_1234567890abcdefghijklmnopqrstuvwx12"));
      assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
      assert.ok(!redacted.includes("sk-proj-1234567890abcdefghijklmnop"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tokens & config: enforces token budgets and layered JSONC configuration", () => {
    const shortText = "Hello world from Nyxowl.";
    assert.ok(estimateTokens(shortText) > 0);
    const budgetOk = enforceTokenBudget(shortText, 100);
    assert.equal(budgetOk.truncated, false);

    const longText = Array.from({ length: 500 }, (_, i) => `line ${i}: const value = ${i};`).join(
      "\n",
    );
    const budgetCut = enforceTokenBudget(longText, 120);
    assert.equal(budgetCut.truncated, true);
    assert.ok(budgetCut.estimatedTokens <= 120);
    assert.equal(budgetCut.overflowText, longText);

    assert.throws(
      () => assertWithinTokenBudget(longText, 100, "handoff"),
      (err: unknown) => err instanceof NyxError && err.code === "ERR_BUDGET_EXCEEDED",
    );

    // Config layering with JSONC comments
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-cfg-home-"));
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-cfg-repo-"));
    try {
      fs.writeFileSync(
        path.join(tmpHome, "config.json"),
        `{
          // Global config with comment
          "preferredHost": "opencode",
          "budgets": { "maxToolOutputTokens": 1200, },
        }`,
      );
      fs.mkdirSync(path.join(tmpRepo, ".nyxowl"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRepo, ".nyxowl", "config.json"),
        `{
          /* Repo override */
          "preferredHost": "opencode",
          "slop": { "scope": "full" }
        }`,
      );

      const merged = loadConfig({
        nyxHome: tmpHome,
        projectPath: tmpRepo,
        cliOverrides: { preferredHost: "opencode" },
      });
      assert.equal(merged.preferredHost, "opencode");
      assert.equal(merged.budgets.maxToolOutputTokens, 1200);
      assert.equal(merged.slop.scope, "full");
      assert.deepEqual(parseJsonc('{ "a": 1, /* c */ }'), { a: 1 });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("sqlite: supports concurrent two-process writers in WAL mode without SQLITE_BUSY failure", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-db-conc-"));
    try {
      const db = StateDb.openForRepo("demo-12345678", tmpHome);
      const dbPath = db.dbPath;
      db.close();

      const makeWorker = (role: string) => `
        import { StateDb } from ${JSON.stringify(new URL("../../src/mcp/db/sqlite.ts", import.meta.url).href)};
        const stateDb = new StateDb(${JSON.stringify(dbPath)});
        for (let i = 0; i < 25; i++) {
          stateDb.recordAudit({
            toolName: "nyx_test_" + i,
            role: ${JSON.stringify(role)},
            argsHash: "h" + i,
            status: "ok",
            durationMs: i
          });
        }
        stateDb.close();
      `;

      // Node >=22.18 / >=23.6 strip TS unflagged ("strip"); 22.13.1 has it false.
      const tsFlag =
        process.features.typescript === false ? ["--experimental-strip-types"] : [];
      const [p1, p2] = await Promise.all([
        execCommand(process.execPath, [
          ...tsFlag, "--input-type=module", "-e", makeWorker("proc-A"),
        ]),
        execCommand(process.execPath, [
          ...tsFlag, "--input-type=module", "-e", makeWorker("proc-B"),
        ]),
      ]);

      assert.equal(p1.exitCode, 0, `Worker 1 failed: ${p1.stderr}`);
      assert.equal(p2.exitCode, 0, `Worker 2 failed: ${p2.stderr}`);

      const verifyDb = new StateDb(dbPath);
      const row = verifyDb.db.prepare("SELECT COUNT(*) as cnt FROM audit_log").get() as {
        cnt: number;
      };
      verifyDb.close();
      assert.equal(row.cnt, 50, "Both concurrent processes must commit all 25 rows each");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

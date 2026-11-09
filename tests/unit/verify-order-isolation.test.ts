import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import { computeWorkingTreeHash } from "../../src/core/git.ts";
import {
  decodeOptionalNoteList,
  ensureReceiptKey,
  verifyReceipt,
} from "../../src/core/receipts.ts";
import { nyxSeamCheckTool } from "../../src/mcp/engines/seam/index.ts";
import { nyxVerifySliceTool } from "../../src/mcp/engines/probe-exploit/verify.ts";
import { createToolContext, invokeToolDefinition } from "../../src/mcp/tool.ts";

const NO_CODE_STEPS = { typecheck: null, lint: null, test: null, build: null };

/**
 * A cheap "build" step that writes generated output into a build directory.
 * Still trivially fast — it only proves that verify-generated artifacts cannot
 * influence seam results or the receipt tree binding (BUG 12).
 */
const BUILD_WRITES_DIST = {
  ...NO_CODE_STEPS,
  build:
    'node -e "require(\'fs\').mkdirSync(\'dist\',{recursive:true});require(\'fs\').writeFileSync(\'dist/bundle.js\',\'generated\')"',
};

const TRIVIAL_STEP = { ...NO_CODE_STEPS, test: 'node -e "process.exit(0)"' };

interface VerifyResult {
  status: "GREEN" | "RED";
  receiptId: string;
  treeHash: string;
  coverage: "full" | "partial" | "none";
  coverageNotes: string[];
}

interface SeamResult {
  status: "GREEN" | "RED";
  receiptId: string;
  treeHash: string;
}

describe("gate artifact isolation: verify and seam bind to the same tree in both orders (BUG 12)", () => {
  let tmpRoot: string;
  let nyxHome: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-verify-order-"));
    nyxHome = path.join(tmpRoot, "nyx-home");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function makeGitRepo(name: string): Promise<string> {
    const repoDir = path.join(tmpRoot, name);
    fs.mkdirSync(repoDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: repoDir, throwOnNonZero: true });
    await execCommand("git", ["config", "user.email", "t@nyx.dev"], { cwd: repoDir });
    await execCommand("git", ["config", "user.name", "T"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src", "app.ts"),
      "export const app = () => 'ok';\n",
    );
    await execCommand("git", ["add", "-A"], { cwd: repoDir, throwOnNonZero: true });
    await execCommand("git", ["commit", "-m", "init"], { cwd: repoDir, throwOnNonZero: true });
    return repoDir;
  }

  async function runVerify(repoDir: string, sliceId: string, commandsOverride: object): Promise<VerifyResult> {
    const res = await invokeToolDefinition(
      nyxVerifySliceTool,
      { worktreePath: repoDir, sliceId, commandsOverride },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(res.isError).toBeFalsy();
    return res.structuredContent as unknown as VerifyResult;
  }

  async function runSeam(repoDir: string): Promise<SeamResult> {
    const res = await invokeToolDefinition(
      nyxSeamCheckTool,
      { worktreePath: repoDir },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(res.isError).toBeFalsy();
    return res.structuredContent as unknown as SeamResult;
  }

  /** Reconstructs the signed receipt from its DB row and validates the HMAC. */
  async function assertReceiptVerifiable(repoDir: string, receiptId: string): Promise<void> {
    const ctx = await createToolContext(
      { worktreePath: repoDir },
      { defaultProjectPath: repoDir, nyxHome },
    );
    try {
      const row = ctx.db.db
        .prepare("SELECT * FROM receipts WHERE id = ?")
        .get(receiptId) as Record<string, unknown>;
      expect(row).toBeTruthy();
      const key = ensureReceiptKey(nyxHome);
      const notes = decodeOptionalNoteList(row["coverage_notes"] as string);
      const limits = decodeOptionalNoteList(row["limitations"] as string);
      const signed = {
        id: row["id"] as string,
        kind: row["kind"] as "verify" | "seam",
        status: row["status"] as "GREEN" | "RED" | "NA",
        ...(row["coverage"] ? { coverage: row["coverage"] as "full" | "partial" | "none" } : {}),
        ...(notes !== undefined ? { coverageNotes: notes } : {}),
        ...(limits !== undefined ? { limitations: limits } : {}),
        worktree: row["worktree"] as string,
        branch: row["branch"] as string,
        treeHash: row["tree_hash"] as string,
        baseSha: row["base_sha"] as string,
        commandsHash: row["commands_hash"] as string,
        evidenceArtifactId: row["evidence_artifact_id"] as string | null,
        ...(row["na_justification"]
          ? { naJustification: row["na_justification"] as string }
          : {}),
        createdAt: row["created_at"] as string,
        hmac: row["hmac"] as string,
      };
      const check = verifyReceipt(signed, key, {
        expectedTreeHash: row["tree_hash"] as string,
        requireGreenOrNa: true,
      });
      expect(check.valid, `receipt ${receiptId}: ${check.reason ?? "unknown"}`).toBe(true);
    } finally {
      ctx.db.close();
    }
  }

  it(
    "verify-generated build output does not change seam results or receipt tree binding in either order",
    async () => {
      const repoDir = await makeGitRepo("order-dist");
      const expectedTreeHash = await computeWorkingTreeHash(repoDir);

      // Order A: verify -> seam
      const v1 = await runVerify(repoDir, "order-a", BUILD_WRITES_DIST);
      expect(v1.status).toBe("GREEN");
      // The generated artifact is cleaned up: no untracked non-ignored noise.
      expect(fs.existsSync(path.join(repoDir, "dist", "bundle.js"))).toBe(false);
      const s1 = await runSeam(repoDir);

      // Order B: seam -> verify (same temp project)
      const s2 = await runSeam(repoDir);
      const v2 = await runVerify(repoDir, "order-b", BUILD_WRITES_DIST);

      // All four receipts bind to the SAME tree hash in both orders.
      expect(v1.treeHash).toBe(expectedTreeHash);
      expect(s1.treeHash).toBe(expectedTreeHash);
      expect(s2.treeHash).toBe(expectedTreeHash);
      expect(v2.treeHash).toBe(expectedTreeHash);
      expect(s1.treeHash).toBe(v1.treeHash);
      expect(s2.treeHash).toBe(v2.treeHash);

      // Repeated verify runs stay stable (no cumulative build noise).
      const v3 = await runVerify(repoDir, "order-repeat", BUILD_WRITES_DIST);
      expect(v3.treeHash).toBe(expectedTreeHash);

      // Both receipt kinds remain verifiable against the same tree.
      await assertReceiptVerifiable(repoDir, v1.receiptId);
      await assertReceiptVerifiable(repoDir, s1.receiptId);
      await assertReceiptVerifiable(repoDir, s2.receiptId);
      await assertReceiptVerifiable(repoDir, v2.receiptId);

      // The verify receipt records honest surface-coverage notes.
      expect(
        v1.coverageNotes.some((n) =>
          n.includes("browser: none — no configured e2e step"),
        ),
      ).toBe(true);
    },
    60_000,
  );

  it(
    "trivial verify step and seam check bind to the same tree hash in both orders",
    async () => {
      const repoDir = await makeGitRepo("order-trivial");
      const expectedTreeHash = await computeWorkingTreeHash(repoDir);

      // verify -> seam
      const v1 = await runVerify(repoDir, "trivial-a", TRIVIAL_STEP);
      const s1 = await runSeam(repoDir);
      // seam -> verify
      const s2 = await runSeam(repoDir);
      const v2 = await runVerify(repoDir, "trivial-b", TRIVIAL_STEP);

      expect(v1.treeHash).toBe(expectedTreeHash);
      expect(s1.treeHash).toBe(expectedTreeHash);
      expect(s2.treeHash).toBe(expectedTreeHash);
      expect(v2.treeHash).toBe(expectedTreeHash);

      await assertReceiptVerifiable(repoDir, v1.receiptId);
      await assertReceiptVerifiable(repoDir, s1.receiptId);
    },
    60_000,
  );

  it(
    "generated artifacts in other reporter directories are also removed from the tree",
    async () => {
      const repoDir = await makeGitRepo("order-reporters");
      const expectedTreeHash = await computeWorkingTreeHash(repoDir);

      const res = await invokeToolDefinition(
        nyxVerifySliceTool,
        {
          worktreePath: repoDir,
          sliceId: "reporters",
          commandsOverride: {
            ...NO_CODE_STEPS,
            test: `node -e "const fs=require('fs');fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/results.json','{}');fs.mkdirSync('playwright-report',{recursive:true});fs.writeFileSync('playwright-report/index.html','<html/>')"`,
          },
        },
        { defaultProjectPath: repoDir, nyxHome },
      );
      expect(res.isError).toBeFalsy();
      const data = res.structuredContent as unknown as VerifyResult;

      expect(data.status).toBe("GREEN");
      expect(data.treeHash).toBe(expectedTreeHash);
      expect(fs.existsSync(path.join(repoDir, "test-results", "results.json"))).toBe(false);
      expect(fs.existsSync(path.join(repoDir, "playwright-report", "index.html"))).toBe(false);
      // A later seam run on the same project binds to the same tree as well.
      const s = await runSeam(repoDir);
      expect(s.treeHash).toBe(expectedTreeHash);
    },
    60_000,
  );
});

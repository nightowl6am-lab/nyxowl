import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import { computeRepoId, getHeadTreeHash } from "../../src/core/git.ts";
import { ensureProjectNyxowlDirs } from "../../src/core/paths.ts";
import {
  canonicalJson,
  computeReceiptHmac,
  decodeOptionalNoteList,
  ensureReceiptKey,
  extractReceiptPayload,
  generateUlid,
  signReceipt,
  verifyReceipt,
  type ReceiptKind,
  type ReceiptPayload,
  type SignedReceipt,
} from "../../src/core/receipts.ts";
import { runCli } from "../../src/cli/index.ts";
import { nyxProjectBootstrapTool } from "../../src/mcp/engines/bootstrap-navigator/index.ts";
import {
  formatCoverageCell,
  renderCoverageAndLimitationsSection,
  summarizeSurfaceExercise,
  type VerifiedReceiptView,
} from "../../src/mcp/engines/worktree-slice/pr-gate.ts";
import {
  nyxWorktreePrTool,
  nyxWorktreeStartTool,
} from "../../src/mcp/engines/worktree-slice/index.ts";
import { openProjectDb, StateDb } from "../../src/mcp/db/sqlite.ts";
import { createToolContext, invokeToolDefinition } from "../../src/mcp/tool.ts";

const VERIFY_NOTES = [
  "configured-step: executed 2/2 configured code step(s) [typecheck=passed, test=passed]",
  "surface:not-exercised: browser: none — no configured e2e step",
];
const VERIFY_LIMITATIONS = [
  "surface coverage: none — the browser/e2e surface was not exercised; passing code steps do not imply the running app works",
];

describe("Receipt coverage honesty — PR gate rendering and signed evidence", () => {
  let tmpRoot: string;
  let nyxHome: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-receipt-coverage-"));
    nyxHome = path.join(tmpRoot, "nyx-home");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("renders absent coverage as 'not reported' and never as 'full'", () => {
    expect(formatCoverageCell(undefined)).toBe("not reported");
    expect(formatCoverageCell(null)).toBe("not reported");
    expect(formatCoverageCell("")).toBe("not reported");
    // "full" is printed ONLY when the receipt itself reported "full".
    expect(formatCoverageCell("full")).toBe("full");
    expect(formatCoverageCell("partial")).toBe("partial");
    expect(formatCoverageCell("none")).toBe("none");
  });

  it("renders a coverage:none receipt with an explicit caveat and never claims full coverage", () => {
    const view: VerifiedReceiptView = {
      id: "01ABCDEF",
      kind: "verify",
      status: "GREEN",
      coverage: "none",
    };
    const body = renderCoverageAndLimitationsSection([view]).join("\n");

    expect(body).toContain("coverage: none");
    expect(body).toContain("Coverage caveat");
    expect(body).toContain("this PR is not fully verified");
    expect(body).not.toContain("full coverage");
    expect(body).not.toContain("coverage: full");
  });

  it("states the surface exercise status from the coverage notes", () => {
    const exercised = summarizeSurfaceExercise([
      { id: "a", kind: "verify", status: "GREEN", coverageNotes: ["surface:exercised: browser ran"] },
    ]);
    expect(exercised).toBe("exercised");

    const notExercised = summarizeSurfaceExercise([
      {
        id: "b",
        kind: "verify",
        status: "GREEN",
        coverageNotes: ["surface:not-exercised: browser: none"],
      },
    ]);
    expect(notExercised).toBe("not-exercised");

    const notStated = summarizeSurfaceExercise([
      { id: "c", kind: "verify", status: "GREEN", coverageNotes: ["configured-step: ran"] },
    ]);
    expect(notStated).toBe("not-reported");
  });

  it("adds no caveat when the surface was exercised and coverage is full", () => {
    const body = renderCoverageAndLimitationsSection([
      {
        id: "01FULL",
        kind: "verify",
        status: "GREEN",
        coverage: "full",
        coverageNotes: ["surface:exercised: browser/e2e step ran and passed"],
        limitations: [],
      },
    ]).join("\n");

    expect(body).toContain("coverage: full");
    expect(body).toContain("Surface coverage:** exercised");
    expect(body).toContain("PR-level surface coverage:** exercised");
    expect(body).not.toContain("Coverage caveat");
    expect(body).not.toContain("not fully verified");
  });

  it("keeps the HMAC of a legacy payload (no coverageNotes/limitations) unchanged", () => {
    const key = ensureReceiptKey(nyxHome);
    const legacy: ReceiptPayload = {
      id: generateUlid(),
      kind: "verify",
      status: "GREEN",
      coverage: "partial",
      worktree: "/tmp/wt",
      branch: "nyx/demo",
      treeHash: "a".repeat(40),
      baseSha: "b".repeat(40),
      commandsHash: "c".repeat(64),
      evidenceArtifactId: null,
      createdAt: new Date().toISOString(),
    };

    // The optional fields are absent from the canonical payload entirely, so
    // the signature is byte-identical to the pre-change implementation.
    const canonical = canonicalJson(extractReceiptPayload(legacy));
    expect(canonical).not.toContain("coverageNotes");
    expect(canonical).not.toContain("limitations");

    // Independent HMAC over the exact canonical bytes of the legacy payload.
    const independentHmac = crypto
      .createHmac("sha256", key)
      .update(canonical, "utf8")
      .digest("hex");
    expect(computeReceiptHmac(legacy, key)).toBe(independentHmac);
    expect(signReceipt(legacy, key).hmac).toBe(independentHmac);

    // A payload that DOES carry the optional fields is signed differently:
    // the evidence fields are genuinely covered by the HMAC.
    const withNotes = computeReceiptHmac(
      { ...legacy, coverageNotes: VERIFY_NOTES, limitations: VERIFY_LIMITATIONS },
      key,
    );
    expect(withNotes).not.toBe(independentHmac);
  });

  it("round-trips note-carrying receipts through the DB and verifies them with a valid HMAC", () => {
    const key = ensureReceiptKey(nyxHome);
    const db = StateDb.openForRepo("repo-coverage-roundtrip", nyxHome);
    try {
      const payload: ReceiptPayload = {
        id: generateUlid(),
        kind: "verify",
        status: "GREEN",
        coverage: "partial",
        coverageNotes: VERIFY_NOTES,
        limitations: VERIFY_LIMITATIONS,
        worktree: "/tmp/wt",
        branch: "nyx/demo",
        treeHash: "a".repeat(40),
        baseSha: "b".repeat(40),
        commandsHash: "c".repeat(64),
        evidenceArtifactId: null,
        createdAt: new Date().toISOString(),
      };
      const signed = signReceipt(payload, key);

      db.db
        .prepare(
          `INSERT INTO receipts (
             id, kind, status, coverage, coverage_notes, limitations, worktree, branch,
             tree_hash, base_sha, commands_hash, evidence_artifact_id, na_justification,
             created_at, hmac
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          signed.id,
          signed.kind,
          signed.status,
          signed.coverage ?? null,
          JSON.stringify(signed.coverageNotes),
          JSON.stringify(signed.limitations),
          signed.worktree,
          signed.branch,
          signed.treeHash,
          signed.baseSha,
          signed.commandsHash,
          signed.evidenceArtifactId,
          signed.createdAt,
          signed.hmac,
        );

      const row = db.db.prepare("SELECT * FROM receipts WHERE id = ?").get(signed.id) as Record<
        string,
        unknown
      >;
      const storedNotes = decodeOptionalNoteList(row["coverage_notes"] as string);
      const storedLimitations = decodeOptionalNoteList(row["limitations"] as string);
      expect(storedNotes).toEqual(VERIFY_NOTES);
      expect(storedLimitations).toEqual(VERIFY_LIMITATIONS);

      // Reconstruct exactly the way the PR gate does and verify the HMAC.
      const reconstructed: SignedReceipt = {
        id: row["id"] as string,
        kind: "verify",
        status: "GREEN",
        coverage: row["coverage"] as "partial",
        ...(storedNotes !== undefined ? { coverageNotes: storedNotes } : {}),
        ...(storedLimitations !== undefined ? { limitations: storedLimitations } : {}),
        worktree: row["worktree"] as string,
        branch: row["branch"] as string,
        treeHash: row["tree_hash"] as string,
        baseSha: row["base_sha"] as string,
        commandsHash: row["commands_hash"] as string,
        evidenceArtifactId: row["evidence_artifact_id"] as string | null,
        createdAt: row["created_at"] as string,
        hmac: row["hmac"] as string,
      };
      const check = verifyReceipt(reconstructed, key, {
        expectedTreeHash: row["tree_hash"] as string,
      });
      expect(check.valid).toBe(true);
    } finally {
      db.close();
    }
  });

  it("verifies note-carrying receipts through the CLI `receipts verify` command", async () => {
    const projectDir = path.join(tmpRoot, "cli-project");
    fs.mkdirSync(projectDir, { recursive: true });
    await execCommand("git", ["init", "-b", "main"], { cwd: projectDir });
    await execCommand("git", ["config", "user.email", "t@nyx.dev"], { cwd: projectDir });
    await execCommand("git", ["config", "user.name", "T"], { cwd: projectDir });
    fs.writeFileSync(path.join(projectDir, "index.ts"), "export const v = 1;\n");
    await execCommand("git", ["add", "-A"], { cwd: projectDir, throwOnNonZero: true });
    await execCommand("git", ["commit", "-m", "init"], {
      cwd: projectDir,
      throwOnNonZero: true,
    });

    const repoId = await computeRepoId(projectDir);
    const projPaths = ensureProjectNyxowlDirs(repoId, nyxHome);
    const db = openProjectDb(projPaths.stateDbFile);
    const key = ensureReceiptKey(nyxHome);

    const signed = signReceipt(
      {
        id: generateUlid(),
        kind: "verify",
        status: "GREEN",
        coverage: "partial",
        coverageNotes: VERIFY_NOTES,
        limitations: VERIFY_LIMITATIONS,
        worktree: path.join(tmpRoot, "gone-worktree"),
        branch: "nyx/cli-demo",
        treeHash: "a".repeat(40),
        baseSha: "b".repeat(40),
        commandsHash: "c".repeat(64),
        evidenceArtifactId: null,
        createdAt: new Date().toISOString(),
      },
      key,
    );

    db.db
      .prepare(
        `INSERT INTO receipts (
           id, kind, status, coverage, coverage_notes, limitations, worktree, branch,
           tree_hash, base_sha, commands_hash, evidence_artifact_id, na_justification,
           created_at, hmac
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        signed.id,
        signed.kind,
        signed.status,
        signed.coverage ?? null,
        JSON.stringify(signed.coverageNotes),
        JSON.stringify(signed.limitations),
        signed.worktree,
        signed.branch,
        signed.treeHash,
        signed.baseSha,
        signed.commandsHash,
        signed.evidenceArtifactId,
        signed.createdAt,
        signed.hmac,
      );
    db.close();

    const verified = await runCli(["receipts", "verify", signed.id], {
      nyxowlHome: nyxHome,
      cwd: projectDir,
    });
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout).toContain("Verified 1 receipt(s)");
    expect(verified.stderr).not.toContain("INVALID HMAC");
  });

  it("renders the PR body honestly: notes verbatim, absent coverage as 'not reported', explicit coverage as reported", async () => {
    const repoDir = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoDir, { recursive: true });

    const bootstrap = await invokeToolDefinition(
      nyxProjectBootstrapTool,
      { projectPath: repoDir, mode: "greenfield", stackSpec: "ts-node", projectName: "demo-cov" },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(bootstrap.isError).toBeFalsy();

    const wtStart = await invokeToolDefinition(
      nyxWorktreeStartTool,
      { taskSlug: "coverage-slice", worktreeMode: "external", repoPath: repoDir },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(wtStart.isError).toBeFalsy();
    const wtPath = (wtStart.structuredContent as { worktreePath: string }).worktreePath;

    fs.writeFileSync(path.join(wtPath, "src", "feature.mjs"), "export const v = 1;\n");
    await execCommand("git", ["add", "-A"], { cwd: wtPath, throwOnNonZero: true });
    await execCommand("git", ["commit", "-m", "feat: feature v1"], {
      cwd: wtPath,
      throwOnNonZero: true,
    });

    const headTreeHash = await getHeadTreeHash(wtPath);
    const ctx = await createToolContext(
      { worktreePath: wtPath },
      { defaultProjectPath: repoDir, nyxHome },
    );
    const key = ensureReceiptKey(nyxHome);

    const insertReceipt = (
      kind: ReceiptKind,
      coverage: "full" | "partial" | "none" | null,
      coverageNotes?: string[],
      limitations?: string[],
    ): SignedReceipt => {
      const signed = signReceipt(
        {
          id: generateUlid(),
          kind,
          status: kind === "exploit" ? "NA" : "GREEN",
          ...(coverage ? { coverage } : {}),
          ...(coverageNotes ? { coverageNotes } : {}),
          ...(limitations ? { limitations } : {}),
          worktree: wtPath,
          branch: `nyx/coverage-slice`,
          treeHash: headTreeHash,
          baseSha: "b".repeat(40),
          commandsHash: "c".repeat(64),
          evidenceArtifactId: null,
          ...(kind === "exploit" ? { naJustification: "no HTTP surface configured" } : {}),
          createdAt: new Date().toISOString(),
        },
        key,
      );
      ctx.db.db
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
          coverageNotes ? JSON.stringify(coverageNotes) : null,
          limitations ? JSON.stringify(limitations) : null,
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
      return signed;
    };

    // verify: note-carrying receipt with partial coverage.
    const verifyReceipt = insertReceipt("verify", "partial", VERIFY_NOTES, VERIFY_LIMITATIONS);
    // seam: explicit full coverage.
    const seamReceipt = insertReceipt("seam", "full");
    // slop: no coverage reported at all -> must render as "not reported".
    const slopReceipt = insertReceipt("slop", null);
    // exploit: justified NA without coverage.
    insertReceipt("exploit", null);

    ctx.db.close();

    const pr = await invokeToolDefinition(
      nyxWorktreePrTool,
      {
        taskSlug: "coverage-slice",
        title: "feat: feature v1",
        summary: "Adds feature v1 with honest coverage reporting.",
        worktreePath: wtPath,
      },
      { defaultProjectPath: repoDir, nyxHome },
    );
    expect(pr.isError).toBeFalsy();
    const prData = pr.structuredContent as {
      mode: string;
      prBody: string;
      verifiedReceipts: Array<{
        id: string;
        kind: string;
        status: string;
        coverage?: string;
        coverageNotes?: string[];
        limitations?: string[];
      }>;
    };

    // (1) The receipts table reports coverage honestly.
    const slopRow = prData.prBody
      .split("\n")
      .find((line) => line.startsWith("| `slop`"));
    expect(slopRow).toBeTruthy();
    expect(slopRow).toContain("not reported");
    expect(slopRow).not.toContain("full");

    const seamRow = prData.prBody
      .split("\n")
      .find((line) => line.startsWith("| `seam`"));
    expect(seamRow).toContain("full");

    const verifyRow = prData.prBody
      .split("\n")
      .find((line) => line.startsWith("| `verify`"));
    expect(verifyRow).toContain("partial");

    // (2) The coverage notes and limitations appear VERBATIM.
    for (const note of VERIFY_NOTES) {
      expect(prData.prBody).toContain(note);
    }
    for (const limitation of VERIFY_LIMITATIONS) {
      expect(prData.prBody).toContain(limitation);
    }
    expect(prData.prBody).toContain("## Coverage & Limitations");

    // (3) The surface exercise status is stated explicitly and a caveat is added.
    expect(prData.prBody).toContain("Surface coverage:** not exercised");
    expect(prData.prBody).toContain("this PR is not fully verified");
    expect(prData.prBody).not.toContain("full coverage");

    // (4) The structured output carries the signed evidence.
    const verifyEntry = prData.verifiedReceipts.find((r) => r.id === verifyReceipt.id);
    expect(verifyEntry).toBeTruthy();
    expect(verifyEntry?.coverage).toBe("partial");
    expect(verifyEntry?.coverageNotes).toEqual(VERIFY_NOTES);
    expect(verifyEntry?.limitations).toEqual(VERIFY_LIMITATIONS);

    const slopEntry = prData.verifiedReceipts.find((r) => r.id === slopReceipt.id);
    expect(slopEntry?.coverage).toBeUndefined();
    expect(seamReceipt.id).toBeTruthy();
  });
});

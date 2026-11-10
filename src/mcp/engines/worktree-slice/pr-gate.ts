import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { execCommand, type ExecOptions, type ExecResult } from "../../../core/exec.ts";
import {
  computeWorkingTreeHash,
  getDirtyFiles,
  getHeadTreeHash,
} from "../../../core/git.ts";
import {
  classifyCoverageNote,
  classifySurfaceExercise,
  decodeOptionalNoteList,
  ensureReceiptKey,
  verifyReceipt,
  type ReceiptKind,
  type SignedReceipt,
} from "../../../core/receipts.ts";
import { NYXOWL_VERSION } from "../../../core/version.ts";
import { defineTool } from "../../tool.ts";
import {
  collectPrChecks,
  waitForPrChecks,
  type CiCheck,
  type CiStatusSummary,
} from "./ci-watch.ts";
import { scanDiffForSecrets } from "./secret-scan.ts";

const REDLINE_CI_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\//,
  /^Jenkinsfile$/,
  /^azure-pipelines\.ya?ml$/,
];

export function isRedlineCiPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return REDLINE_CI_PATTERNS.some((re) => re.test(normalized));
}

export function extractAllowSuppressionsFromDiff(diffText: string): string[] {
  const suppressions: string[] = [];
  const regex = /\/\/\s*nyx-allow:\s*([a-z0-9-]+)\s*(?:—|--|-)\s*(.+)$/i;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const m = regex.exec(line.slice(1));
      if (m && m[1] && m[2]) {
        suppressions.push(`${m[1].trim()}: ${m[2].trim()}`);
      }
    }
  }
  return suppressions;
}

/**
 * An existing pull request that already tracks the head branch.
 */
export interface ExistingPrView {
  number: number;
  url: string;
  state: string;
}

/**
 * Parses the output of `gh pr view <branch> --json number,url,state`.
 *
 * The parser is deliberately defensive: malformed JSON, a missing/invalid
 * field, or a PR that is not OPEN all return `null` so the caller falls
 * through to the create path instead of editing an unknown PR.
 */
export function parseExistingPrView(stdout: string): ExistingPrView | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const number = record["number"];
  const url = record["url"];
  const state = record["state"];

  if (typeof number !== "number" || !Number.isInteger(number)) return null;
  if (typeof url !== "string" || url.trim().length === 0) return null;
  if (typeof state !== "string") return null;
  if (state.toUpperCase() !== "OPEN") return null;

  return { number, url: url.trim(), state };
}

/**
 * Parses the output of `gh pr list --head <branch> --state open --json number,url`.
 *
 * The list output carries no `state` field (the query already filtered on
 * `--state open`), so the first well-formed entry is returned as an OPEN PR.
 * Malformed or empty output returns `null`.
 */
export function parseExistingPrList(stdout: string): ExistingPrView | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const number = record["number"];
    const url = record["url"];
    if (typeof number !== "number" || !Number.isInteger(number)) continue;
    if (typeof url !== "string" || url.trim().length === 0) continue;
    return { number, url: url.trim(), state: "OPEN" };
  }

  return null;
}

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validates one side of an `owner/repo` slug. Rejects `.`/`..` so the value can
 * never escape the intended REST API path segment.
 */
function isValidRepoSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    REPO_SEGMENT_PATTERN.test(segment)
  );
}

/**
 * Parses a git remote URL into a GitHub `owner/repo` slug.
 *
 * Supported forms:
 * - `https://github.com/owner/repo(.git)`
 * - `ssh://git@github.com/owner/repo(.git)`
 * - `git@github.com:owner/repo(.git)` (scp-like)
 *
 * Any other host or a shape that does not resolve to exactly two path
 * segments returns `null`.
 */
export function parseGitHubRepoSlug(remoteUrl: string): string | null {
  if (typeof remoteUrl !== "string") return null;
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;

  let repoPath: string | null = null;

  // scp-like SSH form: [user@]github.com:owner/repo.git
  const scpLike = /^(?:[^@\s/]+@)?github\.com:([^\s]+)$/i.exec(trimmed);
  if (scpLike?.[1]) {
    repoPath = scpLike[1];
  } else {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsedUrl.hostname.toLowerCase() !== "github.com") return null;
    repoPath = parsedUrl.pathname;
  }

  if (!repoPath) return null;

  const normalized = repoPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const segments = normalized.split("/");
  if (segments.length !== 2) return null;

  const owner = segments[0] ?? "";
  const repo = segments[1] ?? "";
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;

  return `${owner}/${repo}`;
}

/**
 * Extracts the PR number from a GitHub pull request URL.
 */
export function parsePrNumberFromUrl(prUrl: string): number | null {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl.trim());
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Output CI labels returned by the PR gate. */
export type PrCiStatus = CiStatusSummary | "not-applicable";

/** CI fields shared by the publish result and the tool output. */
export interface PrCiReport {
  prNumber: number | null;
  ciStatus: PrCiStatus;
  ciChecks: Array<Pick<CiCheck, "name" | "status" | "conclusion" | "url">>;
  ciNotice: string;
}

function toReportedChecks(checks: CiCheck[]): PrCiReport["ciChecks"] {
  return checks.map(({ name, status, conclusion, url }) => ({ name, status, conclusion, url }));
}

/**
 * Renders the human-facing CI notice. Failed and timed-out checks are always
 * reported as actionable text; a passing/absent rollup is never overclaimed.
 */
export function buildCiNotice(
  status: PrCiStatus,
  checks: CiCheck[],
  prNumber: number | null,
  timedOut: boolean,
): string {
  if (status === "not-applicable") {
    return "CI checks are not applicable: the PR was written locally, so no GitHub check rollup exists.";
  }

  const prLabel = prNumber === null ? "the pull request" : `PR #${prNumber}`;

  if (status === "failed") {
    const failing = checks
      .filter((check) =>
        ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
          (check.conclusion ?? "").toUpperCase(),
        ),
      )
      .map((check) => `${check.name} (${check.conclusion})`);
    return `CI checks failed for ${prLabel}: ${failing.join(", ") || "see check rollup"}. Do not merge until the failures are resolved.`;
  }

  if (status === "pending") {
    if (timedOut) {
      return `Timed out waiting for CI checks on ${prLabel}; they are still pending. Re-check before merge.`;
    }
    return `CI checks are still pending for ${prLabel}. Re-check before merge.`;
  }

  if (status === "passed") {
    return `CI checks passed for ${prLabel} (${checks.length}/${checks.length}).`;
  }

  return `No CI check rollup was reported for ${prLabel}; CI status is unknown.`;
}

/**
 * The action the PR gate takes for a given branch.
 */
export type PrPublishAction = "update" | "create";

/**
 * Decides whether the gate updates an existing PR in place or creates a new
 * one. A missing/closed/malformed PR view yields `create`.
 */
export function decidePrPublishAction(existing: ExistingPrView | null): PrPublishAction {
  return existing ? "update" : "create";
}

/**
 * Renders the notice returned to the caller. Both variants state that human
 * approval is required to merge (Red-Line Gate).
 */
export function buildPrNotice(action: PrPublishAction, prUrl: string): string {
  const verb = action === "update" ? "updated" : "opened";
  return `PR ${verb} at ${prUrl}. Human approval is required to merge (Red-Line Gate).`;
}

/**
 * Minimal executor shape used by the GitHub publishing path, so the flow can
 * be exercised without a network or `gh` authentication.
 */
export type GhExec = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface GhPublishParams {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  title: string;
  prBody: string;
  /** When true, poll the check rollup until terminal or timeout. */
  waitForChecks?: boolean;
  /** Polling budget for `waitForChecks`. */
  checkTimeoutMs?: number;
}

export interface GhPublishResult extends PrCiReport {
  action: PrPublishAction;
  prUrl: string;
  notice: string;
}

/**
 * Resolves `owner/repo` for the current checkout. The remote URL is preferred
 * (no extra API call); `gh repo view` is the fallback when the remote is not a
 * parseable GitHub URL.
 */
async function resolveGitHubRepoSlug(
  exec: GhExec,
  worktreePath: string,
): Promise<string | null> {
  const remoteRes = await exec("git", ["remote", "get-url", "origin"], {
    cwd: worktreePath,
    timeoutMs: 30_000,
  });
  if (remoteRes.exitCode === 0) {
    const slug = parseGitHubRepoSlug(remoteRes.stdout);
    if (slug) return slug;
  }

  const repoViewRes = await exec(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { cwd: worktreePath, timeoutMs: 30_000 },
  );
  if (repoViewRes.exitCode !== 0) return null;

  const nameWithOwner = repoViewRes.stdout.trim();
  if (nameWithOwner.length === 0) return null;

  const segments = nameWithOwner.split("/");
  if (segments.length !== 2) return null;

  const owner = segments[0] ?? "";
  const repo = segments[1] ?? "";
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;

  return `${owner}/${repo}`;
}

/**
 * Collects (and optionally waits for) the check rollup after the PR exists.
 * CI problems are reported in the structured output; they never throw once the
 * PR has been created or updated.
 */
async function observePrCi(
  exec: GhExec,
  worktreePath: string,
  prNumber: number | null,
  waitForChecks: boolean,
  checkTimeoutMs: number | undefined,
): Promise<PrCiReport> {
  if (prNumber === null) {
    return {
      prNumber: null,
      ciStatus: "unknown",
      ciChecks: [],
      ciNotice: buildCiNotice("unknown", [], null, false),
    };
  }

  if (waitForChecks) {
    const snapshot = await waitForPrChecks(exec, prNumber, {
      cwd: worktreePath,
      timeoutMs: checkTimeoutMs ?? 300_000,
      intervalMs: 5_000,
    });
    return {
      prNumber,
      ciStatus: snapshot.status,
      ciChecks: toReportedChecks(snapshot.checks),
      ciNotice: buildCiNotice(snapshot.status, snapshot.checks, prNumber, snapshot.timedOut),
    };
  }

  const snapshot = await collectPrChecks(exec, prNumber, { cwd: worktreePath });
  return {
    prNumber,
    ciStatus: snapshot.status,
    ciChecks: toReportedChecks(snapshot.checks),
    ciNotice: buildCiNotice(snapshot.status, snapshot.checks, prNumber, false),
  };
}

/**
 * Publishes the slice to GitHub idempotently.
 *
 * When an OPEN pull request already tracks the head branch, the PR is updated
 * in place (`gh pr edit`) and the SAME URL is returned. If `gh pr edit` fails,
 * the update is retried through the REST API. Otherwise a new PR is created
 * (`gh pr create`), preserving the previous behaviour.
 *
 * After the PR exists, the check rollup is always collected once; with
 * `waitForChecks` the gate polls until the rollup is terminal or the timeout
 * budget is exhausted. CI failures are returned as structured data, never as
 * an exception, because the PR already exists.
 */
export async function publishPrToGitHub(
  params: GhPublishParams,
  exec: GhExec = execCommand,
): Promise<GhPublishResult> {
  const { worktreePath, branch, baseBranch, title, prBody } = params;

  const viewRes = await exec(
    "gh",
    ["pr", "view", branch, "--json", "number,url,state"],
    { cwd: worktreePath, timeoutMs: 30_000 },
  );
  let existing: ExistingPrView | null =
    viewRes.exitCode === 0 ? parseExistingPrView(viewRes.stdout) : null;

  if (!existing) {
    // Fallback for gh versions that do not resolve a branch to its PR via
    // `gh pr view <branch>`.
    const listRes = await exec(
      "gh",
      ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    existing = listRes.exitCode === 0 ? parseExistingPrList(listRes.stdout) : null;
  }

  const action = decidePrPublishAction(existing);

  if (action === "update" && existing) {
    const editRes = await exec(
      "gh",
      ["pr", "edit", String(existing.number), "--title", title, "--body", prBody],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );

    if (editRes.exitCode !== 0) {
      // `gh pr edit` can fail on older gh versions / token scopes. The REST
      // PATCH uses the same gate-generated title and body.
      const slug = await resolveGitHubRepoSlug(exec, worktreePath);
      if (!slug) {
        throw new NyxError(
          "ERR_EXEC_FAILED",
          `gh pr edit failed for PR #${existing.number} and no GitHub owner/repo could be resolved for the REST fallback: ${editRes.stderr || editRes.stdout}`,
          { prNumber: existing.number, exitCode: editRes.exitCode },
        );
      }
      await exec(
        "gh",
        [
          "api",
          "--method",
          "PATCH",
          `repos/${slug}/pulls/${existing.number}`,
          "-f",
          `title=${title}`,
          "-f",
          `body=${prBody}`,
        ],
        { cwd: worktreePath, timeoutMs: 30_000, throwOnNonZero: true },
      );
    }

    const ci = await observePrCi(
      exec,
      worktreePath,
      existing.number,
      params.waitForChecks ?? false,
      params.checkTimeoutMs,
    );

    return {
      action,
      prUrl: existing.url,
      notice: buildPrNotice(action, existing.url),
      ...ci,
    };
  }

  const createRes = await exec(
    "gh",
    [
      "pr",
      "create",
      "--title",
      title,
      "--body",
      prBody,
      "--base",
      baseBranch,
      "--head",
      branch,
    ],
    { cwd: worktreePath, timeoutMs: 30_000, throwOnNonZero: true },
  );

  const prUrl = createRes.stdout.trim().split(/\r?\n/).pop() ?? createRes.stdout.trim();
  const ci = await observePrCi(
    exec,
    worktreePath,
    parsePrNumberFromUrl(prUrl),
    params.waitForChecks ?? false,
    params.checkTimeoutMs,
  );

  return { action, prUrl, notice: buildPrNotice(action, prUrl), ...ci };
}

export const worktreePrInputSchema = z.object({
  taskSlug: z.string().min(1),
  title: z.string().min(3).max(200),
  summary: z.string().min(3).max(4000),
  worktreePath: z.string().optional(),
  allowCiChanges: z.boolean().optional(),
  repoPath: z.string().optional(),
  waitForChecks: z.boolean().optional(),
  checkTimeoutMs: z.number().int().positive().max(1_800_000).optional(),
});

export const worktreePrOutputSchema = z.object({
  taskSlug: z.string(),
  branch: z.string(),
  headTreeHash: z.string(),
  mode: z.enum(["gh", "local"]),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  localPrFilePath: z.string().nullable(),
  notice: z.string(),
  ciStatus: z.enum(["passed", "failed", "pending", "unknown", "not-applicable"]),
  ciChecks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      url: z.string(),
    }),
  ),
  ciNotice: z.string(),
  verifiedReceipts: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["verify", "seam", "slop", "exploit"]),
      status: z.enum(["GREEN", "NA"]),
      coverage: z.string().optional(),
      coverageNotes: z.array(z.string()).optional(),
      limitations: z.array(z.string()).optional(),
    }),
  ),
  suppressions: z.array(z.string()),
  prBody: z.string(),
});

/**
 * A receipt as it is rendered in the PR body and returned by the tool.
 *
 * `coverage` is the coverage value the gate itself reported. It is NEVER
 * defaulted to "full": a receipt that did not report coverage renders as
 * "not reported", so the PR body can never overstate the evidence.
 */
export interface VerifiedReceiptView {
  id: string;
  kind: ReceiptKind;
  status: "GREEN" | "NA";
  coverage?: string;
  coverageNotes?: string[];
  limitations?: string[];
}

/**
 * Renders a coverage value for the receipts table.
 *
 * "full" is printed ONLY when the receipt itself reported "full". Every other
 * value is printed as reported, and an absent value prints "not reported"
 * (never "full").
 */
export function formatCoverageCell(coverage: string | null | undefined): string {
  if (coverage === "full") return "full";
  if (coverage === "partial") return "partial";
  if (coverage === "none") return "none";
  return "not reported";
}

/**
 * Aggregated surface-exercise state across every receipt of the PR.
 *
 * The vocabulary is exactly the one of `classifySurfaceExercise`, so the PR
 * body and the signed evidence always use the same words.
 */
export type PrSurfaceState = "exercised" | "not-exercised" | "not-reported";

/**
 * Determines the PR-level surface state from the coverage notes of all
 * receipts. An explicit "not exercised" always wins (conservative), so a
 * single gate that could not exercise the running surface can never be
 * hidden by another gate that did.
 */
export function summarizeSurfaceExercise(receipts: VerifiedReceiptView[]): PrSurfaceState {
  const allNotes = receipts.flatMap((receipt) => receipt.coverageNotes ?? []);
  return classifySurfaceExercise(allNotes);
}

/**
 * Renders the "Coverage & Limitations" PR body section.
 *
 * Every coverage note and limitation is rendered VERBATIM (the note text is
 * never rewritten, summarized, or reworded). `classifyCoverageNote` and
 * `classifySurfaceExercise` are used to state explicitly whether the running
 * surface was exercised; when it was not exercised (or was not reported), a
 * caveat is added and the PR is never described as fully verified.
 */
export function renderCoverageAndLimitationsSection(
  receipts: VerifiedReceiptView[],
): string[] {
  const lines: string[] = ["## Coverage & Limitations", ""];
  const caveatReasons: string[] = [];

  for (const receipt of receipts) {
    const coverageCell = formatCoverageCell(receipt.coverage);
    const notes = receipt.coverageNotes ?? [];
    const limitations = receipt.limitations ?? [];

    lines.push(
      `### \`${receipt.kind}\` — receipt \`${receipt.id}\` — ${receipt.status} — coverage: ${coverageCell}`,
    );
    lines.push("");

    lines.push("**Coverage notes (verbatim):**");
    if (notes.length === 0) {
      lines.push("- _none recorded_");
    } else {
      for (const note of notes) {
        lines.push(`- ${note}`);
      }
    }
    lines.push("");

    lines.push("**Limitations (verbatim):**");
    if (limitations.length === 0) {
      lines.push("- _none recorded_");
    } else {
      for (const limitation of limitations) {
        lines.push(`- ${limitation}`);
      }
    }
    lines.push("");

    const surfaceNotes = notes.filter((note) => classifyCoverageNote(note) === "surface");
    const stepNotes = notes.filter((note) => classifyCoverageNote(note) !== "surface");
    const surfaceState = classifySurfaceExercise(notes);
    const counts = `${surfaceNotes.length} surface note(s), ${stepNotes.length} configured-step note(s)`;
    if (notes.length === 0) {
      lines.push(
        "**Surface coverage:** not reported — this gate recorded no coverage notes, so it makes no claim about the running surface.",
      );
    } else if (surfaceState === "exercised") {
      lines.push(
        `**Surface coverage:** exercised — the coverage notes record that the running surface WAS exercised (${counts}).`,
      );
    } else if (surfaceState === "not-exercised") {
      lines.push(
        `**Surface coverage:** not exercised — the coverage notes record that the running surface was NOT exercised (${counts}).`,
      );
    } else {
      lines.push(
        `**Surface coverage:** not reported — no coverage note states whether the running surface was exercised (${counts}).`,
      );
    }
    lines.push("");

    if (receipt.coverage === "none") {
      caveatReasons.push(
        `\`${receipt.kind}\`: coverage recorded as \`none\` — this gate exercised no coverage at all.`,
      );
    } else if (receipt.coverage === "partial") {
      caveatReasons.push(
        `\`${receipt.kind}\`: coverage recorded as \`partial\` — only part of the configured work was exercised.`,
      );
    }
  }

  const prSurfaceState = summarizeSurfaceExercise(receipts);

  if (prSurfaceState === "not-exercised") {
    caveatReasons.unshift(
      "the receipt coverage notes record that the running surface was NOT exercised.",
    );
  } else if (prSurfaceState === "not-reported") {
    caveatReasons.unshift(
      "no receipt coverage note states whether the running surface was exercised.",
    );
  }

  lines.push(`**PR-level surface coverage:** ${prSurfaceState}.`);
  lines.push("");

  if (caveatReasons.length > 0) {
    lines.push(
      "> **Coverage caveat — this PR is not fully verified.** The receipts above do not establish that the running application was exercised; passing configured code steps are not evidence that the running surface works.",
    );
    for (const reason of caveatReasons) {
      lines.push(`> - ${reason}`);
    }
    lines.push("");
  }

  return lines;
}

export const nyxWorktreePrTool = defineTool({
  name: "nyx_worktree_pr",
  description: "Verifies GREEN HMAC receipts bound to HEAD^{tree}, scans diff for secrets, and opens a PR.",
  annotations: {
    title: "Green-Only PR Gate",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: worktreePrInputSchema,
  outputSchema: worktreePrOutputSchema,
  handler: async (input, ctx) => {
    const wtRow = ctx.db.db
      .prepare(
        "SELECT task_slug, branch, worktree_path, base_branch FROM worktrees WHERE task_slug = ?",
      )
      .get(input.taskSlug) as
      | {
          task_slug: string;
          branch: string;
          worktree_path: string;
          base_branch: string;
        }
      | undefined;

    const worktreePath = input.worktreePath ?? wtRow?.worktree_path;
    if (!worktreePath || !fs.existsSync(worktreePath)) {
      throw new NyxError(
        "ERR_WORKTREE_NOT_FOUND",
        `Worktree for taskSlug "${input.taskSlug}" was not found`,
      );
    }

    const branch = wtRow?.branch ?? `nyx/${input.taskSlug}`;
    const baseBranch = wtRow?.base_branch ?? "main";

    // Step 1: Require a clean working tree and recompute HEAD^{tree} (§6 Engine 4)
    const dirtyFiles = await getDirtyFiles(worktreePath);
    if (dirtyFiles.length > 0) {
      throw new NyxError(
        "ERR_WORKTREE_DIRTY",
        `Worktree has ${dirtyFiles.length} uncommitted file(s). Commit all slice changes before calling nyx_worktree_pr.`,
        { dirtyFiles },
      );
    }

    const headTreeHash = await getHeadTreeHash(worktreePath);
    const workingTreeHash = await computeWorkingTreeHash(worktreePath);
    if (headTreeHash !== workingTreeHash) {
      throw new NyxError(
        "ERR_WORKTREE_DIRTY",
        "Working tree hash differs from HEAD^{tree}. Ensure all files are committed.",
      );
    }

    // Step 2: Validate receipt HMACs and required kinds for headTreeHash (§1.1.5, §7.3)
    const dnaRow = ctx.db.db
      .prepare("SELECT dna_json FROM dna WHERE repo_id = ?")
      .get(ctx.repoId) as { dna_json: string } | undefined;
    let httpSurface = false;
    if (dnaRow) {
      try {
        const parsed = JSON.parse(dnaRow.dna_json) as { httpSurface?: boolean };
        httpSurface = Boolean(parsed.httpSurface);
      } catch {
        // Default false
      }
    }

    const requiredKinds: ReceiptKind[] = [];
    const disabledGates: string[] = [];
    for (const kind of ["verify", "seam", "slop", "exploit"] as const) {
      const policy = ctx.config.gates[kind];
      if (policy === "off") {
        disabledGates.push(kind);
      } else {
        requiredKinds.push(kind);
      }
    }

    const key = ensureReceiptKey(ctx.nyxHome);
    const receiptRows = ctx.db.db
      .prepare(
        `SELECT id, kind, status, coverage, coverage_notes, limitations, worktree, branch, tree_hash,
                base_sha, commands_hash, evidence_artifact_id, na_justification, created_at, hmac
         FROM receipts
         WHERE worktree = ? OR branch = ?
         ORDER BY created_at DESC`,
      )
      .all(worktreePath, branch) as Array<{
      id: string;
      kind: ReceiptKind;
      status: "GREEN" | "RED" | "NA";
      coverage: "full" | "partial" | "none" | null;
      coverage_notes: string | null;
      limitations: string | null;
      worktree: string;
      branch: string;
      tree_hash: string;
      base_sha: string;
      commands_hash: string;
      evidence_artifact_id: string | null;
      na_justification: string | null;
      created_at: string;
      hmac: string;
    }>;

    const verifiedReceipts: VerifiedReceiptView[] = [];

    for (const reqKind of requiredKinds) {
      const candidates = receiptRows.filter((r) => r.kind === reqKind);
      if (candidates.length === 0) {
        throw new NyxError(
          "ERR_RECEIPT_MISSING",
          `Missing required "${reqKind}" receipt for branch ${branch}`,
        );
      }

      // Check latest receipt of this kind
      const latest = candidates[0]!;
      // The optional evidence fields are part of the signed payload. They are
      // included ONLY when the stored column decodes to a list, so a legacy
      // receipt (NULL columns) canonicalizes to exactly the same JSON — and
      // therefore to exactly the same HMAC — as when it was signed.
      const coverageNotes = decodeOptionalNoteList(latest.coverage_notes);
      const limitations = decodeOptionalNoteList(latest.limitations);
      const signedObj: SignedReceipt = {
        id: latest.id,
        kind: latest.kind,
        status: latest.status,
        ...(latest.coverage ? { coverage: latest.coverage } : {}),
        ...(coverageNotes !== undefined ? { coverageNotes } : {}),
        ...(limitations !== undefined ? { limitations } : {}),
        worktree: latest.worktree,
        branch: latest.branch,
        treeHash: latest.tree_hash,
        baseSha: latest.base_sha,
        commandsHash: latest.commands_hash,
        evidenceArtifactId: latest.evidence_artifact_id,
        ...(latest.na_justification ? { naJustification: latest.na_justification } : {}),
        createdAt: latest.created_at,
        hmac: latest.hmac,
      };

      const check = verifyReceipt(signedObj, key, {
        expectedTreeHash: headTreeHash,
        requireGreenOrNa: true,
        httpSurface,
      });

      if (!check.valid) {
        const code = check.reason?.includes("treeHash")
          ? "ERR_RECEIPT_STALE_TREE"
          : "ERR_RECEIPT_INVALID";
        throw new NyxError(
          code,
          `Receipt validation failed for "${reqKind}" (${latest.id}): ${check.reason}`,
        );
      }

      verifiedReceipts.push({
        id: latest.id,
        kind: latest.kind,
        status: latest.status as "GREEN" | "NA",
        ...(latest.coverage ? { coverage: latest.coverage } : {}),
        ...(coverageNotes !== undefined ? { coverageNotes } : {}),
        ...(limitations !== undefined ? { limitations } : {}),
      });
    }

    // Step 3: Run diff secret scan on git diff <base>...HEAD (§6 Engine 4)
    const secretFindings = await scanDiffForSecrets(worktreePath, baseBranch);
    if (secretFindings.length > 0) {
      throw new NyxError(
        "ERR_SECRET_DETECTED",
        `Diff secret scan blocked PR: found ${secretFindings.length} secret(s) in diff (${secretFindings.map((f) => `${f.ruleId} at ${f.filePath}:${f.line}`).join(", ")})`,
        { findings: secretFindings },
      );
    }

    // Step 4: Flag red-line CI/CD paths (§1.1.4, §6 Engine 4)
    const changedFilesRes = await execCommand(
      "git",
      ["diff", "--name-only", `${baseBranch}...HEAD`],
      { cwd: worktreePath },
    );
    const changedFiles = changedFilesRes.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const ciFiles = changedFiles.filter(isRedlineCiPath);
    if (ciFiles.length > 0 && !input.allowCiChanges) {
      throw new NyxError(
        "ERR_REDLINE_BLOCKED",
        `Red-Line Gate: PR modifies CI/CD workflow file(s) (${ciFiles.join(", ")}). Explicit user confirmation (allowCiChanges: true) is required.`,
        { ciFiles },
      );
    }

    // Extract suppression directives from diff
    const fullDiffRes = await execCommand("git", ["diff", `${baseBranch}...HEAD`], {
      cwd: worktreePath,
    });
    const suppressions = extractAllowSuppressionsFromDiff(fullDiffRes.stdout);

    // Step 5: Build PR Body with Receipts Table, Coverage & Limitations, Suppressions, and Nyxowl Footer
    const receiptTableRows = verifiedReceipts.map(
      (r) =>
        `| \`${r.kind}\` | **${r.status}** | \`${r.id}\` | \`${headTreeHash.slice(0, 12)}\` | ${formatCoverageCell(r.coverage)} |`,
    );

    const prBodyLines = [
      `## Summary`,
      input.summary,
      ``,
      `## Nyxowl Verification Receipts (\`HEAD^{tree} = ${headTreeHash.slice(0, 12)}\`)`,
      `| Gate | Status | Receipt ID | Tree Hash | Coverage |`,
      `| :--- | :--- | :--- | :--- | :--- |`,
      ...receiptTableRows,
      ``,
      ...renderCoverageAndLimitationsSection(verifiedReceipts),
    ];

    if (disabledGates.length > 0) {
      prBodyLines.push(``, `> **Note:** Disabled gates per config: ${disabledGates.join(", ")}`);
    }
    if (suppressions.length > 0) {
      prBodyLines.push(
        ``,
        `## Slop Gate Suppressions (\`nyx-allow\`)`,
        ...suppressions.map((s) => `- ${s}`),
      );
    }

    prBodyLines.push(
      ``,
      `---`,
      `*Opened by Nyxowl v${NYXOWL_VERSION} — Zero-Slop Autonomous Engineering Team*`,
    );

    const prBody = prBodyLines.join("\n");

    // Step 6: Check remote & gh CLI availability
    const remoteRes = await execCommand("git", ["remote", "get-url", "origin"], {
      cwd: worktreePath,
    });
    const hasOrigin = remoteRes.exitCode === 0 && remoteRes.stdout.trim().length > 0;

    let ghAvailable = false;
    if (hasOrigin && ctx.config.github.mode !== "local") {
      const ghAuth = await execCommand("gh", ["auth", "status"], {
        cwd: worktreePath,
        timeoutMs: 10_000,
      });
      ghAvailable = ghAuth.exitCode === 0;
    }

    if (hasOrigin && ghAvailable) {
      await execCommand("git", ["push", "-u", "origin", branch], {
        cwd: worktreePath,
        timeoutMs: 30_000,
        throwOnNonZero: true,
      });

      const published = await publishPrToGitHub({
        worktreePath,
        branch,
        baseBranch,
        title: input.title,
        prBody,
        waitForChecks: input.waitForChecks ?? false,
        ...(input.checkTimeoutMs !== undefined
          ? { checkTimeoutMs: input.checkTimeoutMs }
          : {}),
      });

      return {
        taskSlug: input.taskSlug,
        branch,
        headTreeHash,
        mode: "gh" as const,
        prUrl: published.prUrl,
        prNumber: published.prNumber,
        localPrFilePath: null,
        notice: published.notice,
        ciStatus: published.ciStatus,
        ciChecks: published.ciChecks,
        ciNotice: published.ciNotice,
        verifiedReceipts,
        suppressions,
        prBody,
      };
    }
    // Local PR fallback when no gh auth or no remote (§1.1.6)
    const localPrFilePath = path.join(ctx.projectLayout.prsDir, `${input.taskSlug}.md`);
    fs.mkdirSync(ctx.projectLayout.prsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(localPrFilePath, `# ${input.title}\n\n${prBody}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    return {
      taskSlug: input.taskSlug,
      branch,
      headTreeHash,
      mode: "local" as const,
      prUrl: null,
      prNumber: null,
      localPrFilePath,
      notice: `Branch ${branch} verified. PR body written to ${localPrFilePath} — run "gh auth login" to enable automatic PRs.`,
      ciStatus: "not-applicable" as const,
      ciChecks: [],
      ciNotice: buildCiNotice("not-applicable", [], null, false),
      verifiedReceipts,
      suppressions,
      prBody,
    };
  },
});

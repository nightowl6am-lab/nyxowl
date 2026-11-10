import type { ExecOptions, ExecResult } from "../../../core/exec.ts";

/**
 * CI observation for a published pull request.
 *
 * This module never performs network egress itself: every GitHub call is made
 * through an injected executor, so the callers can run it for real via
 * `execCommand` and the tests can drive it deterministically.
 */

/** One normalized entry of `statusCheckRollup`. */
export interface CiCheck {
  name: string;
  /** GitHub check status, e.g. QUEUED / IN_PROGRESS / COMPLETED. */
  status: string;
  /** GitHub check conclusion, e.g. SUCCESS / FAILURE; null while not done. */
  conclusion: string | null;
  url: string;
  /** Actions run id parsed from the details URL, when present. */
  runId: string | null;
}

/** Aggregated CI state for a pull request. */
export type CiStatusSummary = "passed" | "failed" | "pending" | "unknown";

/** Snapshot of the check rollup at one point in time. */
export interface CiSnapshot {
  status: CiStatusSummary;
  checks: CiCheck[];
  headRefOid: string | null;
}

/** Snapshot returned once polling stops. */
export interface CiWaitSnapshot extends CiSnapshot {
  timedOut: boolean;
}

/** Minimal executor shape, compatible with `execCommand` and test stubs. */
export type CiExec = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Conclusions that make the whole rollup failed. */
const FAILURE_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
]);

/** Conclusions GitHub treats as a non-blocking successful completion. */
const SUCCESS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Parses a GitHub actions details URL of the form
 * `https://github.com/<owner>/<repo>/actions/runs/<runId>/job/<jobId>` and
 * returns `<runId>`. Returns null when the URL is not an actions run URL.
 */
export function extractRunId(detailsUrl: string): string | null {
  const match = /\/actions\/runs\/(\d+)(?:\/job\/\d+)?(?:[/?#]|$)/.exec(detailsUrl);
  return match?.[1] ?? null;
}

/**
 * Normalizes a `StatusContext` entry (the legacy commit-status shape) into the
 * same check shape used for `CheckRun` entries.
 */
function normalizeStatusContext(record: Record<string, unknown>): CiCheck | null {
  const name = readString(record, "context") ?? readString(record, "name");
  if (!name) return null;

  const state = (readString(record, "state") ?? "").toUpperCase();
  const url = readString(record, "targetUrl") ?? readString(record, "detailsUrl") ?? "";

  if (state === "SUCCESS") {
    return { name, status: "COMPLETED", conclusion: "SUCCESS", url, runId: extractRunId(url) };
  }
  if (state === "FAILURE" || state === "ERROR") {
    return { name, status: "COMPLETED", conclusion: "FAILURE", url, runId: extractRunId(url) };
  }
  if (state === "PENDING" || state === "EXPECTED" || state === "") {
    return { name, status: "PENDING", conclusion: null, url, runId: extractRunId(url) };
  }
  // Unknown legacy state: report it as pending so it can never be mistaken
  // for a passing check.
  return { name, status: "PENDING", conclusion: null, url, runId: extractRunId(url) };
}

/**
 * Parses the stdout of
 * `gh pr view <n> --json statusCheckRollup,headRefOid` into typed checks.
 *
 * Deliberately defensive: malformed JSON, an empty payload, or an unexpected
 * shape yields `[]` instead of throwing. Individual malformed entries are
 * skipped.
 */
export function parseCheckRollup(jsonText: string): CiCheck[] {
  if (typeof jsonText !== "string" || jsonText.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const root = asRecord(parsed);
  if (!root) return [];

  const rollup = root["statusCheckRollup"];
  if (!Array.isArray(rollup)) return [];

  const checks: CiCheck[] = [];
  for (const entry of rollup) {
    const record = asRecord(entry);
    if (!record) continue;

    const typename = readString(record, "__typename") ?? "";
    const looksLikeStatusContext =
      typename === "StatusContext" ||
      (typename === "" && typeof record["context"] === "string" && !("name" in record));

    if (looksLikeStatusContext) {
      const check = normalizeStatusContext(record);
      if (check) checks.push(check);
      continue;
    }

    const name = readString(record, "name");
    if (!name) continue;

    const status = (readString(record, "status") ?? "").toUpperCase();
    const conclusionRaw = readString(record, "conclusion");
    const url =
      readString(record, "detailsUrl") ??
      readString(record, "targetUrl") ??
      readString(record, "url") ??
      "";

    checks.push({
      name,
      status,
      conclusion: conclusionRaw ? conclusionRaw.toUpperCase() : null,
      url,
      runId: extractRunId(url),
    });
  }

  return checks;
}

/**
 * Aggregates a check list into `passed | failed | pending | unknown`.
 *
 * - failed: any conclusion is FAILURE / TIMED_OUT / CANCELLED / ACTION_REQUIRED
 * - pending: any check has not reached COMPLETED
 * - passed: at least one check, all completed successfully
 * - unknown: no checks, or completed with an unrecognized conclusion
 */
export function summarizeCiStatus(checks: CiCheck[]): CiStatusSummary {
  if (checks.length === 0) return "unknown";

  if (
    checks.some((check) => FAILURE_CONCLUSIONS.has((check.conclusion ?? "").toUpperCase()))
  ) {
    return "failed";
  }

  if (checks.some((check) => check.status.toUpperCase() !== "COMPLETED")) {
    return "pending";
  }

  if (
    checks.every((check) => SUCCESS_CONCLUSIONS.has((check.conclusion ?? "").toUpperCase()))
  ) {
    return "passed";
  }

  return "unknown";
}

function parseHeadRefOid(jsonText: string): string | null {
  try {
    const root = asRecord(JSON.parse(jsonText));
    if (!root) return null;
    return readString(root, "headRefOid");
  } catch {
    return null;
  }
}

export interface CollectPrChecksOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Runs `gh pr view <n> --json statusCheckRollup,headRefOid` through the
 * injected executor and returns the normalized snapshot.
 *
 * The PR number is passed as a separate argv element and validated as a
 * positive integer, so it is never shell-interpolated. A failed command
 * yields the conservative `unknown` snapshot.
 */
export async function collectPrChecks(
  exec: CiExec,
  prNumber: number,
  options: CollectPrChecksOptions = {},
): Promise<CiSnapshot> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { status: "unknown", checks: [], headRefOid: null };
  }

  const execOptions: ExecOptions = { timeoutMs: options.timeoutMs ?? 30_000 };
  if (options.cwd !== undefined) {
    execOptions.cwd = options.cwd;
  }

  let result: ExecResult;
  try {
    result = await exec(
      "gh",
      ["pr", "view", String(prNumber), "--json", "statusCheckRollup,headRefOid"],
      execOptions,
    );
  } catch {
    return { status: "unknown", checks: [], headRefOid: null };
  }

  if (result.exitCode !== 0) {
    return { status: "unknown", checks: [], headRefOid: null };
  }

  const checks = parseCheckRollup(result.stdout);
  return {
    status: summarizeCiStatus(checks),
    checks,
    headRefOid: parseHeadRefOid(result.stdout),
  };
}

export interface WaitForPrChecksOptions extends CollectPrChecksOptions {
  /** Overall polling budget. */
  timeoutMs?: number;
  /** Delay between polls. */
  intervalMs?: number;
  /** Injected sleep so tests never wait on the clock. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Polls the check rollup until it reaches a terminal state (passed/failed) or
 * the timeout budget is exhausted. `unknown` stops immediately: there is no
 * rollup to observe, so polling would never produce a different answer.
 *
 * Returns the last snapshot plus `timedOut`, which is true only when the loop
 * stopped while checks were still pending.
 */
export async function waitForPrChecks(
  exec: CiExec,
  prNumber: number,
  options: WaitForPrChecksOptions = {},
): Promise<CiWaitSnapshot> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 300_000);
  const intervalMs = Math.max(1, options.intervalMs ?? 5_000);
  const sleep = options.sleep ?? defaultSleep;

  const first = await collectPrChecks(exec, prNumber, options);
  if (first.status !== "pending") {
    return { ...first, timedOut: false };
  }

  let elapsed = 0;
  let snapshot = first;

  while (elapsed < timeoutMs) {
    const remaining = timeoutMs - elapsed;
    const step = Math.min(intervalMs, remaining);
    await sleep(step);
    elapsed += step;

    snapshot = await collectPrChecks(exec, prNumber, options);
    if (snapshot.status !== "pending") {
      return { ...snapshot, timedOut: false };
    }
  }

  return { ...snapshot, timedOut: snapshot.status === "pending" };
}

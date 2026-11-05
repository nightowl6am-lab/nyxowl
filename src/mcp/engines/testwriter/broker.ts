import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NyxError } from "../../../core/errors.ts";
import { createLogger } from "../../../core/logger.ts";

const logger = createLogger("testwriter");

export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_TEST_BYTES = 51200;
export const MAX_NOTES_BYTES = 4096;
export const GRADER_USER = "tw-grader";

export const STDOUT_CAP_BYTES = 1024 * 1024;
export const STDERR_CAP_BYTES = 64 * 1024;
export const REPORT_CAP_BYTES = 200 * 1024;

export type WrapperName = "gate" | "status" | "newJob";

const WRAPPER_FILES: Record<WrapperName, string> = {
  gate: "tw-gate",
  status: "tw-status",
  newJob: "tw-new-job",
};

export function validateJobId(value: string): string {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) {
    throw new NyxError(
      "ERR_INVALID_INPUT",
      "Invalid Test-Writer job id: expected 1-40 characters matching [A-Za-z0-9_-]",
    );
  }
  return value;
}

export function installRoot(): string {
  return process.env["TW_INSTALL_ROOT"] ?? "/opt/test-writer";
}

export function wrapperPath(name: WrapperName): string {
  // Callers can only select one of the fixed wrapper names; they never supply a path.
  return path.join(installRoot(), "bin", WRAPPER_FILES[name]);
}

export function workspaceRoot(): string {
  return process.env["TW_WORKSPACE_ROOT"] ?? path.join(os.homedir(), "tw-jobs");
}

export function stagedTestPath(jobId: string): string {
  const id = validateJobId(jobId);
  const root = path.resolve(workspaceRoot());
  const candidate = path.resolve(root, id, "tests", `test_${id}.py`);
  const rel = path.relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new NyxError("ERR_INVALID_INPUT", "Resolved Test-Writer test path escapes the workspace");
  }
  return candidate;
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildGraderArgv(wrapper: WrapperName, args: string[]): string[] {
  return ["/usr/bin/sudo", "-n", "-u", GRADER_USER, wrapperPath(wrapper), ...args];
}

export function buildOwnerArgv(wrapper: WrapperName, args: string[]): string[] {
  return [wrapperPath(wrapper), ...args];
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function unavailableError(): NyxError {
  return new NyxError(
    "ERR_TESTWRITER_UNAVAILABLE",
    "Test-Writer runtime is not installed. Owner: run test-writer/bootstrap/install-root.sh or set TW_INSTALL_ROOT before using nyx-testwriter tools.",
  );
}

function assertWrapperAvailable(wrapper: WrapperName): void {
  const target = wrapperPath(wrapper);
  try {
    if (!fs.statSync(target).isFile()) throw unavailableError();
    fs.accessSync(target, fs.constants.X_OK);
  } catch {
    // Owner-side wrappers must be installed as executable regular files.
    throw unavailableError();
  }
}

function assertExecutable(executable: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(executable);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw unavailableError();
    throw new NyxError(
      "ERR_EXEC_FAILED",
      `Test-Writer wrapper executable is not runnable (${code ?? "unknown"})`,
    );
  }
  if (!stat.isFile()) {
    throw new NyxError("ERR_EXEC_FAILED", "Test-Writer wrapper executable is not a regular file");
  }
  try {
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    throw new NyxError("ERR_EXEC_FAILED", "Test-Writer wrapper executable lacks execute permission");
  }
}

export async function runProcess(
  argv: string[],
  opts: { input?: string; timeoutMs: number },
): Promise<ProcessResult> {
  const executable = argv[0];
  if (!executable) {
    throw unavailableError();
  }
  // Missing runtime => unavailable; present but non-executable => exec failed.
  assertExecutable(executable);

  return new Promise<ProcessResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, argv.slice(1), {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        // tw-gate may spawn bwrap/prlimit; a new group lets timeout kill the whole tree.
        detached: true,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: os.homedir(),
          LANG: "C.UTF-8",
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(unavailableError());
      } else {
        reject(new NyxError("ERR_EXEC_FAILED", `Failed to spawn Test-Writer wrapper (${code ?? "unknown"})`));
      }
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      // tw-gate may spawn bwrap/prlimit; killing only sudo would orphan them.
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already exited.
          }
        }
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      }
      finish(() => {
        reject(
          new NyxError("ERR_EXEC_TIMEOUT", `Test-Writer wrapper timed out after ${opts.timeoutMs}ms`),
        );
      });
    }, opts.timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= STDOUT_CAP_BYTES) {
        stdoutTruncated = true;
        return;
      }
      const remaining = STDOUT_CAP_BYTES - stdoutBytes;
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_CAP_BYTES) {
        stderrTruncated = true;
        return;
      }
      const remaining = STDERR_CAP_BYTES - stderrBytes;
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        stderrTruncated = true;
      }
    });

    child.stdin?.on("error", () => {
      // The wrapper may exit before reading stdin; surface its exit code instead.
    });
    if (child.stdin) {
      if (opts.input !== undefined) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    }

    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      logger.debug("Test-Writer wrapper spawn error", { code: code ?? "unknown" });
      finish(() => {
        if (code === "ENOENT") {
          reject(unavailableError());
        } else {
          reject(
            new NyxError(
              "ERR_EXEC_FAILED",
              `Failed to spawn Test-Writer wrapper (${code ?? "unknown"})`,
            ),
          );
        }
      });
    });

    child.on("close", (code) => {
      finish(() => {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (stderr) {
          logger.debug("Test-Writer wrapper wrote to stderr", {
            bytes: stderrBytes,
            truncated: stderrTruncated,
          });
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr,
          code: code ?? 1,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  });
}

function tryParseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function runWrapperJson(
  wrapper: WrapperName,
  args: string[],
  opts: { input?: string; timeoutMs: number; asGrader: boolean },
): Promise<unknown> {
  assertWrapperAvailable(wrapper);
  const argv = opts.asGrader ? buildGraderArgv(wrapper, args) : buildOwnerArgv(wrapper, args);
  const result = await runProcess(argv, {
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    timeoutMs: opts.timeoutMs,
  });

  if (result.stdoutTruncated) {
    throw new NyxError("ERR_FILE_TOO_LARGE", "Test-Writer wrapper output exceeded the 1 MiB cap");
  }

  if (result.code !== 0) {
    const parsed = tryParseObject(result.stdout);
    if (parsed) return parsed;
    throw new NyxError(
      "ERR_EXEC_FAILED",
      `Test-Writer wrapper "${wrapper}" exited with code ${result.code}`,
    );
  }

  const parsed = tryParseObject(result.stdout);
  if (!parsed) {
    throw new NyxError(
      "ERR_TESTWRITER_PROTOCOL",
      `Test-Writer wrapper "${wrapper}" returned invalid JSON`,
    );
  }
  return parsed;
}

export async function runWrapperText(
  wrapper: WrapperName,
  args: string[],
  opts: { input?: string; timeoutMs: number; asGrader: boolean },
): Promise<string> {
  assertWrapperAvailable(wrapper);
  const argv = opts.asGrader ? buildGraderArgv(wrapper, args) : buildOwnerArgv(wrapper, args);
  const result = await runProcess(argv, {
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    timeoutMs: opts.timeoutMs,
  });

  if (result.stdoutTruncated || Buffer.byteLength(result.stdout, "utf8") > REPORT_CAP_BYTES) {
    throw new NyxError("ERR_FILE_TOO_LARGE", "Test-Writer report exceeded the 200 KiB cap");
  }
  if (result.code !== 0) {
    throw new NyxError(
      "ERR_EXEC_FAILED",
      `Test-Writer wrapper "${wrapper}" exited with code ${result.code}`,
    );
  }
  return result.stdout;
}

const FEEDBACK_KEYS = [
  "attempt",
  "verdict",
  "reason",
  "closed",
  "hint",
  "counts",
  "test_traceback",
  "budget",
  "violations",
  "ok",
  "setup_error",
  "message",
] as const;

const FORBIDDEN_MARKERS = ["canary", "/canary", "variant", "mutant", "stdout", "stderr"];

function containsForbiddenMarker(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return true;
  }
  const lowered = serialized.toLowerCase();
  return FORBIDDEN_MARKERS.some((marker) => lowered.includes(marker));
}

const STRING_CAPS: Record<string, number> = {
  hint: 2000,
  test_traceback: 20000,
  message: 2000,
  verdict: 500,
  reason: 1000,
};

export function sanitizeFeedback(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const source = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of FEEDBACK_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    if (containsForbiddenMarker(value)) continue;
    if (typeof value === "string") {
      const cap = STRING_CAPS[key] ?? 2000;
      result[key] = value.length > cap ? value.slice(0, cap) : value;
    } else {
      result[key] = value;
    }
  }

  return result;
}

export type JobReason = "JOB_CLOSED" | "JOB_NOT_OPEN" | "UNSUPPORTED_STACK" | "JOB_MISSING";

export interface NormalizedJobInputs {
  jobId: string;
  status: string;
  applicable: boolean;
  targetStack: string;
  reason: JobReason | null;
  spec: string;
  interface: string;
  detector: unknown;
  helperApi: string;
  budget: unknown;
}

function readString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function assertBytes(value: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new NyxError("ERR_FILE_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  }
}

export function normalizeJobInputs(raw: unknown): NormalizedJobInputs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      jobId: "",
      status: "missing",
      applicable: false,
      targetStack: "",
      reason: "JOB_MISSING",
      spec: "",
      interface: "",
      detector: null,
      helperApi: "",
      budget: null,
    };
  }

  const source = raw as Record<string, unknown>;
  const jobId = readString(source, ["jobId", "job_id", "id"]);
  const status = readString(source, ["status"]);
  const targetStack = readString(source, ["targetStack", "target_stack", "stack"]);
  const spec = readString(source, ["spec", "spec_markdown"]);
  const iface = readString(source, ["interface", "interface_markdown"]);
  const helperApi = readString(source, ["helperApi", "helper_api"]);
  const detector = source["detector"] ?? null;
  const budget = source["budget"] ?? null;

  assertBytes(spec, 200_000, "Job spec");
  assertBytes(iface, 100_000, "Job interface");
  assertBytes(helperApi, 50_000, "Job helper API");

  const normalizedStatus = status.toLowerCase();
  const normalizedStack = targetStack.toLowerCase();
  let reason: JobReason | null = null;

  if (!status) {
    reason = "JOB_MISSING";
  } else if (normalizedStatus === "closed") {
    reason = "JOB_CLOSED";
  } else if (normalizedStatus !== "approved" && normalizedStatus !== "running") {
    reason = "JOB_NOT_OPEN";
  } else if (normalizedStack !== "python" && normalizedStack !== "python3") {
    reason = "UNSUPPORTED_STACK";
  }

  return {
    jobId,
    status,
    applicable: reason === null,
    targetStack,
    reason,
    spec,
    interface: iface,
    detector,
    helperApi,
    budget,
  };
}

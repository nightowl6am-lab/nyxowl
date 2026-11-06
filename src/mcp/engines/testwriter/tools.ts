import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { defineTool } from "../../tool.ts";
import {
  MAX_NOTES_BYTES,
  MAX_TEST_BYTES,
  normalizeJobInputs,
  runWrapperJson,
  runWrapperText,
  sanitizeFeedback,
  sha256Text,
  stagedTestPath,
  validateJobId,
} from "./broker.ts";

const STATUS_TIMEOUT_MS = 15_000;
const GATE_TIMEOUT_MS = 120_000;
const NEW_JOB_TIMEOUT_MS = 30_000;

const jobIdSchema = z.string();

const jobInputSchema = z.strictObject({
  jobId: jobIdSchema,
});

const jobOutputSchema = z.record(z.string(), z.unknown());

const writeInputSchema = z.strictObject({
  jobId: jobIdSchema,
  content: z.string(),
});

const writeOutputSchema = z.object({
  jobId: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
});

const lintInputSchema = z.strictObject({
  jobId: jobIdSchema,
});

const lintOutputSchema = z.object({
  ok: z.boolean(),
  violations: z.array(z.unknown()),
});

const feedbackSchema = z.record(z.string(), z.unknown());

const finishInputSchema = z.strictObject({
  jobId: jobIdSchema,
  notes: z.string(),
  flags: z.array(z.string()),
});

const statusInputSchema = z.strictObject({
  jobId: jobIdSchema,
  report: z.boolean().optional(),
});

const statusOutputSchema = z.record(z.string(), z.unknown());

const prepareInputSchema = z.strictObject({
  jobId: z.string(),
  repoPath: z.string(),
  vulnerableRef: z.string(),
  patchedRef: z.string(),
  module: z.string(),
  function: z.string(),
  fixOrigin: z.enum(["upstream", "reference"]),
  specMarkdown: z.string(),
  pythonPath: z.array(z.string()).optional(),
});

const prepareOutputSchema = z.object({
  jobId: z.string(),
  workspaceHint: z.string(),
  nextAction: z.string(),
});

const REF_PATTERN = /^[0-9a-f]{40}$/;
const MODULE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const FUNCTION_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REQUIRED_SPEC_HEADINGS = [
  "## Claim",
  "## Intended behavior",
  "## Rejection behavior",
  "## Entry point",
  "## Benign example",
  "## Detector",
] as const;

const NEXT_ACTION =
  "Owner: review spec and variants, then run tw-approve <id> in a terminal.";

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NyxError("ERR_TESTWRITER_PROTOCOL", `${label} did not return a JSON object`);
  }
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function readNumber(value: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim() !== "" && !Number.isNaN(Number(candidate))) {
      return Number(candidate);
    }
  }
  return 0;
}

function readStringArray(value: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is string => typeof item === "string");
    }
  }
  return [];
}

async function readJobStatus(jobId: string): Promise<Record<string, unknown>> {
  const raw = await runWrapperJson("status", [jobId], {
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  return asObject(raw, "tw-status");
}

function requireWritableStatus(job: Record<string, unknown>, jobId: string): string {
  const status = readString(job, ["status"]).toLowerCase();
  if (status !== "approved" && status !== "running") {
    throw new NyxError(
      "ERR_INVALID_INPUT",
      `Test-Writer job "${jobId}" is not approved or running (status: ${status || "unknown"})`,
    );
  }
  return status;
}

function readStagedTest(jobId: string): string {
  const filePath = stagedTestPath(jobId);
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    throw new NyxError(
      "ERR_TESTWRITER_TEST_MISSING",
      `No staged test found for Test-Writer job "${jobId}". Call nyx_testwriter_write first.`,
    );
  }
}

function requireContentWithinLimit(content: string): number {
  const wellFormed = (content as string & { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof wellFormed === "function" && !wellFormed.call(content)) {
    throw new NyxError("ERR_INVALID_INPUT", "Test content contains malformed UTF-16 data");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_TEST_BYTES) {
    throw new NyxError(
      "ERR_FILE_TOO_LARGE",
      `Test content is ${bytes} bytes; the maximum is ${MAX_TEST_BYTES} bytes`,
    );
  }
  return bytes;
}

const ALLOWED_FINISH_FLAGS = new Set(["INJECTION_SUSPECTED", "SPEC_INSUFFICIENT"]);

function assertFinishFlags(flags: string[]): void {
  for (const flag of flags) {
    if (!ALLOWED_FINISH_FLAGS.has(flag)) {
      throw new NyxError(
        "ERR_INVALID_INPUT",
        `Unsupported Test-Writer flag "${flag}"; allowed: INJECTION_SUSPECTED, SPEC_INSUFFICIENT`,
      );
    }
  }
}

function assertRefs(vulnerableRef: string, patchedRef: string): void {
  if (!REF_PATTERN.test(vulnerableRef)) {
    throw new NyxError(
      "ERR_INVALID_INPUT",
      "vulnerableRef must be exactly 40 lowercase hexadecimal characters",
    );
  }
  if (!REF_PATTERN.test(patchedRef)) {
    throw new NyxError(
      "ERR_INVALID_INPUT",
      "patchedRef must be exactly 40 lowercase hexadecimal characters",
    );
  }
  if (vulnerableRef === patchedRef) {
    throw new NyxError("ERR_INVALID_INPUT", "vulnerableRef and patchedRef must be distinct");
  }
}

function assertRepoPath(repoPath: string): void {
  if (!path.isAbsolute(repoPath)) {
    throw new NyxError("ERR_INVALID_INPUT", "repoPath must be an absolute path");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch {
    throw new NyxError("ERR_INVALID_INPUT", `repoPath does not exist: ${repoPath}`);
  }
  if (!stat.isDirectory()) {
    throw new NyxError("ERR_INVALID_INPUT", `repoPath is not a directory: ${repoPath}`);
  }
}

function assertSpecMarkdown(specMarkdown: string): void {
  const bytes = Buffer.byteLength(specMarkdown, "utf8");
  if (bytes > 200_000) {
    throw new NyxError(
      "ERR_FILE_TOO_LARGE",
      `specMarkdown is ${bytes} bytes; the maximum is 200000 bytes`,
    );
  }
  for (const heading of REQUIRED_SPEC_HEADINGS) {
    if (!specMarkdown.includes(heading)) {
      throw new NyxError("ERR_INVALID_INPUT", `specMarkdown is missing required heading "${heading}"`);
    }
  }
  if (!/^BENIGN:/m.test(specMarkdown)) {
    throw new NyxError("ERR_INVALID_INPUT", "specMarkdown is missing a BENIGN: line");
  }
}

function assertPythonPath(pythonPath: string[]): void {
  if (pythonPath.length > 20) {
    throw new NyxError("ERR_INVALID_INPUT", "pythonPath accepts at most 20 entries");
  }
  for (const entry of pythonPath) {
    if (
      entry.length === 0 ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.split("/").includes("..")
    ) {
      throw new NyxError(
        "ERR_INVALID_INPUT",
        "pythonPath entries must be relative POSIX paths without '..'",
      );
    }
  }
}

export const nyxTestwriterJobTool = defineTool({
  name: "nyx_testwriter_job",
  description: "Read job",
  annotations: {
    title: "Test-Writer Read Job",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: jobInputSchema,
  outputSchema: jobOutputSchema,
  handler: async (input) => {
    const jobId = validateJobId(input.jobId);
    const raw = asObject(
      await runWrapperJson("status", [jobId, "--inputs"], {
        timeoutMs: STATUS_TIMEOUT_MS,
      }),
      "tw-status --inputs",
    );
    return { ...normalizeJobInputs(raw), jobId };
  },
});

export const nyxTestwriterWriteTool = defineTool({
  name: "nyx_testwriter_write",
  description: "Stage",
  annotations: {
    title: "Test-Writer Stage Test",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: writeInputSchema,
  outputSchema: writeOutputSchema,
  handler: async (input) => {
    const jobId = validateJobId(input.jobId);
    const bytes = requireContentWithinLimit(input.content);

    // WHY: status runs as the owner through the installed wrapper; the store is
    // owner-only (0700) under the install root, not shared with another account.
    const status = await readJobStatus(jobId);
    requireWritableStatus(status, jobId);

    const filePath = stagedTestPath(jobId);
    const testsDir = path.dirname(filePath);
    fs.mkdirSync(testsDir, { recursive: true, mode: 0o700 });
    // WHY: mkdir's mode is ignored when the directory already exists, so a
    // pre-created permissive directory would keep its mode. Tighten it
    // explicitly; if chmod fails (for example because this account does not own
    // the directory) the error must propagate rather than silently accepting a
    // permissive staging path.
    fs.chmodSync(testsDir, 0o700);
    const tmpPath = path.join(
      testsDir,
      `.test_${jobId}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, input.content, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Ignore cleanup failure.
      }
      throw err;
    }

    return { jobId, sha256: sha256Text(input.content), bytes };
  },
});

export const nyxTestwriterLintTool = defineTool({
  name: "nyx_testwriter_lint",
  description: "Lint",
  annotations: {
    title: "Test-Writer Lint Test",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: lintInputSchema,
  outputSchema: lintOutputSchema,
  handler: async (input) => {
    const jobId = validateJobId(input.jobId);
    const content = readStagedTest(jobId);
    const raw = await runWrapperJson("gate", [jobId, "--lint-only"], {
      input: content,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    const sanitized = sanitizeFeedback(raw);
    const violations = Array.isArray(sanitized["violations"]) ? sanitized["violations"] : [];
    return { ok: sanitized["ok"] === true, violations };
  },
});

export const nyxTestwriterGateTool = defineTool({
  name: "nyx_testwriter_gate",
  description: "Gate",
  annotations: {
    title: "Test-Writer Run Gate",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: lintInputSchema,
  outputSchema: feedbackSchema,
  handler: async (input) => {
    const jobId = validateJobId(input.jobId);
    const content = readStagedTest(jobId);
    const raw = await runWrapperJson("gate", [jobId], {
      input: content,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return sanitizeFeedback(raw);
  },
});

export const nyxTestwriterFinishTool = defineTool({
  name: "nyx_testwriter_finish",
  description: "Finish",
  annotations: {
    title: "Test-Writer Finish Job",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: finishInputSchema,
  outputSchema: feedbackSchema,
  handler: async (input) => {
    const jobId = validateJobId(input.jobId);
    assertFinishFlags(input.flags);
    const noteBytes = Buffer.byteLength(input.notes, "utf8");
    if (noteBytes > MAX_NOTES_BYTES) {
      throw new NyxError(
        "ERR_FILE_TOO_LARGE",
        `notes is ${noteBytes} bytes; the maximum is ${MAX_NOTES_BYTES} bytes`,
      );
    }
    const raw = await runWrapperJson("gate", [jobId, "--finish"], {
      input: JSON.stringify({ notes: input.notes, flags: input.flags }),
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return sanitizeFeedback(raw);
  },
});

export const nyxTestwriterStatusTool = defineTool({
  name: "nyx_testwriter_status",
  description: "Status",
  annotations: {
    title: "Test-Writer Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: statusInputSchema,
  outputSchema: statusOutputSchema,
  handler: async (input) => {
    const jobId = validateJobId(input.jobId);
    // WHY: status and report run as the owner through the installed wrapper;
    // the store is owner-only (0700) under the install root.
    const raw = await readJobStatus(jobId);
    const report =
      input.report === true
        ? await runWrapperText("status", [jobId, "--report"], {
            timeoutMs: STATUS_TIMEOUT_MS,
          })
        : undefined;

    return {
      jobId,
      status: readString(raw, ["status"]),
      verdict: readString(raw, ["verdict"]) || null,
      reason: readString(raw, ["reason"]) || null,
      flags: readStringArray(raw, ["flags"]),
      attemptsUsed: readNumber(raw, ["attemptsUsed", "attempts_used", "attempts"]),
      ...(report !== undefined ? { report } : {}),
    };
  },
});

export const nyxTestwriterPrepareTool = defineTool({
  name: "nyx_testwriter_prepare",
  description: "Prepare",
  annotations: {
    title: "Test-Writer Prepare Job",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: prepareInputSchema,
  outputSchema: prepareOutputSchema,
  handler: async (input) => {
    assertRefs(input.vulnerableRef, input.patchedRef);
    assertRepoPath(input.repoPath);
    if (!MODULE_PATTERN.test(input.module)) {
      throw new NyxError("ERR_INVALID_INPUT", "module must be a Python dotted identifier");
    }
    if (!FUNCTION_PATTERN.test(input.function)) {
      throw new NyxError("ERR_INVALID_INPUT", "function must be a Python identifier");
    }
    assertSpecMarkdown(input.specMarkdown);
    const pythonPath = input.pythonPath ?? [];
    assertPythonPath(pythonPath);

    const jobId = validateJobId(input.jobId);
    const body = {
      id: jobId,
      repo: input.repoPath,
      vulnerable_ref: input.vulnerableRef,
      patched_ref: input.patchedRef,
      module: input.module,
      function: input.function,
      fix_origin: input.fixOrigin,
      spec_markdown: input.specMarkdown,
      python_path: pythonPath,
    };

    const raw = await runWrapperJson("newJob", ["--json"], {
      input: JSON.stringify(body),
      timeoutMs: NEW_JOB_TIMEOUT_MS,
    });
    const response = asObject(raw, "tw-new-job");
    const returnedId = readString(response, ["id", "jobId", "job_id"]);
    const finalId = returnedId ? validateJobId(returnedId) : jobId;

    return {
      jobId: finalId,
      workspaceHint: `~/tw-jobs/${finalId}`,
      nextAction: NEXT_ACTION,
    };
  },
});

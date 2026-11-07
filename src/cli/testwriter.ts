import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execCommand } from "../core/exec.ts";
import { resolvePackageRoot } from "./skills.ts";

export const TEST_WRITER_WRAPPER_NAMES = [
  "tw-new-job",
  "tw-add-variant",
  "tw-approve",
  "tw-store-job",
  "tw-gate",
  "tw-status",
] as const;

export type TestWriterWrapperName = (typeof TEST_WRITER_WRAPPER_NAMES)[number];

const REQUIRED_SOURCE_FILES = [
  path.join("bootstrap", "install-user.sh"),
  path.join("bootstrap", "build-user-venv.sh"),
  path.join("bin", "tw-gate"),
] as const;

export interface TestWriterWrapperStatus {
  name: TestWriterWrapperName;
  path: string;
  executable: boolean;
}

export interface TestWriterStatus {
  root: string;
  ready: boolean;
  wrappers: TestWriterWrapperStatus[];
  venv: { dir: string; python: string; ready: boolean };
  store: string;
  source: string;
}

export type TestWriterInstallStatus =
  | "disabled"
  | "already-installed"
  | "unavailable"
  | "installed"
  | "failed";

export interface TestWriterInstallResult {
  status: TestWriterInstallStatus;
  root: string;
  message: string;
  lines: string[];
}

export interface EnsureTestWriterOptions {
  nyxowlHome?: string;
  sourceDir?: string;
  force?: boolean;
  envPath?: string;
  install?: boolean;
}

/**
 * Rootless Test-Writer install root. It follows NYXOWL_HOME so a custom
 * Nyxowl home also relocates the runtime; TW_INSTALL_ROOT only overrides the
 * broker, not this installer.
 */
export function testWriterRoot(nyxowlHome?: string): string {
  const home =
    nyxowlHome ?? process.env["NYXOWL_HOME"] ?? path.join(os.homedir(), ".nyxowl");
  return path.join(home, "test-writer");
}

/** Source tree shipped inside the npm package. */
export function testWriterSourceDir(pkgRoot?: string): string {
  return path.join(pkgRoot ?? resolvePackageRoot(), "test-writer");
}

export function isTestWriterSourceReady(sourceDir: string): boolean {
  return REQUIRED_SOURCE_FILES.every((relativePath) => {
    try {
      return fs.statSync(path.join(sourceDir, relativePath)).isFile();
    } catch {
      return false;
    }
  });
}

function wrapperStatus(root: string): TestWriterWrapperStatus[] {
  return TEST_WRITER_WRAPPER_NAMES.map((name) => {
    const wrapperFile = path.join(root, "bin", name);
    let executable = false;
    try {
      const stat = fs.statSync(wrapperFile);
      executable = stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      executable = false;
    }
    return { name, path: wrapperFile, executable };
  });
}

export function testWriterStatus(root: string, sourceDir?: string): TestWriterStatus {
  const wrappers = wrapperStatus(root);
  const venvDir = path.join(root, "venv");
  const python = path.join(venvDir, "bin", "python");
  let venvReady = false;
  try {
    venvReady = fs.statSync(python).isFile();
  } catch {
    venvReady = false;
  }
  let source = sourceDir ?? "";
  if (!source) {
    try {
      source = testWriterSourceDir();
    } catch {
      source = "";
    }
  }
  return {
    root,
    ready: wrappers.every((wrapper) => wrapper.executable) && venvReady,
    wrappers,
    venv: { dir: venvDir, python, ready: venvReady },
    store: path.join(root, "store"),
    source,
  };
}

function outputLines(stdout: string, stderr: string): string[] {
  return [...stdout.split("\n"), ...stderr.split("\n")]
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function lastStderrLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "";
}

async function runBootstrapScript(
  script: string,
  sourceDir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ ok: true; lines: string[] } | { ok: false; message: string; lines: string[] }> {
  try {
    const result = await execCommand("bash", [script], {
      cwd: sourceDir,
      env,
      timeoutMs,
    });
    const lines = outputLines(result.stdout, result.stderr);
    if (result.exitCode !== 0 || result.timedOut) {
      const detail = lastStderrLine(result.stderr);
      const reason = result.timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exited with code ${result.exitCode}`;
      return {
        ok: false,
        message: detail ? `${path.basename(script)} ${reason}: ${detail}` : `${path.basename(script)} ${reason}`,
        lines,
      };
    }
    return { ok: true, lines };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Could not run ${path.basename(script)}: ${message}`,
      lines: [],
    };
  }
}

/**
 * Install the Test-Writer runtime into the current user's home. This function
 * is idempotent and never throws for missing python/venv/pip/network: the
 * caller gets a fail-closed status so the rest of Nyxowl can still launch.
 */
export async function ensureTestWriterRuntime(
  options?: EnsureTestWriterOptions,
): Promise<TestWriterInstallResult> {
  const root = testWriterRoot(options?.nyxowlHome);
  // Explicit installs (install: true) override the environment opt-out; an
  // unset option still honours NYXOWL_TESTWRITER_INSTALL=0 for auto setup.
  const disabled =
    options?.install === false ||
    (process.env["NYXOWL_TESTWRITER_INSTALL"] === "0" && options?.install !== true);
  if (disabled) {
    return {
      status: "disabled",
      root,
      message: "Test-Writer installation disabled (NYXOWL_TESTWRITER_INSTALL=0).",
      lines: [],
    };
  }

  const sourceDir = options?.sourceDir ?? testWriterSourceDir();
  const existing = testWriterStatus(root, sourceDir);

  if (existing.ready && !options?.force) {
    return {
      status: "already-installed",
      root,
      message: `Test-Writer: ready at ${root}`,
      lines: [],
    };
  }

  if (!isTestWriterSourceReady(sourceDir)) {
    return {
      status: "unavailable",
      root,
      message: `Test-Writer source is missing ${REQUIRED_SOURCE_FILES.join(", ")} under ${sourceDir}.`,
      lines: [],
    };
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TW_INSTALL_ROOT: root,
    TW_STORE_ROOT: path.join(root, "store"),
    ...(options?.envPath ? { PATH: options.envPath } : {}),
  };

  const lines: string[] = [];
  const installScript = path.join(sourceDir, "bootstrap", "install-user.sh");
  const venvScript = path.join(sourceDir, "bootstrap", "build-user-venv.sh");

  const installResult = await runBootstrapScript(installScript, sourceDir, env, 120_000);
  lines.push(...installResult.lines);
  if (!installResult.ok) {
    return { status: "failed", root, message: installResult.message, lines };
  }

  const venvResult = await runBootstrapScript(venvScript, sourceDir, env, 300_000);
  lines.push(...venvResult.lines);
  if (!venvResult.ok) {
    return { status: "failed", root, message: venvResult.message, lines };
  }

  // Re-read the installed tree only after both scripts report success so an
  // interrupted or partial install stays fail-closed.
  const status = testWriterStatus(root, sourceDir);
  if (!status.ready) {
    return {
      status: "failed",
      root,
      message: `Test-Writer install finished but the runtime is incomplete under ${root}.`,
      lines,
    };
  }

  return {
    status: "installed",
    root,
    message: `Test-Writer: ready at ${root}`,
    lines,
  };
}

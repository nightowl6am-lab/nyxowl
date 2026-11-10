import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NyxError } from "./errors.ts";
import { killProcessGroup } from "./exec.ts";
import { isSecretEnvFileName, parseDotEnvEntries, Redactor } from "./redact.ts";

/**
 * Manifests that mark a directory as an independently deployable "package"
 * (monorepo member, python distribution, go module, rust crate, php package).
 */
export const PACKAGE_MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "composer.json",
] as const;

/** Directories that never contain project packages and are expensive to walk. */
const SKIPPED_DIRECTORY_NAMES = new Set<string>([
  ".git",
  ".hg",
  ".svn",
  ".nyxowl",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  "__pycache__",
  "node_modules",
  "vendor",
  "venv",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
]);

/**
 * Suffixes that mark a `.env*` file as a documentation artifact rather than a
 * secret carrier. `isSecretEnvFileName` already excludes the canonical names
 * (`.env.example`, `.env.sample`, `.env.template`, `.env.defaults`); these
 * suffixes additionally exclude variants such as `.env.production.example`.
 */
const EXCLUDED_ENV_FILE_SUFFIXES = [".example", ".sample", ".template", ".defaults"];

/**
 * Hostnames that a local readiness probe may target. Anything else is refused
 * so the runner cannot be used as an SSRF probe against internal networks.
 */
const READINESS_ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Characters that imply the caller expected shell interpretation. The runner
 * never spawns a shell, so such a command is rejected instead of being run
 * with surprising semantics.
 */
const SHELL_METACHARACTERS = /[;&|`$><\r\n]/;

export interface SecretEnvFile {
  /** Absolute path of the env file inside the scanned tree. */
  absolutePath: string;
  /** Path relative to the scan root, POSIX separators. */
  relativePath: string;
  /** Relative directory that owns the file; "." for the scan root. */
  packagePath: string;
}

export interface EnvTreeScan {
  /** Relative package directories (POSIX separators); "." is the scan root. */
  packageDirectories: string[];
  /** Secret env files discovered inside package directories. */
  envFiles: SecretEnvFile[];
}

/**
 * True when the file name is a secret env carrier (never `.env.example` and
 * friends) and is therefore eligible for provisioning.
 */
export function isLinkableEnvFileName(fileName: string): boolean {
  if (!isSecretEnvFileName(fileName)) {
    return false;
  }
  const lower = fileName.toLowerCase();
  return !EXCLUDED_ENV_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Walks `rootDir` and reports every package directory (root included) plus the
 * secret env files that live inside those packages.
 *
 * Safety rules:
 * - symlinked directories are never traversed (no escaping the scanned tree),
 * - symlinked env files whose target escapes the scanned root are ignored,
 * - file contents are never read.
 */
export function scanEnvTree(rootDir: string, options: { maxDepth?: number } = {}): EnvTreeScan {
  const root = path.resolve(rootDir);
  const maxDepth = options.maxDepth ?? 6;
  const packageDirectories: string[] = [];
  const envFiles: SecretEnvFile[] = [];
  const visited = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(realDir)) {
      return;
    }
    visited.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const isRoot = path.resolve(dir) === root;
    const isPackage =
      isRoot ||
      PACKAGE_MANIFEST_FILES.some((manifest) =>
        entries.some((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name === manifest),
      );

    if (isPackage) {
      const relativeDir = path.relative(root, dir).split(path.sep).join("/") || ".";
      packageDirectories.push(relativeDir);
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) {
          continue;
        }
        if (!isLinkableEnvFileName(entry.name)) {
          continue;
        }
        const absolutePath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          let target: string;
          try {
            target = fs.realpathSync(absolutePath);
          } catch {
            continue;
          }
          const relativeTarget = path.relative(root, target);
          if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
            // Never follow a symlink out of the scanned tree.
            continue;
          }
        }
        envFiles.push({
          absolutePath,
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
          packagePath: relativeDir,
        });
      }
    }

    if (depth >= maxDepth) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  walk(root, 0);
  packageDirectories.sort();
  envFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { packageDirectories, envFiles };
}

/** Convenience wrapper returning only the discovered secret env files. */
export function discoverSecretEnvFiles(
  rootDir: string,
  options: { maxDepth?: number } = {},
): SecretEnvFile[] {
  return scanEnvTree(rootDir, options).envFiles;
}

/**
 * Reads the key/value pairs of one env file. Callers must keep the values
 * inside the process (child environment or redactor) and never return them.
 */
export function readEnvFileEntries(filePath: string): Array<{ key: string; value: string }> {
  try {
    return parseDotEnvEntries(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

export interface SafeRunOptions {
  /** Executable to run. Never interpreted by a shell. */
  command: string;
  /** Argument vector; passed to the process without shell interpretation. */
  args?: string[];
  /** Working directory of the child process. */
  cwd: string;
  /** Env files whose values are loaded into the child environment only. */
  envFiles?: string[];
  /** Hard timeout for the child process. */
  timeoutMs?: number;
  /** Optional HTTP(S) URL polled until the service answers. */
  readinessUrl?: string;
  /** Maximum number of bytes kept per output stream. */
  maxOutputBytes?: number;
  /** Base environment for the child (defaults to the server environment). */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface SafeRunResult {
  /** Exit code of the child, or null when it was terminated by a signal. */
  exitCode: number | null;
  /** Terminating signal, when any. */
  signal: string | null;
  /** True when the child was killed because the timeout elapsed. */
  timedOut: boolean;
  /** True when the readiness URL answered before the child exited. */
  ready: boolean;
  /** Redacted, bounded stdout. */
  stdout: string;
  /** Redacted, bounded stderr. */
  stderr: string;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** True when output was truncated to the configured bound. */
  truncated: boolean;
}

/**
 * Loads env files into a child-only environment and returns the secret values
 * that must be redacted from any captured output.
 */
export function loadEnvValues(envFiles: string[]): {
  env: Record<string, string>;
  secretValues: string[];
} {
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const file of envFiles) {
    for (const entry of readEnvFileEntries(file)) {
      if (entry.value.length === 0) {
        continue;
      }
      env[entry.key] = entry.value;
      if (entry.value.length >= 4) {
        secretValues.push(entry.value);
      }
    }
  }
  return { env, secretValues };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Probes an HTTP(S) readiness URL. Any HTTP answer counts as "the service is
 * up"; redirects are never followed and only loopback targets are allowed.
 */
async function probeReadiness(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (!READINESS_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return false;
  }
  try {
    const response = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
    return response.status >= 100 && response.status < 600;
  } catch {
    return false;
  }
}

/**
 * Runs a command with env loaded from the provisioned env files.
 *
 * Guarantees:
 * - no shell is used, the argument vector is passed through verbatim,
 * - env values live only in the child process environment,
 * - stdout/stderr are redacted (exact secret values + key-shaped tokens) and
 *   bounded before they are returned,
 * - the child is killed when the timeout elapses.
 */
export async function runSafeCommand(options: SafeRunOptions): Promise<SafeRunResult> {
  const command = (options.command ?? "").trim();
  if (!command) {
    throw new NyxError("ERR_INVALID_INPUT", "run.command must be a non-empty string");
  }
  if (SHELL_METACHARACTERS.test(command)) {
    throw new NyxError(
      "ERR_INVALID_INPUT",
      "run.command must not contain shell metacharacters; the runner does not use a shell",
    );
  }
  const args = options.args ?? [];
  const cwd = path.resolve(options.cwd);
  if (!fs.existsSync(cwd)) {
    throw new NyxError("ERR_INVALID_INPUT", `run cwd "${cwd}" does not exist`);
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const startedAt = Date.now();

  const { env: loadedEnv, secretValues } = loadEnvValues(options.envFiles ?? []);
  const redactor = new Redactor(secretValues);
  const childEnv: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env), ...loadedEnv };

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;

  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutBytes < maxOutputBytes) {
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      }
    } else {
      truncated = true;
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes < maxOutputBytes) {
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        truncated = true;
      }
    } else {
      truncated = true;
    }
  });

  const spawnError = await new Promise<Error | null>((resolveError) => {
    child.once("spawn", () => {
      resolveError(null);
    });
    child.once("error", (err) => {
      resolveError(err);
    });
  });
  if (spawnError) {
    throw new NyxError("ERR_EXEC_FAILED", `Failed to spawn "${command}": ${spawnError.message}`, {
      command,
      args,
    });
  }

  let childExited = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose) => {
      child.once("close", (code, signal) => {
        childExited = true;
        resolveClose({ code, signal });
      });
    },
  );

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid, "SIGTERM");
          setTimeout(() => {
            killProcessGroup(child.pid, "SIGKILL");
          }, 250).unref?.();
        }, timeoutMs)
      : undefined;
  timer?.unref?.();

  let ready = false;
  if (options.readinessUrl) {
    const deadline = startedAt + timeoutMs;
    while (!timedOut && Date.now() < deadline) {
      if (await probeReadiness(options.readinessUrl)) {
        ready = true;
        // The service answered: stop the child and report the captured logs.
        killProcessGroup(child.pid, "SIGTERM");
        break;
      }
      if (childExited) {
        break;
      }
      await sleep(200);
    }
  }

  const { code, signal } = await closed;
  if (timer) {
    clearTimeout(timer);
  }
  if (timedOut) {
    killProcessGroup(child.pid, "SIGKILL");
  }

  const stdout = redactor.redact(Buffer.concat(stdoutChunks).toString("utf8"));
  const stderr = redactor.redact(Buffer.concat(stderrChunks).toString("utf8"));

  return {
    exitCode: code ?? (timedOut ? 124 : null),
    signal: signal ?? null,
    timedOut,
    ready,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    truncated,
  };
}

import { spawn } from "node:child_process";
import { NyxError } from "./errors.ts";
import { Redactor } from "./redact.ts";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  redactor?: Redactor;
  stdin?: string;
  throwOnNonZero?: boolean;
}

export interface ExecResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  combined: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!pid || pid <= 0) {
    return;
  }
  try {
    // Negative PID kills the entire process group on POSIX
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited
    }
  }
}

export async function execCommand(
  command: string,
  args: string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024;
  const redactor = options.redactor;

  return new Promise<ExecResult>((resolve, reject) => {
    const isPosix = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      detached: isPosix,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child.pid, "SIGTERM");
            setTimeout(() => {
              killProcessGroup(child.pid, "SIGKILL");
            }, 250).unref();
          }, timeoutMs)
        : undefined;

    if (timer) {
      timer.unref();
    }

    // The child's exit code / close event is authoritative. When the child
    // exits or closes its read side first (e.g. `git check-ignore` failing fast
    // on a corrupt index), a pending stdin write would otherwise emit an
    // unhandled EPIPE that escapes this promise and crashes the caller.
    // Stdin errors are therefore always handled here and never propagated:
    // they cannot change the command's real outcome.
    child.stdin?.on("error", () => {
      // EPIPE / ERR_STREAM_DESTROYED / ERR_STREAM_WRITE_AFTER_END / etc. after
      // the child is gone — the close handler below decides the result.
    });

    const endStdin = (): void => {
      try {
        child.stdin?.end();
      } catch {
        // Stream already destroyed; the close handler produces the result.
      }
    };

    if (options.stdin !== undefined) {
      // The write callback swallows asynchronous write failures sync-side; the
      // error handler above covers the stream-level ones.
      child.stdin?.write(options.stdin, () => {
        // Intentional: stdin write outcome never overrides the child's status.
      });
      endStdin();
    } else {
      endStdin();
    }

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

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(
        new NyxError("ERR_EXEC_FAILED", `Failed to spawn "${command}": ${err.message}`, {
          command,
          args,
        }),
      );
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        killProcessGroup(child.pid, "SIGKILL");
      }

      const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
      const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      const stdout = redactor ? redactor.redact(rawStdout) : rawStdout;
      const stderr = redactor ? redactor.redact(rawStderr) : rawStderr;
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      const durationMs = Date.now() - startTime;
      const exitCode = code ?? (timedOut ? 124 : 1);

      const result: ExecResult = {
        exitCode,
        signal,
        stdout,
        stderr,
        combined,
        timedOut,
        truncated,
        durationMs,
      };

      if (timedOut && options.throwOnNonZero) {
        reject(
          new NyxError("ERR_EXEC_TIMEOUT", `Command "${command}" timed out after ${timeoutMs}ms`, {
            command,
            args,
            durationMs,
          }),
        );
        return;
      }

      if (options.throwOnNonZero && exitCode !== 0) {
        reject(
          new NyxError(
            "ERR_EXEC_FAILED",
            `Command "${command} ${args.join(" ")}" failed with exit code ${exitCode}: ${stderr || stdout}`,
            { command, args, exitCode, stdout, stderr },
          ),
        );
        return;
      }

      resolve(result);
    });
  });
}

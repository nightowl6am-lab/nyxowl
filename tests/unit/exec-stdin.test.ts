import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";

/**
 * Regression: `execCommand` wrote to `child.stdin` without an error handler.
 * When the child exits or closes its read side before the write flushed (e.g.
 * `git check-ignore` failing fast against a corrupt index), the write emitted
 * an unhandled EPIPE that escaped the promise and turned the verify gate RED
 * with "unhandled error". The child's exit code / close event is authoritative;
 * stdin-side stream errors must never escape.
 */

const ONE_MIB_STDIN = "x".repeat(1024 * 1024);

describe("execCommand — stdin survives a child that is gone before the write", () => {
  it("resolves normally when the child exits immediately with a large stdin payload", async () => {
    const res = await execCommand("sh", ["-c", "exit 0"], {
      cwd: os.tmpdir(),
      stdin: ONE_MIB_STDIN,
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.signal).toBeNull();
  });

  it("resolves normally when the child closes its read side immediately then sleeps", async () => {
    const res = await execCommand("sh", ["-c", "exec 0<&-; sleep 0.05"], {
      cwd: path.join(os.tmpdir()),
      stdin: ONE_MIB_STDIN,
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it("still routes the child's real status through the normal rules (non-zero resolves unless throwOnNonZero)", async () => {
    const res = await execCommand("sh", ["-c", "exec 0<&-; exit 3"], {
      cwd: os.tmpdir(),
      stdin: ONE_MIB_STDIN,
      timeoutMs: 10_000,
      throwOnNonZero: false,
    });
    expect(res.exitCode).toBe(3);

    const rejected = execCommand("sh", ["-c", "exec 0<&-; exit 3"], {
      cwd: os.tmpdir(),
      stdin: ONE_MIB_STDIN,
      timeoutMs: 10_000,
      throwOnNonZero: true,
    });
    await expect(rejected).rejects.toMatchObject({ code: "ERR_EXEC_FAILED" });
  });
});

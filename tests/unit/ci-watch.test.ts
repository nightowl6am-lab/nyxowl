import { describe, expect, it } from "vitest";
import type { ExecResult } from "../../src/core/exec.ts";
import {
  collectPrChecks,
  extractRunId,
  parseCheckRollup,
  summarizeCiStatus,
  waitForPrChecks,
  type CiCheck,
  type CiExec,
} from "../../src/mcp/engines/worktree-slice/ci-watch.ts";

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    combined: "",
    timedOut: false,
    truncated: false,
    durationMs: 1,
    ...overrides,
  };
}

function check(overrides: Partial<CiCheck> = {}): CiCheck {
  return {
    name: "build",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    url: "https://github.com/acme/repo/actions/runs/111/job/222",
    runId: "111",
    ...overrides,
  };
}

const ROLLUP_PAYLOAD = JSON.stringify({
  headRefOid: "abc123def456",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "build",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/acme/repo/actions/runs/111/job/222",
    },
    {
      __typename: "CheckRun",
      name: "lint",
      status: "IN_PROGRESS",
      conclusion: null,
      detailsUrl: "https://github.com/acme/repo/actions/runs/333/job/444",
    },
    {
      __typename: "StatusContext",
      context: "legacy-status",
      state: "SUCCESS",
      targetUrl: "https://example.test/status/1",
    },
  ],
});

describe("parseCheckRollup", () => {
  it("parses CheckRun and StatusContext entries from gh pr view JSON", () => {
    const checks = parseCheckRollup(ROLLUP_PAYLOAD);

    expect(checks).toHaveLength(3);
    expect(checks[0]).toEqual({
      name: "build",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      url: "https://github.com/acme/repo/actions/runs/111/job/222",
      runId: "111",
    });
    expect(checks[1]).toEqual({
      name: "lint",
      status: "IN_PROGRESS",
      conclusion: null,
      url: "https://github.com/acme/repo/actions/runs/333/job/444",
      runId: "333",
    });
    expect(checks[2]).toEqual({
      name: "legacy-status",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      url: "https://example.test/status/1",
      runId: null,
    });
  });

  it("maps legacy StatusContext states to check status/conclusion", () => {
    const payload = JSON.stringify({
      statusCheckRollup: [
        { __typename: "StatusContext", context: "fail", state: "FAILURE" },
        { __typename: "StatusContext", context: "err", state: "ERROR" },
        { __typename: "StatusContext", context: "wait", state: "PENDING" },
      ],
    });
    const checks = parseCheckRollup(payload);

    expect(checks.map((c) => [c.name, c.status, c.conclusion])).toEqual([
      ["fail", "COMPLETED", "FAILURE"],
      ["err", "COMPLETED", "FAILURE"],
      ["wait", "PENDING", null],
    ]);
  });

  it("returns [] for malformed or empty payloads", () => {
    expect(parseCheckRollup("")).toEqual([]);
    expect(parseCheckRollup("   ")).toEqual([]);
    expect(parseCheckRollup("not json at all")).toEqual([]);
    expect(parseCheckRollup("[]")).toEqual([]);
    expect(parseCheckRollup("null")).toEqual([]);
    expect(parseCheckRollup('{"statusCheckRollup":"not-an-array"}')).toEqual([]);
    expect(parseCheckRollup('{"number":26}')).toEqual([]);
  });

  it("skips malformed rollup entries defensively", () => {
    const payload = JSON.stringify({
      statusCheckRollup: [null, 42, { name: "ok", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    const checks = parseCheckRollup(payload);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("ok");
  });
});

describe("summarizeCiStatus", () => {
  it("returns passed when every check completed successfully", () => {
    expect(summarizeCiStatus([check(), check({ name: "test" })])).toBe("passed");
    expect(summarizeCiStatus([check({ conclusion: "SKIPPED" })])).toBe("passed");
    expect(summarizeCiStatus([check({ conclusion: "NEUTRAL" })])).toBe("passed");
  });

  it("returns failed when any conclusion is a failure regardless of pending checks", () => {
    expect(summarizeCiStatus([check({ conclusion: "FAILURE" })])).toBe("failed");
    expect(summarizeCiStatus([check({ conclusion: "TIMED_OUT" })])).toBe("failed");
    expect(summarizeCiStatus([check({ conclusion: "CANCELLED" })])).toBe("failed");
    expect(summarizeCiStatus([check({ conclusion: "ACTION_REQUIRED" })])).toBe("failed");
    expect(
      summarizeCiStatus([
        check({ name: "still-running", status: "IN_PROGRESS", conclusion: null }),
        check({ name: "broken", conclusion: "FAILURE" }),
      ]),
    ).toBe("failed");
  });

  it("returns pending when a check has not completed", () => {
    expect(
      summarizeCiStatus([check(), check({ status: "QUEUED", conclusion: null })]),
    ).toBe("pending");
    expect(summarizeCiStatus([check({ status: "IN_PROGRESS", conclusion: null })])).toBe(
      "pending",
    );
  });

  it("returns unknown when there are no checks or no recognized conclusion", () => {
    expect(summarizeCiStatus([])).toBe("unknown");
    expect(summarizeCiStatus([check({ conclusion: null })])).toBe("unknown");
    expect(summarizeCiStatus([check({ conclusion: "MYSTERY" })])).toBe("unknown");
  });
});

describe("collectPrChecks", () => {
  it("runs gh pr view with the PR number as a separate argv element", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: CiExec = async (command, args) => {
      calls.push({ command, args });
      return execResult({ stdout: ROLLUP_PAYLOAD });
    };

    const snapshot = await collectPrChecks(exec, 26, { cwd: "/tmp/wt" });

    expect(calls).toEqual([
      {
        command: "gh",
        args: ["pr", "view", "26", "--json", "statusCheckRollup,headRefOid"],
      },
    ]);
    expect(snapshot.headRefOid).toBe("abc123def456");
    expect(snapshot.status).toBe("pending");
    expect(snapshot.checks).toHaveLength(3);
  });

  it("returns an unknown snapshot when the command fails or throws", async () => {
    const failing: CiExec = async () =>
      execResult({ exitCode: 1, stderr: "no pull requests found" });
    expect(await collectPrChecks(failing, 26)).toEqual({
      status: "unknown",
      checks: [],
      headRefOid: null,
    });

    const throwing: CiExec = async () => {
      throw new Error("gh exploded");
    };
    expect(await collectPrChecks(throwing, 26)).toEqual({
      status: "unknown",
      checks: [],
      headRefOid: null,
    });
  });

  it("never invokes gh for an invalid PR number", async () => {
    let called = false;
    const exec: CiExec = async () => {
      called = true;
      return execResult({ stdout: ROLLUP_PAYLOAD });
    };
    expect((await collectPrChecks(exec, 0)).status).toBe("unknown");
    expect((await collectPrChecks(exec, Number.NaN)).status).toBe("unknown");
    expect(called).toBe(false);
  });
});

describe("waitForPrChecks", () => {
  it("polls until pending transitions to passed, using the injected sleep", async () => {
    const pendingPayload = JSON.stringify({
      headRefOid: "abc",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null },
      ],
    });
    const passedPayload = JSON.stringify({
      headRefOid: "abc",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    });

    const responses = [pendingPayload, passedPayload];
    let index = 0;
    const exec: CiExec = async () =>
      execResult({ stdout: responses[Math.min(index++, responses.length - 1)] ?? passedPayload });

    const sleeps: number[] = [];
    const snapshot = await waitForPrChecks(exec, 26, {
      timeoutMs: 1_000,
      intervalMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(snapshot.status).toBe("passed");
    expect(snapshot.timedOut).toBe(false);
    expect(sleeps).toEqual([100]);
    expect(index).toBe(2);
  });

  it("reports timedOut when checks stay pending past the budget", async () => {
    const pendingPayload = JSON.stringify({
      statusCheckRollup: [
        { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null },
      ],
    });
    let calls = 0;
    const exec: CiExec = async () => {
      calls += 1;
      return execResult({ stdout: pendingPayload });
    };

    const snapshot = await waitForPrChecks(exec, 26, {
      timeoutMs: 30,
      intervalMs: 10,
      sleep: async () => {},
    });

    expect(snapshot.status).toBe("pending");
    expect(snapshot.timedOut).toBe(true);
    // first observation + 3 poll steps
    expect(calls).toBe(4);
  });

  it("stops immediately for a terminal or unknown rollup", async () => {
    let calls = 0;
    const passed: CiExec = async () => {
      calls += 1;
      return execResult({
        stdout: JSON.stringify({
          statusCheckRollup: [
            { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        }),
      });
    };

    const result = await waitForPrChecks(passed, 26, {
      timeoutMs: 1_000,
      intervalMs: 100,
      sleep: async () => {
        throw new Error("sleep must not run for a terminal rollup");
      },
    });
    expect(result.status).toBe("passed");
    expect(result.timedOut).toBe(false);
    expect(calls).toBe(1);

    const unknown = await waitForPrChecks(passed, 0, {
      timeoutMs: 1_000,
      intervalMs: 100,
      sleep: async () => {
        throw new Error("sleep must not run for an unknown rollup");
      },
    });
    expect(unknown.status).toBe("unknown");
    expect(unknown.timedOut).toBe(false);
  });
});

describe("extractRunId", () => {
  it("parses the run id from an actions job URL", () => {
    expect(
      extractRunId("https://github.com/acme/repo/actions/runs/123456789/job/987654321"),
    ).toBe("123456789");
    expect(extractRunId("https://github.com/acme/repo/actions/runs/42")).toBe("42");
    expect(
      extractRunId("https://github.com/acme/repo/actions/runs/777/job/1?pr=26"),
    ).toBe("777");
  });

  it("returns null for non-actions URLs and empty input", () => {
    expect(extractRunId("")).toBeNull();
    expect(extractRunId("https://example.test/status/1")).toBeNull();
    expect(extractRunId("https://github.com/acme/repo/pull/26")).toBeNull();
  });
});

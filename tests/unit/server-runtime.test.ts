import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateBuildFreshness,
  getServerRuntimeMarkerPath,
  readServerRuntimeMarker,
  removeServerRuntimeMarker,
  writeServerRuntimeMarker,
  type ServerRuntimeMarker,
} from "../../src/core/server-runtime.ts";

let tmpRoot: string;
let nyxHome: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-server-runtime-"));
  nyxHome = path.join(tmpRoot, "home");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeMarker(overrides: Partial<ServerRuntimeMarker> = {}): ServerRuntimeMarker {
  return {
    pid: process.pid,
    version: "1.0.0",
    toolCount: 3,
    entryPath: "/work/app/dist/cli/index.js",
    startedAt: new Date().toISOString(),
    projectPath: "/work/app",
    ...overrides,
  };
}

describe("server runtime marker", () => {
  it("writes, reads, and removes the marker with private permissions", () => {
    const marker = makeMarker();
    const markerPath = writeServerRuntimeMarker(marker, nyxHome);

    expect(markerPath).toBe(getServerRuntimeMarkerPath(nyxHome));
    expect(fs.readFileSync(markerPath, "utf8")).toContain('"toolCount": 3');

    const runDirMode = fs.statSync(path.dirname(markerPath)).mode & 0o777;
    const fileMode = fs.statSync(markerPath).mode & 0o777;
    expect(runDirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    expect(readServerRuntimeMarker(nyxHome)).toEqual(marker);
    expect(removeServerRuntimeMarker(process.pid, nyxHome)).toBe(true);
    expect(readServerRuntimeMarker(nyxHome)).toBeNull();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("preserves a newer marker when a different pid tries to remove it", () => {
    writeServerRuntimeMarker(makeMarker({ pid: 111 }), nyxHome);

    expect(removeServerRuntimeMarker(222, nyxHome)).toBe(false);
    expect(readServerRuntimeMarker(nyxHome)?.pid).toBe(111);

    expect(removeServerRuntimeMarker(111, nyxHome)).toBe(true);
    expect(readServerRuntimeMarker(nyxHome)).toBeNull();
  });

  it("returns null for a missing or malformed marker instead of throwing", () => {
    expect(readServerRuntimeMarker(nyxHome)).toBeNull();

    const markerPath = getServerRuntimeMarkerPath(nyxHome);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{not json", "utf8");
    expect(readServerRuntimeMarker(nyxHome)).toBeNull();
    expect(removeServerRuntimeMarker(process.pid, nyxHome)).toBe(false);

    fs.writeFileSync(markerPath, JSON.stringify({ pid: "not-a-number" }), "utf8");
    expect(readServerRuntimeMarker(nyxHome)).toBeNull();
  });
});

describe("evaluateBuildFreshness", () => {
  const entryPath = "/work/app/dist/cli/index.js";

  it("is fresh when marker and mtimes line up", () => {
    const result = evaluateBuildFreshness({
      entryPath,
      marker: makeMarker({ entryPath, toolCount: 3 }),
      expectedToolCount: 3,
      worktreePath: "/work/app",
      distMtimeMs: 3_000,
      sourceLatestMtimeMs: 1_000,
      worktreeHeadMtimeMs: 500,
    });

    expect(result.stale).toBe(false);
    expect(result.fresh).toBe(true);
    expect(result.staleReasons).toEqual([]);
  });

  it("is stale when the marker is missing and never throws", () => {
    const result = evaluateBuildFreshness({
      entryPath,
      marker: null,
      expectedToolCount: 3,
      distMtimeMs: 3_000,
    });

    expect(result.stale).toBe(true);
    expect(result.staleReasons).toContain("runtime marker missing");
  });

  it("is stale on a tool-count mismatch", () => {
    const result = evaluateBuildFreshness({
      entryPath,
      marker: makeMarker({ entryPath, toolCount: 38 }),
      expectedToolCount: 39,
      distMtimeMs: 3_000,
    });

    expect(result.stale).toBe(true);
    expect(result.staleReasons.join(" ")).toContain("tool count 38 does not match expected 39");
  });

  it("is stale on an entry-path mismatch", () => {
    const result = evaluateBuildFreshness({
      entryPath,
      marker: makeMarker({ entryPath: "/work/app/dist/mcp/server.js", toolCount: 3 }),
      expectedToolCount: 3,
      distMtimeMs: 3_000,
    });

    expect(result.stale).toBe(true);
    expect(result.staleReasons.join(" ")).toContain("does not match");
  });

  it("is stale when source is newer than dist", () => {
    const result = evaluateBuildFreshness({
      entryPath,
      marker: makeMarker({ entryPath, toolCount: 3 }),
      expectedToolCount: 3,
      distMtimeMs: 1_000,
      sourceLatestMtimeMs: 2_000,
      worktreeHeadMtimeMs: 500,
    });

    expect(result.stale).toBe(true);
    expect(result.staleReasons.join(" ")).toContain("older than newest source");
  });

  it("is stale when the worktree HEAD is newer than the entry", () => {
    const result = evaluateBuildFreshness({
      entryPath,
      marker: makeMarker({ entryPath, toolCount: 3 }),
      expectedToolCount: 3,
      distMtimeMs: 1_000,
      sourceLatestMtimeMs: 500,
      worktreeHeadMtimeMs: 2_000,
    });

    expect(result.stale).toBe(true);
    expect(result.staleReasons.join(" ")).toContain("older than worktree HEAD");
  });

  it("skips mtime comparisons that cannot be evaluated", () => {
    const result = evaluateBuildFreshness({
      entryPath,
      marker: makeMarker({ entryPath, toolCount: 3 }),
      expectedToolCount: 3,
      distMtimeMs: null,
      sourceLatestMtimeMs: 2_000,
      worktreeHeadMtimeMs: 2_000,
    });

    expect(result.stale).toBe(false);
  });
});

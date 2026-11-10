import fs from "node:fs";
import path from "node:path";
import { resolveNyxHome } from "./paths.ts";

/**
 * Runtime marker written by the stdio MCP server so a CLI gate runner can tell
 * whether the host-loaded server matches the build inside a worktree.
 *
 * The marker contains process/build metadata only. It never carries secrets,
 * environment values, or argument payloads.
 */
export interface ServerRuntimeMarker {
  pid: number;
  version: string;
  toolCount: number;
  entryPath: string;
  startedAt: string;
  projectPath: string;
}

export interface BuildFreshnessInput {
  entryPath: string;
  marker: ServerRuntimeMarker | null;
  expectedToolCount: number;
  worktreePath?: string | null;
  distMtimeMs?: number | null;
  sourceLatestMtimeMs?: number | null;
  worktreeHeadMtimeMs?: number | null;
}

export interface BuildFreshnessResult {
  entryPath: string;
  marker: ServerRuntimeMarker | null;
  worktreePath: string | null;
  distMtimeMs: number | null;
  sourceLatestMtimeMs: number | null;
  worktreeHeadMtimeMs: number | null;
  stale: boolean;
  fresh: boolean;
  staleReasons: string[];
}

export function getServerRuntimeMarkerPath(nyxHome?: string): string {
  return path.join(resolveNyxHome(nyxHome), "run", "mcp-server.json");
}

function ensureRunDir(filePath: string): string {
  const runDir = path.dirname(filePath);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(runDir, 0o700);
  } catch {
    // Non-POSIX filesystems may reject chmod; the directory still exists.
  }
  return runDir;
}

function isServerRuntimeMarker(value: unknown): value is ServerRuntimeMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["pid"] === "number" &&
    typeof record["version"] === "string" &&
    typeof record["toolCount"] === "number" &&
    typeof record["entryPath"] === "string" &&
    typeof record["startedAt"] === "string" &&
    typeof record["projectPath"] === "string"
  );
}

/**
 * Atomically writes the runtime marker (dir 0700, file 0600). Throws only on
 * real filesystem failure; the caller decides whether that is fatal.
 */
export function writeServerRuntimeMarker(
  marker: ServerRuntimeMarker,
  nyxHome?: string,
): string {
  const filePath = getServerRuntimeMarkerPath(nyxHome);
  ensureRunDir(filePath);

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Mode already applied at creation on POSIX; ignore exotic filesystems.
    }
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // The rename already consumed the temp file.
    }
  }
  return filePath;
}

/**
 * Reads the marker. Returns `null` for a missing, unreadable, or malformed
 * marker instead of throwing, so freshness checks stay non-fatal.
 */
export function readServerRuntimeMarker(nyxHome?: string): ServerRuntimeMarker | null {
  const filePath = getServerRuntimeMarkerPath(nyxHome);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isServerRuntimeMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Removes the marker only when its `pid` matches the caller. A stale process
 * therefore cannot delete the marker owned by a newer server.
 */
export function removeServerRuntimeMarker(pid: number, nyxHome?: string): boolean {
  const marker = readServerRuntimeMarker(nyxHome);
  if (marker === null || marker.pid !== pid) {
    return false;
  }
  try {
    fs.rmSync(getServerRuntimeMarkerPath(nyxHome), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Newest `src/**\/*.ts` mtime in a worktree, or `null` when no source tree
 * exists (e.g. an installed `dist`-only package).
 */
export function getLatestSourceMtimeMs(worktreePath: string): number | null {
  const srcDir = path.join(worktreePath, "src");
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(srcDir);
  } catch {
    return null;
  }
  if (!srcStat.isDirectory()) {
    return null;
  }

  let latest: number | null = null;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        try {
          const mtimeMs = fs.statSync(fullPath).mtimeMs;
          if (latest === null || mtimeMs > latest) {
            latest = mtimeMs;
          }
        } catch {
          // Ignore a file that disappeared mid-scan.
        }
      }
    }
  };
  walk(srcDir);
  return latest;
}

/**
 * Pure freshness decision. Never throws: every missing input becomes a stale
 * reason (or is skipped when it cannot be compared).
 */
export function evaluateBuildFreshness(input: BuildFreshnessInput): BuildFreshnessResult {
  const staleReasons: string[] = [];
  const {
    entryPath,
    marker,
    expectedToolCount,
    worktreePath = null,
    distMtimeMs = null,
    sourceLatestMtimeMs = null,
    worktreeHeadMtimeMs = null,
  } = input;

  if (marker === null) {
    staleReasons.push("runtime marker missing");
  } else {
    if (marker.toolCount !== expectedToolCount) {
      staleReasons.push(
        `marker tool count ${marker.toolCount} does not match expected ${expectedToolCount}`,
      );
    }
    if (marker.entryPath !== entryPath) {
      staleReasons.push(
        `marker entry path ${marker.entryPath} does not match ${entryPath}`,
      );
    }
  }

  if (
    distMtimeMs !== null &&
    sourceLatestMtimeMs !== null &&
    distMtimeMs < sourceLatestMtimeMs
  ) {
    staleReasons.push(
      `dist entry mtime ${distMtimeMs} is older than newest source mtime ${sourceLatestMtimeMs}`,
    );
  }

  if (
    distMtimeMs !== null &&
    worktreeHeadMtimeMs !== null &&
    distMtimeMs < worktreeHeadMtimeMs
  ) {
    staleReasons.push(
      `dist entry mtime ${distMtimeMs} is older than worktree HEAD commit time ${worktreeHeadMtimeMs}`,
    );
  }

  const stale = staleReasons.length > 0;
  return {
    entryPath,
    marker,
    worktreePath,
    distMtimeMs,
    sourceLatestMtimeMs,
    worktreeHeadMtimeMs,
    stale,
    fresh: !stale,
    staleReasons,
  };
}

import fs from "node:fs";
import path from "node:path";
import { resolveNyxowlCliCommand } from "./cli-command.ts";
import { execCommand } from "../core/exec.ts";
import {
  evaluateBuildFreshness,
  getLatestSourceMtimeMs,
  readServerRuntimeMarker,
  type ServerRuntimeMarker,
} from "../core/server-runtime.ts";
import { NYXOWL_VERSION } from "../core/version.ts";
import { ALL_NYX_TOOLS } from "../mcp/server.ts";
import { invokeToolDefinition } from "../mcp/tool.ts";

/**
 * `nyxowl gate-run` is the sanctioned way to run a gate against the current
 * worktree build. The host-loaded MCP process can predate a rebuild, so the
 * command compares the runtime marker plus build/source/HEAD mtimes and either
 * refuses (`--require-fresh`) or warns before invoking the tool in-process.
 */
export interface GateRunGitState {
  head: string | null;
  tree: string | null;
  headTimeMs: number | null;
}

export interface GateRunDeps {
  nyxHome?: string;
  entryPath?: string;
  defaultWorktreePath?: string;
  defaultProjectPath?: string;
  getEntryMtimeMs?: (entryPath: string) => number | null;
  getSourceLatestMtimeMs?: (worktreePath: string) => number | null;
  resolveGitState?: (worktreePath: string) => Promise<GateRunGitState>;
  readMarker?: (nyxHome?: string) => ServerRuntimeMarker | null;
}

export interface GateRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GateRunInfo {
  version: string;
  toolCount: number;
  entryPath: string;
  marker: ServerRuntimeMarker | null;
  worktreeHead: string | null;
  worktreeTree: string | null;
  distMtimeMs: number | null;
  sourceLatestMtimeMs: number | null;
  stale: boolean;
  staleReasons: string[];
}

const USAGE = [
  "Usage: nyxowl gate-run --info [--allow-stale] [--worktree <path>] [--nyx-home <path>]",
  "       nyxowl gate-run --tool <name> [--args '<json>'] [--require-fresh]",
  "                           [--worktree <path>] [--project <path>]",
  "                           [--nyx-home <path>] [--role <role>]",
  "",
].join("\n");

function defaultGetEntryMtimeMs(entryPath: string): number | null {
  try {
    const stat = fs.statSync(entryPath);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

async function defaultResolveGitState(worktreePath: string): Promise<GateRunGitState> {
  try {
    const headRes = await execCommand("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      timeoutMs: 10_000,
    });
    if (headRes.exitCode !== 0) {
      return { head: null, tree: null, headTimeMs: null };
    }
    const head = headRes.stdout.trim();

    const treeRes = await execCommand("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: worktreePath,
      timeoutMs: 10_000,
    });
    const tree = treeRes.exitCode === 0 ? treeRes.stdout.trim() : null;

    const timeRes = await execCommand("git", ["log", "-1", "--format=%ct", "HEAD"], {
      cwd: worktreePath,
      timeoutMs: 10_000,
    });
    const seconds = timeRes.exitCode === 0 ? Number.parseInt(timeRes.stdout.trim(), 10) : Number.NaN;
    return {
      head,
      tree,
      headTimeMs: Number.isFinite(seconds) ? seconds * 1000 : null,
    };
  } catch {
    return { head: null, tree: null, headTimeMs: null };
  }
}

function resolveEntryPath(deps: GateRunDeps): string {
  if (deps.entryPath) {
    return path.resolve(deps.entryPath);
  }
  // The MCP host launches the canonical CLI entry, not the `bin` shim, so the
  // marker and gate-run must agree on that entry path.
  try {
    const candidate = resolveNyxowlCliCommand().args[0];
    if (candidate && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  } catch {
    // Fall through to the executing script path.
  }
  const argv1 = process.argv[1];
  return path.resolve(argv1 && argv1.length > 0 ? argv1 : process.cwd());
}

function schemaAcceptsProperty(schema: unknown, key: string): boolean {
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  const shape = (schema as { shape?: unknown }).shape;
  return (
    typeof shape === "object" &&
    shape !== null &&
    Object.prototype.hasOwnProperty.call(shape, key)
  );
}

async function buildInfo(
  input: {
    worktreePath: string;
    entryPath: string;
    nyxHome: string | undefined;
  },
  deps: GateRunDeps,
): Promise<GateRunInfo> {
  const readMarker = deps.readMarker ?? readServerRuntimeMarker;
  const getEntryMtime = deps.getEntryMtimeMs ?? defaultGetEntryMtimeMs;
  const getSourceLatest = deps.getSourceLatestMtimeMs ?? getLatestSourceMtimeMs;
  const resolveGitState = deps.resolveGitState ?? defaultResolveGitState;

  const marker = readMarker(input.nyxHome);
  const distMtimeMs = getEntryMtime(input.entryPath);
  const sourceLatestMtimeMs = getSourceLatest(input.worktreePath);
  const gitState = await resolveGitState(input.worktreePath);

  const freshness = evaluateBuildFreshness({
    entryPath: input.entryPath,
    marker,
    expectedToolCount: ALL_NYX_TOOLS.length,
    worktreePath: input.worktreePath,
    distMtimeMs,
    sourceLatestMtimeMs,
    worktreeHeadMtimeMs: gitState.headTimeMs,
  });

  return {
    version: NYXOWL_VERSION,
    toolCount: ALL_NYX_TOOLS.length,
    entryPath: freshness.entryPath,
    marker: freshness.marker,
    worktreeHead: gitState.head,
    worktreeTree: gitState.tree,
    distMtimeMs: freshness.distMtimeMs,
    sourceLatestMtimeMs: freshness.sourceLatestMtimeMs,
    stale: freshness.stale,
    staleReasons: freshness.staleReasons,
  };
}

interface ParsedArgs {
  info: boolean;
  allowStale: boolean;
  requireFresh: boolean;
  tool: string | undefined;
  argsJson: string | undefined;
  worktree: string | undefined;
  project: string | undefined;
  nyxHome: string | undefined;
  role: string | undefined;
}

function parseArgs(argv: string[]): { parsed: ParsedArgs } | { error: string } {
  const parsed: ParsedArgs = {
    info: false,
    allowStale: false,
    requireFresh: false,
    tool: undefined,
    argsJson: undefined,
    worktree: undefined,
    project: undefined,
    nyxHome: undefined,
    role: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;

    const takeValue = (): string | null => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[i + 1];
      if (next === undefined) {
        return null;
      }
      i++;
      return next;
    };

    switch (flag) {
      case "--info":
        parsed.info = true;
        break;
      case "--allow-stale":
        parsed.allowStale = true;
        break;
      case "--require-fresh":
        parsed.requireFresh = true;
        break;
      case "--help":
      case "-h":
        return { error: "" };
      case "--tool": {
        const value = takeValue();
        if (value === null) return { error: "--tool requires a tool name" };
        parsed.tool = value;
        break;
      }
      case "--args": {
        const value = takeValue();
        if (value === null) return { error: "--args requires a JSON payload" };
        parsed.argsJson = value;
        break;
      }
      case "--worktree": {
        const value = takeValue();
        if (value === null) return { error: "--worktree requires a path" };
        parsed.worktree = value;
        break;
      }
      case "--project": {
        const value = takeValue();
        if (value === null) return { error: "--project requires a path" };
        parsed.project = value;
        break;
      }
      case "--nyx-home": {
        const value = takeValue();
        if (value === null) return { error: "--nyx-home requires a path" };
        parsed.nyxHome = value;
        break;
      }
      case "--role": {
        const value = takeValue();
        if (value === null) return { error: "--role requires a role name" };
        parsed.role = value;
        break;
      }
      default:
        return { error: `Unknown gate-run option: ${raw}` };
    }
  }

  return { parsed };
}

export async function runGateRunCli(
  argv: string[],
  deps: GateRunDeps = {},
): Promise<GateRunResult> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { exitCode: 0, stdout: USAGE, stderr: "" };
  }

  const parsedResult = parseArgs(argv);
  if ("error" in parsedResult) {
    if (parsedResult.error === "") {
      return { exitCode: 0, stdout: USAGE, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `${parsedResult.error}\n${USAGE}` };
  }
  const parsed = parsedResult.parsed;

  if (parsed.info && parsed.tool !== undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Use either --info or --tool, not both.\n${USAGE}`,
    };
  }

  if (!parsed.info && parsed.tool === undefined) {
    return { exitCode: 1, stdout: "", stderr: USAGE };
  }

  const cwd = process.cwd();
  const worktreePath = path.resolve(
    parsed.worktree ??
      deps.defaultWorktreePath ??
      parsed.project ??
      deps.defaultProjectPath ??
      cwd,
  );
  const projectPath = path.resolve(
    parsed.project ?? deps.defaultProjectPath ?? worktreePath,
  );
  const nyxHome = parsed.nyxHome ?? deps.nyxHome;
  const entryPath = resolveEntryPath(deps);

  if (parsed.info) {
    const info = await buildInfo({ worktreePath, entryPath, nyxHome }, deps);
    const stdout = `${JSON.stringify(info, null, 2)}\n`;
    if (!info.stale) {
      return { exitCode: 0, stdout, stderr: "" };
    }
    if (parsed.allowStale) {
      return { exitCode: 0, stdout, stderr: "" };
    }
    return {
      exitCode: 1,
      stdout,
      stderr: `Build is stale: ${info.staleReasons.join("; ")}\n`,
    };
  }

  const toolName = parsed.tool!;
  const tool = ALL_NYX_TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown Nyxowl tool "${toolName}". Known tools: ${ALL_NYX_TOOLS.map((t) => t.name).join(", ")}\n`,
    };
  }

  let rawArgs: unknown = {};
  if (parsed.argsJson !== undefined) {
    try {
      rawArgs = JSON.parse(parsed.argsJson);
    } catch {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `--args must be valid JSON for tool "${toolName}".\n`,
      };
    }
  }
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `--args must be a JSON object for tool "${toolName}".\n`,
    };
  }

  const info = await buildInfo({ worktreePath, entryPath, nyxHome }, deps);
  const warnings: string[] = [];
  if (info.stale) {
    if (parsed.requireFresh) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Refusing to run "${toolName}" on a stale build: ${info.staleReasons.join("; ")}\n`,
      };
    }
    warnings.push(
      `Warning: running "${toolName}" on a stale build: ${info.staleReasons.join("; ")}`,
    );
  }

  const effectiveArgs: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };
  if (
    schemaAcceptsProperty(tool.inputSchema, "worktreePath") &&
    effectiveArgs["worktreePath"] === undefined
  ) {
    effectiveArgs["worktreePath"] = worktreePath;
  }
  if (
    schemaAcceptsProperty(tool.inputSchema, "repoPath") &&
    effectiveArgs["repoPath"] === undefined
  ) {
    effectiveArgs["repoPath"] = projectPath;
  }

  const response = await invokeToolDefinition(tool, effectiveArgs, {
    defaultProjectPath: projectPath,
    ...(nyxHome !== undefined ? { nyxHome } : {}),
    ...(parsed.role !== undefined ? { callerRole: parsed.role } : {}),
  });

  const isError = response.isError === true;
  const payload = {
    tool: toolName,
    isError,
    content: response.content,
    structuredContent: response.structuredContent ?? null,
  };
  return {
    exitCode: isError ? 1 : 0,
    stdout: `${JSON.stringify(payload, null, 2)}\n`,
    stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
  };
}

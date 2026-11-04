import fs from "node:fs";
import path from "node:path";
import { computeRepoIdSync } from "../../core/git.ts";
import { resolveProjectNyxowlPaths } from "../../core/paths.ts";
import { openProjectDb } from "../../mcp/db/sqlite.ts";
import {
  formatHookOutput,
  type GuardDecision,
  type HookInputPayload,
  isNyxowlSessionActive,
  isSecretFilePath,
} from "./guard.ts";

function checkFileLockConflict(options: {
  filePath: string;
  agentRole: string;
  projectPath: string;
  nyxowlHome?: string;
}): { conflict: boolean; holderRole?: string } {
  try {
    const repoId = computeRepoIdSync(options.projectPath);
    const projPaths = resolveProjectNyxowlPaths(repoId, options.nyxowlHome);
    if (!fs.existsSync(projPaths.stateDbFile)) {
      return { conflict: false };
    }
    const db = openProjectDb(projPaths.stateDbFile);
    try {
      const nowEpoch = Math.floor(Date.now() / 1000);
      // Normalize path relative to worktree if inside a worktree
      const normFile = options.filePath.replace(/\\/g, "/");
      const wtMatch = normFile.match(/\/worktrees\/[^/]+\/[^/]+\/(.+)$/);
      const relCandidates = new Set<string>([normFile, path.posix.basename(normFile)]);
      if (wtMatch?.[1]) {
        relCandidates.add(wtMatch[1]);
      }

      const rows = db.db
        .prepare("SELECT file_path, owner_role, expires_at FROM locks WHERE expires_at > ?")
        .all(nowEpoch) as Array<{ file_path: string; owner_role: string; expires_at: number }>;

      for (const r of rows) {
        if (
          (relCandidates.has(r.file_path) || normFile.endsWith(`/${r.file_path}`)) &&
          r.owner_role !== options.agentRole
        ) {
          return { conflict: true, holderRole: r.owner_role };
        }
      }
      return { conflict: false };
    } finally {
      db.close();
    }
  } catch {
    return { conflict: false };
  }
}

export function evaluateEditGuardPayload(
  payload: HookInputPayload,
  options?: {
    env?: NodeJS.ProcessEnv;
    nyxowlHome?: string;
  },
): GuardDecision | null {
  const env = options?.env ?? process.env;
  if (!isNyxowlSessionActive(payload, env)) {
    return null; // Self-scoped no-op outside Nyxowl sessions
  }

  const toolInput = payload.tool_input ?? {};
  const rawFilePath = (toolInput["file_path"] ??
    toolInput["path"] ??
    toolInput["target_file"] ??
    toolInput["filePath"] ??
    "") as string;

  if (!rawFilePath || typeof rawFilePath !== "string") {
    return { decision: "allow" };
  }

  // 1. Secret paths check
  if (isSecretFilePath(rawFilePath, options?.nyxowlHome)) {
    return {
      decision: "deny",
      ruleId: "EDIT_SECRET_PATH",
      reason: `Blocked editing protected secret or Nyxowl state file "${rawFilePath}".`,
    };
  }

  const cwd = payload.cwd ?? env["NYXOWL_PROJECT"] ?? process.cwd();
  const absFile = path.resolve(cwd, rawFilePath);
  const normAbs = absFile.replace(/\\/g, "/");

  // 2. Main checkout protection: edits during a Nyxowl session must target an isolated worktree
  const inExternalWorktree = normAbs.includes("/.nyxowl/worktrees/") || normAbs.includes("/worktrees/");
  const inFallbackWorktree = normAbs.includes("/.nyxowl/worktrees/");
  if (!inExternalWorktree && !inFallbackWorktree) {
    return {
      decision: "deny",
      ruleId: "EDIT_MAIN_CHECKOUT_FORBIDDEN",
      reason: `Blocked direct edit to main checkout file "${rawFilePath}". Start an isolated worktree via nyx_worktree_start and edit inside the worktree only.`,
    };
  }

  // 3. Red-Line CI/CD check (.github/workflows/*)
  if (normAbs.includes("/.github/workflows/")) {
    return {
      decision: "ask",
      ruleId: "REDLINE_CI_WORKFLOW",
      reason: `Red Line: Modifying CI/CD workflow "${rawFilePath}" requires explicit human confirmation.`,
    };
  }

  // 4. Role lock check when agent identity is present
  const agentRole = (
    payload.agent_name ??
    payload.subagent_type ??
    payload.agent ??
    env["NYXOWL_ROLE"] ??
    ""
  ).toLowerCase();

  // Read-only roles (`nyx-product`, `nyx-architect`) must never edit any file
  if (agentRole === "nyx-product" || agentRole === "nyx-architect") {
    return {
      decision: "deny",
      ruleId: "ROLE_READ_ONLY",
      reason: `Role "${agentRole}" is strictly read-only and may not edit files.`,
    };
  }

  if (agentRole.startsWith("nyx-")) {
    const projectPath = env["NYXOWL_PROJECT"] ?? cwd;
    const lockCheck = checkFileLockConflict({
      filePath: normAbs,
      agentRole,
      projectPath,
      ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    });
    if (lockCheck.conflict) {
      return {
        decision: "deny",
        ruleId: "FILE_LOCKED_BY_OTHER_ROLE",
        reason: `File "${rawFilePath}" is currently locked by role "${lockCheck.holderRole}". Acquire a lock via nyx_lock_acquire after "${lockCheck.holderRole}" releases it.`,
      };
    }
  }

  return { decision: "allow" };
}

export async function runEditGuardCli(stdinText?: string): Promise<{
  exitCode: number;
  stdout: string;
}> {
  try {
    const raw = stdinText !== undefined ? stdinText : fs.readFileSync(0, "utf8");
    if (!raw.trim()) {
      return { exitCode: 0, stdout: "" };
    }
    const payload = JSON.parse(raw) as HookInputPayload;
    const decision = evaluateEditGuardPayload(payload);
    if (!decision) {
      return { exitCode: 0, stdout: "" };
    }
    const stdout = formatHookOutput(decision);
    const exitCode =
      decision.decision === "deny" && process.env["NYXOWL_HOOK_EXIT_ON_DENY"] === "1"
        ? 2
        : 0;
    return { exitCode, stdout };
  } catch (err) {
    if (process.env["NYXOWL_SESSION"] !== "1") {
      return { exitCode: 0, stdout: "" };
    }
    const failSafe: GuardDecision = {
      decision: "deny",
      ruleId: "FAIL_SAFE_EDIT_GUARD_ERROR",
      reason: `Nyxowl edit-guard fail-safe deny: ${(err as Error).message}`,
    };
    return {
      exitCode: process.env["NYXOWL_HOOK_EXIT_ON_DENY"] === "1" ? 2 : 0,
      stdout: formatHookOutput(failSafe),
    };
  }
}

import fs from "node:fs";
import { computeRepoIdSync } from "../../core/git.ts";
import { resolveProjectNyxowlPaths } from "../../core/paths.ts";
import { enforceTokenBudget } from "../../core/tokens.ts";
import { openProjectDb } from "../../mcp/db/sqlite.ts";
import { type HookInputPayload, isNyxowlSessionActive } from "./guard.ts";

export function buildHydrateDigestForHook(
  projectPath: string,
  nyxowlHome?: string,
): string {
  try {
    const repoId = computeRepoIdSync(projectPath);
    const projPaths = resolveProjectNyxowlPaths(repoId, nyxowlHome);

    const lines: string[] = [
      `[Nyxowl Session Hydrate | repo=${repoId}]`,
    ];

    if (fs.existsSync(projPaths.stateDbFile)) {
      const db = openProjectDb(projPaths.stateDbFile);
      try {
        const wt = db.db
          .prepare(
            "SELECT task_slug AS slug, branch, worktree_path FROM worktrees WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1",
          )
          .get() as { slug: string; branch: string; worktree_path: string } | undefined;
        if (wt) {
          lines.push(`Active Worktree: ${wt.slug} (${wt.branch}) at ${wt.worktree_path}`);
        } else {
          lines.push("Active Worktree: none (call nyx_worktree_start before editing)");
        }

        const slice = db.db
          .prepare("SELECT slice_id, label FROM slices ORDER BY seq DESC LIMIT 1")
          .get() as { slice_id: string; label: string } | undefined;
        if (slice) {
          lines.push(`Latest Slice: ${slice.slice_id} (${slice.label})`);
        }

        const handoff = db.db
          .prepare(
            "SELECT completed_task, next_task FROM handoffs ORDER BY id DESC LIMIT 1",
          )
          .get() as { completed_task: string; next_task: string } | undefined;
        if (handoff) {
          lines.push(`Last Handoff: completed="${handoff.completed_task}" -> next="${handoff.next_task}"`);
        }
      } finally {
        db.close();
      }
    } else if (fs.existsSync(projPaths.handoffFile)) {
      const raw = fs.readFileSync(projPaths.handoffFile, "utf8").trim();
      lines.push(raw.slice(0, 600));
    } else {
      lines.push("Fresh project state. Call nyx_context_hydrate and nyx_dna_get to begin.");
    }

    const joined = lines.join("\n");
    return enforceTokenBudget(joined, 400).text;
  } catch {
    return "[Nyxowl Session Hydrate] Call nyx_context_hydrate and nyx_dna_get to initialize.";
  }
}

/**
 * Shared invocation gate for session hooks (session-start, pre-compact).
 */
export function isHookPayloadActive(payload: HookInputPayload): boolean {
  // The hook payload is the only trusted activation source for session hooks:
  // hydrate text must not be emitted for an empty or unknown-agent stdin just
  // because the parent process happens to carry a NYXOWL_SESSION marker.
  const envWithoutSessionMarker: NodeJS.ProcessEnv = { ...process.env };
  delete envWithoutSessionMarker["NYXOWL_SESSION"];
  return isNyxowlSessionActive(payload, envWithoutSessionMarker);
}

export async function runSessionStartCli(stdinText?: string): Promise<{
  exitCode: number;
  stdout: string;
}> {
  try {
    const raw = stdinText !== undefined ? stdinText : fs.readFileSync(0, "utf8");
    const payload = raw.trim() ? (JSON.parse(raw) as HookInputPayload) : {};
    // Hydration activates on hook-payload identity only. The NYXOWL_SESSION env
    // value is a process-scope marker for host-spawned MCP servers, not a hook
    // trigger: an inherited marker (e.g. from a parent CLI process) must not
    // turn an empty or unknown-agent payload into hydrate output.
    if (!isHookPayloadActive(payload)) {
      return { exitCode: 0, stdout: "" };
    }
    const projectPath =
      process.env["NYXOWL_PROJECT"] ?? payload.cwd ?? process.cwd();
    const digest = buildHydrateDigestForHook(projectPath);
    const out = JSON.stringify({
      additionalContext: digest,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: digest,
      },
    });
    return { exitCode: 0, stdout: out };
  } catch {
    // Fail-safe: crashing session hook is a no-op (§8.6)
    return { exitCode: 0, stdout: "" };
  }
}

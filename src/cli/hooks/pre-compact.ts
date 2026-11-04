import fs from "node:fs";
import { type HookInputPayload, isNyxowlSessionActive } from "./guard.ts";
import { buildHydrateDigestForHook } from "./session-start.ts";

export async function runPreCompactCli(stdinText?: string): Promise<{
  exitCode: number;
  stdout: string;
}> {
  try {
    const raw = stdinText !== undefined ? stdinText : fs.readFileSync(0, "utf8");
    const payload = raw.trim() ? (JSON.parse(raw) as HookInputPayload) : {};
    if (!isNyxowlSessionActive(payload)) {
      return { exitCode: 0, stdout: "" };
    }
    const projectPath =
      process.env["NYXOWL_PROJECT"] ?? payload.cwd ?? process.cwd();
    const digest = buildHydrateDigestForHook(projectPath);
    const out = JSON.stringify({
      additionalContext: digest,
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: digest,
      },
    });
    return { exitCode: 0, stdout: out };
  } catch {
    // Fail-safe: crashing session hook is a no-op (§8.6)
    return { exitCode: 0, stdout: "" };
  }
}

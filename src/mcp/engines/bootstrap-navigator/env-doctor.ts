import fs from "node:fs";
import { rgPath as vscodeRgPath } from "@vscode/ripgrep";
import { z } from "zod";
import { execCommand } from "../../../core/exec.ts";
import { defineTool } from "../../tool.ts";

export interface RuntimeToolStatus {
  name: string;
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface DetectedHostStatus {
  id: string;
  binary: string;
  installed: boolean;
  version: string | null;
  tier: "A (+sandbox)" | "A" | "B (+sandbox)" | "B" | "C";
  deliveryMode: "session-scoped" | "user-level";
}

/**
 * Resolves the ripgrep binary path: checks system `/usr/bin/rg` first,
 * then falls back to `@vscode/ripgrep`'s bundled `rgPath`.
 */
export function resolveRipgrepBinary(): string {
  if (fs.existsSync("/usr/bin/rg")) {
    return "/usr/bin/rg";
  }
  if (fs.existsSync("/usr/local/bin/rg")) {
    return "/usr/local/bin/rg";
  }
  return vscodeRgPath;
}

async function probeBinary(
  name: string,
  versionArgs: string[] = ["--version"],
): Promise<RuntimeToolStatus> {
  const whichRes = await execCommand("which", [name], { timeoutMs: 3_000 });
  if (whichRes.exitCode !== 0 || !whichRes.stdout.trim()) {
    return { name, installed: false, version: null, path: null };
  }
  const binPath = whichRes.stdout.trim().split(/\r?\n/)[0] ?? null;
  const verRes = await execCommand(name, versionArgs, { timeoutMs: 5_000 });
  const firstLine = (verRes.stdout || verRes.stderr).trim().split(/\r?\n/)[0] ?? null;
  return {
    name,
    installed: true,
    version: firstLine,
    path: binPath,
  };
}

export async function detectInstalledHosts(): Promise<DetectedHostStatus[]> {
  const specs: Array<{
    id: string;
    binary: string;
    tier: "A (+sandbox)" | "A" | "B (+sandbox)" | "B" | "C";
    deliveryMode: "session-scoped" | "user-level";
  }> = [{ id: "opencode", binary: "opencode", tier: "A", deliveryMode: "session-scoped" }];

  const results: DetectedHostStatus[] = [];
  for (const s of specs) {
    const probed = await probeBinary(s.binary, ["--version"]);
    results.push({
      id: s.id,
      binary: s.binary,
      installed: probed.installed,
      version: probed.version,
      tier: s.tier,
      deliveryMode: s.deliveryMode,
    });
  }
  return results;
}

export const envDoctorInputSchema = z.object({
  repoPath: z.string().optional(),
});

export const envDoctorOutputSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  nodeVersion: z.string(),
  ripgrepPath: z.string(),
  ghAuthenticated: z.boolean(),
  runtimes: z.array(
    z.object({
      name: z.string(),
      installed: z.boolean(),
      version: z.string().nullable(),
      path: z.string().nullable(),
    }),
  ),
  hosts: z.array(
    z.object({
      id: z.string(),
      binary: z.string(),
      installed: z.boolean(),
      version: z.string().nullable(),
      tier: z.enum(["A (+sandbox)", "A", "B (+sandbox)", "B", "C"]),
      deliveryMode: z.enum(["session-scoped", "user-level"]),
    }),
  ),
});

export const nyxEnvDoctorTool = defineTool({
  name: "nyx_env_doctor",
  description: "Checks installed runtimes/toolchains, the OpenCode host with its enforcement tier, and gh auth status.",
  annotations: {
    title: "Environment & Toolchain Doctor",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: envDoctorInputSchema,
  outputSchema: envDoctorOutputSchema,
  handler: async () => {
    const runtimeNames = [
      ["node", ["--version"]],
      ["npm", ["--version"]],
      ["git", ["--version"]],
      ["python3", ["--version"]],
      ["uv", ["--version"]],
      ["go", ["version"]],
      ["cargo", ["--version"]],
      ["gh", ["--version"]],
    ] as const;

    const runtimes = await Promise.all(
      runtimeNames.map(([name, args]) => probeBinary(name, [...args])),
    );

    const hosts = await detectInstalledHosts();
    const ghStatus = await execCommand("gh", ["auth", "status"], { timeoutMs: 5_000 });

    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      ripgrepPath: resolveRipgrepBinary(),
      ghAuthenticated: ghStatus.exitCode === 0,
      runtimes,
      hosts,
    };
  },
});

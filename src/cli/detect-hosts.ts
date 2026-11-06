import fs from "node:fs";
import path from "node:path";
import * as semver from "semver";
import { execCommand } from "../core/exec.ts";

export type HostId = "opencode";

export type SecurityTier = "A" | "B" | "C";

export interface HostSpec {
  id: HostId;
  displayName: string;
  binaries: string[];
  tier: SecurityTier;
  deliveryLevel: 1 | 2;
  supportsExternalWorktree: boolean;
  supportsNativeSubagents: boolean;
  verifiedVersion: string;
  priority: number;
}

export interface DetectedHost extends HostSpec {
  installed: boolean;
  binaryPath: string | null;
  detectedVersion: string | null;
  versionDriftWarning: string | null;
}

export const HOST_SPECS: readonly HostSpec[] = [
  {
    id: "opencode",
    displayName: "OpenCode",
    binaries: ["opencode"],
    tier: "A",
    deliveryLevel: 1,
    supportsExternalWorktree: true,
    supportsNativeSubagents: true,
    verifiedVersion: "2.2.5",
    priority: 1,
  },
] as const;

export function findBinaryOnPath(
  binaryName: string,
  envPath = process.env["PATH"] ?? "",
): string | null {
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binaryName);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue searching
    }
  }
  return null;
}

function extractSemver(rawOutput: string): string | null {
  const match = rawOutput.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  if (!match || !match[1]) return null;
  return semver.valid(match[1]);
}

export async function detectInstalledHosts(options?: {
  envPath?: string;
}): Promise<DetectedHost[]> {
  const envPath = options?.envPath ?? process.env["PATH"] ?? "";
  const results: DetectedHost[] = [];

  for (const spec of HOST_SPECS) {
    let foundBin: string | null = null;
    for (const binName of spec.binaries) {
      const candidate = findBinaryOnPath(binName, envPath);
      if (candidate) {
        foundBin = candidate;
        break;
      }
    }

    if (!foundBin) {
      results.push({
        ...spec,
        installed: false,
        binaryPath: null,
        detectedVersion: null,
        versionDriftWarning: null,
      });
      continue;
    }

    let detectedVersion: string | null = null;
    let versionDriftWarning: string | null = null;
    try {
      const res = await execCommand(foundBin, ["--version"], {
        timeoutMs: 3000,
        env: { ...process.env, PATH: envPath },
      });
      const combined = `${res.stdout}\n${res.stderr}`.trim();
      detectedVersion = extractSemver(combined);

      if (detectedVersion && semver.valid(spec.verifiedVersion)) {
        if (semver.major(detectedVersion) > semver.major(spec.verifiedVersion)) {
          versionDriftWarning = `${spec.displayName} v${detectedVersion} is a newer major version than last verified v${spec.verifiedVersion} in docs/host-matrix.md`;
        }
      }
    } catch {
      // Version probe failed; binary still exists
    }

    results.push({
      ...spec,
      installed: true,
      binaryPath: foundBin,
      detectedVersion,
      versionDriftWarning,
    });
  }

  return results.sort((a, b) => a.priority - b.priority);
}

/**
 * Selects the host to launch based on an explicit `--host` or `config.preferredHost`.
 * Only OpenCode is supported, so it is the sole candidate.
 */
export function selectHostToLaunch(
  detected: DetectedHost[],
  preferredHost?: HostId | null,
): DetectedHost | null {
  if (preferredHost) {
    const match = detected.find((h) => h.id === preferredHost && h.installed);
    if (match) return match;
  }
  const installed = detected.filter((h) => h.installed).sort((a, b) => a.priority - b.priority);
  return installed[0] ?? null;
}

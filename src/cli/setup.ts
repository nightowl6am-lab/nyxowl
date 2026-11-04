import fs from "node:fs";
import * as semver from "semver";
import { DEFAULT_NYXOWL_CONFIG } from "../core/config.ts";
import { NyxError } from "../core/errors.ts";
import { execCommand } from "../core/exec.ts";
import { ensureGlobalNyxowlDirs, resolveGlobalNyxowlPaths } from "../core/paths.ts";
import { ensureReceiptKey } from "../core/receipts.ts";
import { generateAntigravityHostPackage } from "./adapters/antigravity.ts";
import { generateClaudeHostPackage } from "./adapters/claude.ts";
import { generateCodexHostPackage } from "./adapters/codex.ts";
import { generateCursorHostPackage } from "./adapters/cursor.ts";
import { generateGeminiHostPackage } from "./adapters/gemini.ts";
import { generateOpenCodeHostPackage } from "./adapters/opencode.ts";
import { generateWindsurfHostPackage } from "./adapters/windsurf.ts";
import {
  type DetectedHost,
  detectInstalledHosts,
  selectHostToLaunch,
} from "./detect-hosts.ts";
import { loadInstallManifest, saveInstallManifest } from "./manifest.ts";
import { verifyVendoredSkillIntegrity } from "./skills.ts";

export const NYXOWL_VERSION = "0.1.0";

export interface SetupResult {
  firstRunOrUpgraded: boolean;
  nyxowlHome: string;
  nodeVersion: string;
  gitVersion: string;
  detectedHosts: DetectedHost[];
  defaultHost: DetectedHost | null;
  skillsChecked: number;
  summaryLines: string[];
}

export async function runPreflightChecks(options?: {
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  envPath?: string;
}): Promise<{ nodeVersion: string; gitVersion: string }> {
  const platform = options?.platform ?? process.platform;
  if (platform === "win32") {
    throw new NyxError(
      "ERR_EXEC_FAILED",
      "Native Windows is not supported in Nyxowl v1. Please install WSL2 (`wsl --install -d Ubuntu`) and run `nyxowl` inside WSL2. See docs/windows-wsl.md.",
    );
  }

  const rawNodeVer = (options?.nodeVersion ?? process.version).replace(/^v/, "");
  if (!semver.gte(rawNodeVer, "22.13.0")) {
    throw new NyxError(
      "ERR_EXEC_FAILED",
      `Node.js >= 22.13.0 is required (found v${rawNodeVer}). Upgrade via: nvm install 22 && nvm use 22`,
    );
  }

  const gitRes = await execCommand("git", ["--version"], {
    timeoutMs: 5000,
    ...(options?.envPath ? { env: { ...process.env, PATH: options.envPath } } : {}),
  });
  if (gitRes.exitCode !== 0) {
    throw new NyxError(
      "ERR_GIT_FAILED",
      "git (>= 2.30) is required on PATH. Install git via your system package manager.",
    );
  }
  const gitMatch = gitRes.stdout.match(/(\d+\.\d+\.\d+)/);
  const gitVersion = gitMatch?.[1] ?? "2.30.0";
  if (semver.valid(gitVersion) && semver.lt(gitVersion, "2.30.0")) {
    throw new NyxError(
      "ERR_GIT_FAILED",
      `git >= 2.30.0 is required for worktree isolation (found ${gitVersion}).`,
    );
  }

  return { nodeVersion: rawNodeVer, gitVersion };
}

export async function ensureFirstRunSetup(options?: {
  nyxowlHome?: string;
  envPath?: string;
  force?: boolean;
  userCursorDir?: string;
  userWindsurfDir?: string;
  userCodexHome?: string;
}): Promise<SetupResult> {
  const { nodeVersion, gitVersion } = await runPreflightChecks({
    ...(options?.envPath ? { envPath: options.envPath } : {}),
  });

  const globalPaths = ensureGlobalNyxowlDirs(options?.nyxowlHome);
  ensureReceiptKey(options?.nyxowlHome);

  if (!fs.existsSync(globalPaths.globalConfigFile)) {
    fs.writeFileSync(
      globalPaths.globalConfigFile,
      `${JSON.stringify(DEFAULT_NYXOWL_CONFIG, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  const manifest = loadInstallManifest(options?.nyxowlHome);
  const alreadyInitialized =
    !options?.force &&
    fs.existsSync(globalPaths.installManifestFile) &&
    manifest.nyxowlVersion === NYXOWL_VERSION &&
    fs.existsSync(globalPaths.hostsDir);

  const integrity = verifyVendoredSkillIntegrity();
  if (!integrity.valid) {
    throw new NyxError(
      "ERR_CONFIG_INVALID",
      `Bundled skill integrity check failed: ${JSON.stringify(integrity.mismatches)}`,
    );
  }

  const detectedHosts = await detectInstalledHosts({
    ...(options?.envPath ? { envPath: options.envPath } : {}),
  });
  const defaultHost = selectHostToLaunch(detectedHosts);

  if (!alreadyInitialized) {
    // Always generate session-scoped Tier-A/B packages inside ~/.nyxowl/hosts/<host>
    generateClaudeHostPackage({
      ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    });
    generateOpenCodeHostPackage({
      ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    });
    generateCodexHostPackage({
      ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
      ...(options?.userCodexHome ? { userCodexHome: options.userCodexHome } : {}),
    });
    generateGeminiHostPackage({
      ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    });
    generateAntigravityHostPackage({
      ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    });

    // Only generate user-level Cursor/Windsurf files if those hosts are detected or explicitly requested
    if (detectedHosts.some((h) => h.id === "cursor" && h.installed) || options?.userCursorDir) {
      generateCursorHostPackage({
        ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
        ...(options?.userCursorDir ? { userCursorDir: options.userCursorDir } : {}),
      });
    }
    if (detectedHosts.some((h) => h.id === "windsurf" && h.installed) || options?.userWindsurfDir) {
      generateWindsurfHostPackage({
        ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
        ...(options?.userWindsurfDir ? { userWindsurfDir: options.userWindsurfDir } : {}),
      });
    }

    const updatedManifest = loadInstallManifest(options?.nyxowlHome);
    updatedManifest.nyxowlVersion = NYXOWL_VERSION;
    saveInstallManifest(updatedManifest, options?.nyxowlHome);
  }

  const installedNames = detectedHosts
    .filter((h) => h.installed)
    .map((h) => `${h.displayName} (Tier ${h.tier})`)
    .join(", ");

  const summaryLines = [
    `Nyxowl v${NYXOWL_VERSION} initialized at ${resolveGlobalNyxowlPaths(options?.nyxowlHome).homeDir} (0700)`,
    `Runtimes verified: Node v${nodeVersion}, git v${gitVersion}`,
    `Skills verified: ${integrity.checked} bundled skills (SHA-256 OK, 0 network fetches required)`,
    `Detected hosts: ${installedNames || "none on PATH"}`,
    `Default host: ${defaultHost ? `${defaultHost.displayName} (Tier ${defaultHost.tier})` : "none"}`,
  ];

  return {
    firstRunOrUpgraded: !alreadyInitialized,
    nyxowlHome: globalPaths.homeDir,
    nodeVersion,
    gitVersion,
    detectedHosts,
    defaultHost,
    skillsChecked: integrity.checked,
    summaryLines,
  };
}

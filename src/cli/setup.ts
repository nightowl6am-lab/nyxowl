import fs from "node:fs";
import * as semver from "semver";
import { DEFAULT_NYXOWL_CONFIG } from "../core/config.ts";
import { NyxError } from "../core/errors.ts";
import { execCommand } from "../core/exec.ts";
import { ensureGlobalNyxowlDirs, resolveGlobalNyxowlPaths } from "../core/paths.ts";
import { ensureReceiptKey } from "../core/receipts.ts";
import { NYXOWL_VERSION } from "../core/version.ts";
import { generateOpenCodeHostPackage } from "./adapters/opencode.ts";
import {
  type DetectedHost,
  detectInstalledHosts,
  selectHostToLaunch,
} from "./detect-hosts.ts";
import { loadInstallManifest, saveInstallManifest } from "./manifest.ts";
import { getSkillSlotReport } from "./skills.ts";
import { ensureTestWriterRuntime, type TestWriterInstallStatus } from "./testwriter.ts";

export { NYXOWL_VERSION };

export interface SetupResult {
  firstRunOrUpgraded: boolean;
  nyxowlHome: string;
  nodeVersion: string;
  gitVersion: string;
  detectedHosts: DetectedHost[];
  defaultHost: DetectedHost | null;
  skillSlots: Array<{ agentId: string; path: string; loaded: boolean }>;
  testWriter: { status: TestWriterInstallStatus; root: string; message: string };
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
  if (platform !== "linux") {
    throw new NyxError(
      "ERR_EXEC_FAILED",
      `Nyxowl v1 requires Linux (including WSL2 on Windows); detected platform "${platform}". Only Linux is supported. See docs/windows-wsl.md.`,
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
  installTestWriter?: boolean;
  testWriterSourceDir?: string;
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

  const skillSlots = getSkillSlotReport();

  const detectedHosts = await detectInstalledHosts({
    ...(options?.envPath ? { envPath: options.envPath } : {}),
  });
  const defaultHost = selectHostToLaunch(detectedHosts);

  if (!alreadyInitialized) {
    generateOpenCodeHostPackage({
      ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    });

    const updatedManifest = loadInstallManifest(options?.nyxowlHome);
    updatedManifest.nyxowlVersion = NYXOWL_VERSION;
    saveInstallManifest(updatedManifest, options?.nyxowlHome);
  }

  // Test-Writer is part of the normal first-run path. It is idempotent and a
  // failure here must never block launching the rest of Nyxowl; the broker
  // stays fail-closed until the runtime is ready.
  const testWriter = await ensureTestWriterRuntime({
    ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    ...(options?.testWriterSourceDir ? { sourceDir: options.testWriterSourceDir } : {}),
    ...(options?.envPath ? { envPath: options.envPath } : {}),
    ...(options?.installTestWriter !== undefined ? { install: options.installTestWriter } : {}),
  });

  const installedNames = detectedHosts
    .filter((h) => h.installed)
    .map((h) => `${h.displayName} (Tier ${h.tier})`)
    .join(", ");

  const filledSlots = skillSlots.filter((slot) => slot.loaded).length;
  const testWriterLine =
    testWriter.status === "installed" || testWriter.status === "already-installed"
      ? `Test-Writer: ready at ${testWriter.root}`
      : testWriter.status === "disabled"
        ? "Test-Writer: skipped (NYXOWL_TESTWRITER_INSTALL=0)"
        : testWriter.status === "unavailable"
          ? `Test-Writer: unavailable — ${testWriter.message}`
          : `Test-Writer: install failed — ${testWriter.message}`;
  const summaryLines = [
    `Nyxowl v${NYXOWL_VERSION} initialized at ${resolveGlobalNyxowlPaths(options?.nyxowlHome).homeDir} (0700)`,
    `Runtimes verified: Node v${nodeVersion}, git v${gitVersion}`,
    `Skill slots: ${skillSlots.length} total (${filledSlots} filled, ${skillSlots.length - filledSlots} empty)`,
    `Detected host: ${installedNames || "none on PATH"}`,
    `OpenCode: ${defaultHost ? `${defaultHost.displayName} (Tier ${defaultHost.tier})` : "none"}`,
    testWriterLine,
  ];

  return {
    firstRunOrUpgraded: !alreadyInitialized,
    nyxowlHome: globalPaths.homeDir,
    nodeVersion,
    gitVersion,
    detectedHosts,
    defaultHost,
    skillSlots,
    testWriter: {
      status: testWriter.status,
      root: testWriter.root,
      message: testWriter.message,
    },
    summaryLines,
  };
}

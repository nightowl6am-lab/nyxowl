import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadNyxowlConfig } from "../core/config.ts";
import { NyxError } from "../core/errors.ts";
import { computeRepoId, getWorkingTreeStatus, resolveGitCommonDir } from "../core/git.ts";
import {
  ensureProjectNyxowlDirs,
  resolveGlobalNyxowlPaths,
} from "../core/paths.ts";
import { openProjectDb } from "../mcp/db/sqlite.ts";
import { generateOpenCodeHostPackage } from "./adapters/opencode.ts";
import {
  type DetectedHost,
  type HostId,
  selectHostToLaunch,
} from "./detect-hosts.ts";
import { ensureFirstRunSetup } from "./setup.ts";

export type FolderClassification = "empty" | "adopt-no-git" | "git-repo";

export interface FolderClassificationResult {
  projectPath: string;
  classification: FolderClassification;
  mainCheckoutDirty: boolean;
  repoId: string;
}

export interface LaunchSessionResult {
  projectPath: string;
  repoId: string;
  classification: FolderClassification;
  mainCheckoutDirty: boolean;
  selectedHost: DetectedHost;
  worktreeRoot: string;
  launchBinary: string;
  launchArgs: string[];
  launchEnv: Record<string, string>;
  exitCode: number;
}

export async function classifyProjectFolder(
  targetPath: string,
): Promise<FolderClassificationResult> {
  const absPath = path.resolve(targetPath);
  if (!fs.existsSync(absPath)) {
    fs.mkdirSync(absPath, { recursive: true });
  }

  const entries = fs
    .readdirSync(absPath)
    .filter((name) => name !== "." && name !== ".." && name !== ".DS_Store");

  if (entries.length === 0) {
    return {
      projectPath: absPath,
      classification: "empty",
      mainCheckoutDirty: false,
      repoId: await computeRepoId(absPath, null),
    };
  }

  const commonDir = await resolveGitCommonDir(absPath);
  if (!commonDir) {
    return {
      projectPath: absPath,
      classification: "adopt-no-git",
      mainCheckoutDirty: false,
      repoId: await computeRepoId(absPath, null),
    };
  }

  const status = await getWorkingTreeStatus(absPath);
  const repoId = await computeRepoId(absPath, commonDir);
  return {
    projectPath: absPath,
    classification: "git-repo",
    mainCheckoutDirty: !status.clean,
    repoId,
  };
}

export async function launchNyxowlSession(options?: {
  targetPath?: string;
  hostOverride?: HostId;
  includeDirty?: boolean;
  nyxowlHome?: string;
  envPath?: string;
  dryRun?: boolean;
  installTestWriter?: boolean;
}): Promise<LaunchSessionResult> {
  const requestedHost = options?.hostOverride as string | undefined;
  if (requestedHost !== undefined && requestedHost !== "opencode") {
    throw new NyxError(
      "ERR_HOST_UNSUPPORTED",
      `Unsupported host "${String(requestedHost)}". OpenCode is the only supported host.`,
    );
  }

  const setupRes = await ensureFirstRunSetup({
    ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    ...(options?.envPath ? { envPath: options.envPath } : {}),
    ...(options?.installTestWriter !== undefined
      ? { installTestWriter: options.installTestWriter }
      : {}),
  });

  const targetDir = path.resolve(options?.targetPath ?? process.cwd());
  const folderInfo = await classifyProjectFolder(targetDir);
  const config = loadNyxowlConfig({
    projectRoot: targetDir,
    ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
  });

  const preferred = options?.hostOverride ?? config.preferredHost ?? null;
  const selectedHost = selectHostToLaunch(setupRes.detectedHosts, preferred);
  if (!selectedHost || !selectedHost.binaryPath) {
    throw new NyxError(
      "ERR_HOST_UNSUPPORTED",
      [
        "OpenCode is not installed on PATH.",
        "Install OpenCode: npm install -g @opencode/cli@2.2.5",
      ].join("\n"),
    );
  }

  // Initialize project state inside ~/.nyxowl/projects/<repoId>/state.db (NEVER inside the project!)
  const projPaths = ensureProjectNyxowlDirs(folderInfo.repoId, options?.nyxowlHome);
  const db = openProjectDb(projPaths.stateDbFile);
  try {
    const nowIso = new Date().toISOString();
    db.withWriteTransaction((conn) => {
      const upsertMeta = conn.prepare(
        "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      );
      upsertMeta.run("project_path", folderInfo.projectPath, nowIso);
      upsertMeta.run("folder_state", folderInfo.classification, nowIso);
      upsertMeta.run("main_checkout_dirty", folderInfo.mainCheckoutDirty ? "1" : "0", nowIso);
      upsertMeta.run("include_dirty", options?.includeDirty ? "1" : "0", nowIso);
      upsertMeta.run("active_host", selectedHost.id, nowIso);
    });
  } finally {
    db.close();
  }

  const globalPaths = resolveGlobalNyxowlPaths(options?.nyxowlHome);
  const worktreeRoot = projPaths.worktreesRootDir;
  fs.mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });

  const openCodePackage = generateOpenCodeHostPackage({
    ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
    projectPath: folderInfo.projectPath,
    worktreeRoot,
  });
  const launchArgs = openCodePackage.launchArgs;
  const adapterEnv: Record<string, string> = openCodePackage.launchEnv;

  const launchEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(options?.envPath ? { PATH: options.envPath } : {}),
    ...adapterEnv,
    NYXOWL_SESSION: "1",
    NYXOWL_PROJECT: folderInfo.projectPath,
    NYXOWL_HOME: globalPaths.homeDir,
    NYXOWL_FOLDER_STATE: folderInfo.classification,
    ...(options?.includeDirty ? { NYXOWL_INCLUDE_DIRTY: "1" } : {}),
  };

  if (options?.dryRun) {
    return {
      projectPath: folderInfo.projectPath,
      repoId: folderInfo.repoId,
      classification: folderInfo.classification,
      mainCheckoutDirty: folderInfo.mainCheckoutDirty,
      selectedHost,
      worktreeRoot,
      launchBinary: selectedHost.binaryPath,
      launchArgs,
      launchEnv,
      exitCode: 0,
    };
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(selectedHost.binaryPath!, launchArgs, {
      cwd: folderInfo.projectPath,
      env: launchEnv,
      stdio: "inherit",
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? 0));
  });

  return {
    projectPath: folderInfo.projectPath,
    repoId: folderInfo.repoId,
    classification: folderInfo.classification,
    mainCheckoutDirty: folderInfo.mainCheckoutDirty,
    selectedHost,
    worktreeRoot,
    launchBinary: selectedHost.binaryPath,
    launchArgs,
    launchEnv,
    exitCode,
  };
}

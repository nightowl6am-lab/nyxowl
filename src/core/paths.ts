import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface NyxHomeLayout {
  homeDir: string;
  configPath: string;
  globalConfigFile: string;
  manifestPath: string;
  installManifestFile: string;
  secretsDir: string;
  receiptKeyPath: string;
  receiptKeyFile: string;
  githubAppDir: string;
  hostsDir: string;
  worktreesDir: string;
  projectsDir: string;
}

export interface NyxProjectLayout {
  repoId: string;
  projectDir: string;
  projectStateDir: string;
  stateDbPath: string;
  stateDbFile: string;
  handoffPath: string;
  handoffFile: string;
  artifactsDir: string;
  prsDir: string;
  externalWorktreeRoot: string;
  worktreesRootDir: string;
}

export function resolveNyxHome(overrideHome?: string): string {
  const raw = overrideHome ?? process.env["NYXOWL_HOME"] ?? path.join(os.homedir(), ".nyxowl");
  return path.resolve(raw);
}

export function getNyxHomeLayout(overrideHome?: string): NyxHomeLayout {
  const homeDir = resolveNyxHome(overrideHome);
  const secretsDir = path.join(homeDir, "secrets");
  const configPath = path.join(homeDir, "config.json");
  const manifestPath = path.join(homeDir, "install-manifest.json");
  const receiptKeyPath = path.join(secretsDir, "receipt.key");
  return {
    homeDir,
    configPath,
    globalConfigFile: configPath,
    manifestPath,
    installManifestFile: manifestPath,
    secretsDir,
    receiptKeyPath,
    receiptKeyFile: receiptKeyPath,
    githubAppDir: path.join(secretsDir, "github-app"),
    hostsDir: path.join(homeDir, "hosts"),
    worktreesDir: path.join(homeDir, "worktrees"),
    projectsDir: path.join(homeDir, "projects"),
  };
}

export const resolveGlobalNyxowlPaths = getNyxHomeLayout;

export function ensureNyxHome(overrideHome?: string): NyxHomeLayout {
  const layout = getNyxHomeLayout(overrideHome);
  fs.mkdirSync(layout.homeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(layout.homeDir, 0o700);
  } catch {
    // Ignore chmod errors on non-POSIX filesystems
  }

  fs.mkdirSync(layout.secretsDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(layout.secretsDir, 0o700);
  } catch {
    // Ignore
  }

  fs.mkdirSync(layout.hostsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.worktreesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.projectsDir, { recursive: true, mode: 0o700 });
  return layout;
}

export const ensureGlobalNyxowlDirs = ensureNyxHome;

export function getProjectLayout(repoId: string, overrideHome?: string): NyxProjectLayout {
  const home = getNyxHomeLayout(overrideHome);
  const projectDir = path.join(home.projectsDir, repoId);
  const stateDbPath = path.join(projectDir, "state.db");
  const handoffPath = path.join(projectDir, "HANDOFF.md");
  const externalWorktreeRoot = path.join(home.worktreesDir, repoId);
  return {
    repoId,
    projectDir,
    projectStateDir: projectDir,
    stateDbPath,
    stateDbFile: stateDbPath,
    handoffPath,
    handoffFile: handoffPath,
    artifactsDir: path.join(projectDir, "artifacts"),
    prsDir: path.join(projectDir, "prs"),
    externalWorktreeRoot,
    worktreesRootDir: externalWorktreeRoot,
  };
}

export const resolveProjectNyxowlPaths = getProjectLayout;

export function ensureProjectLayout(repoId: string, overrideHome?: string): NyxProjectLayout {
  ensureNyxHome(overrideHome);
  const layout = getProjectLayout(repoId, overrideHome);
  fs.mkdirSync(layout.projectDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.artifactsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.prsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.externalWorktreeRoot, { recursive: true, mode: 0o700 });
  return layout;
}

export const ensureProjectNyxowlDirs = ensureProjectLayout;

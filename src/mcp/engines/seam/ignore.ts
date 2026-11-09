import fs from "node:fs";
import path from "node:path";
import { execCommand } from "../../../core/exec.ts";

/**
 * Central ignore registry for the seam scanner.
 *
 * Seam scans must never descend into directories that belong to a build
 * toolchain, package manager, dependency cache, VCS, or Nyxowl's own state.
 * Files inside those directories are generated artifacts, not source: scanning
 * them produces false env/api mismatches (e.g. a bundled chunk containing a
 * stringified env reference) and can balloon the report past its token budget.
 */
export const GENERATED_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  // VCS
  ".git",
  ".hg",
  ".svn",
  // Nyxowl state
  ".nyxowl",
  // Package managers / dependencies
  "node_modules",
  "vendor",
  "jspm_packages",
  // JS bundlers / frameworks
  ".next",
  "out",
  "build",
  ".output",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  "dist",
  ".parcel-cache",
  ".angular",
  ".nx",
  "storybook-static",
  // Rust / C / C#
  "target",
  "bin",
  "obj",
  // Python
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  // Coverage
  "coverage",
  ".coverage",
  ".nyc_output",
  // Temp
  "tmp",
  ".tmp",
  "temp",
]);

/**
 * Returns true when any segment of the repo-relative path lives inside a
 * generated/cache directory. Works for both directories ("build/out") and
 * files ("build/out/chunk.js"); the never-descend guarantee makes the two
 * cases equivalent.
 */
export function isIgnoredSeamPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.split("/").some((segment) => GENERATED_IGNORED_DIR_NAMES.has(segment));
}

interface FsEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

function readEntries(dir: string): FsEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Deterministic pruning walker: enumerates source files under rootDir while
 * never descending into any directory in GENERATED_IGNORED_DIR_NAMES.
 */
export function walkSeamFiles(rootDir: string, currentDir = rootDir, acc: string[] = []): string[] {
  for (const entry of readEntries(currentDir)) {
    if (GENERATED_IGNORED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory) {
      walkSeamFiles(rootDir, full, acc);
    } else if (entry.isFile) {
      acc.push(path.relative(rootDir, full).replace(/\\/g, "/"));
    }
  }
  return acc;
}

/**
 * Enumerates seam-scannable files for a worktree.
 *
 * Preferred path: `git ls-files -z -co --exclude-standard` (tracked + untracked
 * files minus gitignored paths), which honors the repository's own ignore
 * rules. When git is unavailable or the directory is not a repository, fall
 * back to the deterministic pruning walker. The central generated-dir ignore
 * list is always applied on top, in both paths.
 */
export async function listSeamFiles(worktreePath: string): Promise<string[]> {
  if (!fs.existsSync(worktreePath)) return [];

  let viaGit: string[] | null = null;
  try {
    const res = await execCommand("git", ["ls-files", "-z", "-co", "--exclude-standard"], {
      cwd: worktreePath,
      timeoutMs: 15_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (res.exitCode === 0 && !res.truncated) {
      const entries = res.stdout.split("\0").filter((entry) => entry.length > 0);
      if (entries.length > 0) viaGit = entries;
    }
  } catch {
    // git missing or failed; fall through to the pruning walker.
  }

  if (viaGit !== null) {
    const known: string[] = [];
    for (const rel of viaGit) {
      const normalized = rel.replace(/\\/g, "/");
      if (isIgnoredSeamPath(normalized)) continue;
      const full = path.join(worktreePath, normalized);
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      known.push(normalized);
    }
    return known;
  }

  return walkSeamFiles(worktreePath);
}

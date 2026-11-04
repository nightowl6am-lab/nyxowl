import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the shipped package.json version from the current module location.
 *
 * Candidate relative paths cover:
 * - `src/core/version.ts` (source tree, two levels below package root)
 * - `dist/cli/*.js` (two levels below package root)
 * - `dist/*.js` shared chunks (one level below package root)
 */
function resolvePackageVersion(): string {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = ["../package.json", "../../package.json", "../../../package.json"];

    for (const candidate of candidates) {
      const packageJsonPath = path.resolve(moduleDir, candidate);
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }

      const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        typeof parsed.version === "string" &&
        parsed.version.length > 0
      ) {
        return parsed.version;
      }
    }
  } catch {
    // Fall through to the defensive fallback below.
  }

  return "0.0.0";
}

export const NYXOWL_VERSION: string = resolvePackageVersion();

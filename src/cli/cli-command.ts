import fs from "node:fs";
import path from "node:path";
import { resolvePackageRoot } from "./skills.ts";

export function resolveNyxowlCliCommand(pkgRoot = resolvePackageRoot()): {
  command: string;
  args: string[];
  shellHookPrefix: string;
} {
  const distEntry = path.join(pkgRoot, "dist", "cli", "index.js");
  const srcEntry = path.join(pkgRoot, "src", "cli", "index.ts");
  const entry = fs.existsSync(distEntry) ? distEntry : srcEntry;
  return {
    command: process.execPath,
    args: [entry],
    shellHookPrefix: `"${process.execPath}" "${entry}"`,
  };
}

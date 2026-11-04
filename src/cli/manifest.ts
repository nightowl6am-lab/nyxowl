import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as jsonc from "jsonc-parser";
import * as smolToml from "smol-toml";
import { resolveGlobalNyxowlPaths } from "../core/paths.ts";

export interface ManifestEntry {
  targetPath: string;
  kind: "created-file" | "created-dir" | "modified-file";
  backupPath?: string;
  originalSha256?: string;
  writtenSha256?: string;
  host?: string;
  updatedAt: string;
}

export interface InstallManifest {
  version: 1;
  nyxowlVersion: string;
  installedAt: string;
  updatedAt: string;
  entries: ManifestEntry[];
}

export const MANAGED_BEGIN = "<!-- nyxowl:begin -->";
export const MANAGED_END = "<!-- nyxowl:end -->";

function sha256Buffer(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function loadInstallManifest(nyxowlHome?: string): InstallManifest {
  const paths = resolveGlobalNyxowlPaths(nyxowlHome);
  if (!fs.existsSync(paths.installManifestFile)) {
    const now = new Date().toISOString();
    return {
      version: 1,
      nyxowlVersion: "0.1.0",
      installedAt: now,
      updatedAt: now,
      entries: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(paths.installManifestFile, "utf8")) as InstallManifest;
  } catch {
    const now = new Date().toISOString();
    return {
      version: 1,
      nyxowlVersion: "0.1.0",
      installedAt: now,
      updatedAt: now,
      entries: [],
    };
  }
}

export function saveInstallManifest(manifest: InstallManifest, nyxowlHome?: string): void {
  const paths = resolveGlobalNyxowlPaths(nyxowlHome);
  fs.mkdirSync(path.dirname(paths.installManifestFile), { recursive: true, mode: 0o700 });
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(paths.installManifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function recordManifestEntry(
  entry: Omit<ManifestEntry, "updatedAt">,
  nyxowlHome?: string,
): void {
  const manifest = loadInstallManifest(nyxowlHome);
  const absTarget = path.resolve(entry.targetPath);
  const existingIdx = manifest.entries.findIndex(
    (e) => path.resolve(e.targetPath) === absTarget,
  );
  const now = new Date().toISOString();

  if (existingIdx >= 0) {
    const prev = manifest.entries[existingIdx]!;
    manifest.entries[existingIdx] = {
      ...prev,
      ...entry,
      targetPath: absTarget,
      // Preserve original backupPath and originalSha256 across idempotent re-runs!
      ...(prev.backupPath ? { backupPath: prev.backupPath } : {}),
      ...(prev.originalSha256 ? { originalSha256: prev.originalSha256 } : {}),
      updatedAt: now,
    };
  } else {
    manifest.entries.push({
      ...entry,
      targetPath: absTarget,
      updatedAt: now,
    });
  }
  saveInstallManifest(manifest, nyxowlHome);
}

function createBackupForUserFile(targetPath: string, nyxowlHome?: string): {
  backupPath: string;
  originalSha256: string;
} {
  const paths = resolveGlobalNyxowlPaths(nyxowlHome);
  const backupsDir = path.join(paths.homeDir, "backups");
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

  // Check if we already have an initial backup in the manifest
  const manifest = loadInstallManifest(nyxowlHome);
  const absTarget = path.resolve(targetPath);
  const existing = manifest.entries.find((e) => path.resolve(e.targetPath) === absTarget);
  if (existing?.backupPath && existing.originalSha256 && fs.existsSync(existing.backupPath)) {
    return {
      backupPath: existing.backupPath,
      originalSha256: existing.originalSha256,
    };
  }

  const rawBuf = fs.readFileSync(absTarget);
  const originalSha256 = sha256Buffer(rawBuf);
  const safeName = absTarget.replace(/[^a-zA-Z0-9._-]/g, "_");
  const backupPath = path.join(backupsDir, `${safeName}.${Date.now()}.bak`);
  fs.writeFileSync(backupPath, rawBuf, { mode: 0o600 });
  return { backupPath, originalSha256 };
}

/**
 * Writes a dedicated Nyxowl-owned file and records it in the manifest if outside ~/.nyxowl.
 */
export function writeTrackedFile(options: {
  targetPath: string;
  content: string;
  host?: string;
  nyxowlHome?: string;
  mode?: number;
}): void {
  const absTarget = path.resolve(options.targetPath);
  const paths = resolveGlobalNyxowlPaths(options.nyxowlHome);
  const insideNyxowlHome = absTarget.startsWith(paths.homeDir + path.sep);

  fs.mkdirSync(path.dirname(absTarget), { recursive: true });

  // Idempotency check: if file already has identical content, do not rewrite
  if (fs.existsSync(absTarget)) {
    const current = fs.readFileSync(absTarget, "utf8");
    if (current === options.content) {
      return;
    }
  }

  const existedBefore = fs.existsSync(absTarget);
  let backupInfo: { backupPath: string; originalSha256: string } | undefined;
  if (existedBefore && !insideNyxowlHome) {
    backupInfo = createBackupForUserFile(absTarget, options.nyxowlHome);
  }

  fs.writeFileSync(absTarget, options.content, {
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });

  if (!insideNyxowlHome) {
    const writtenSha256 = sha256Buffer(options.content);
    recordManifestEntry(
      {
        targetPath: absTarget,
        kind: existedBefore ? "modified-file" : "created-file",
        ...(backupInfo ? backupInfo : {}),
        writtenSha256,
        ...(options.host ? { host: options.host } : {}),
      },
      options.nyxowlHome,
    );
  }
}

/**
 * Updates or inserts a `<!-- nyxowl:begin --> ... <!-- nyxowl:end -->` managed block in a Markdown/text file.
 * Preserves all surrounding user content and is 100% idempotent.
 */
export function upsertManagedBlockFile(options: {
  targetPath: string;
  blockBody: string;
  host?: string;
  nyxowlHome?: string;
}): void {
  const absTarget = path.resolve(options.targetPath);
  const paths = resolveGlobalNyxowlPaths(options.nyxowlHome);
  const insideNyxowlHome = absTarget.startsWith(paths.homeDir + path.sep);

  const normalizedBlock = options.blockBody.trim().startsWith(MANAGED_BEGIN)
    ? options.blockBody.trim()
    : `${MANAGED_BEGIN}\n${options.blockBody.trim()}\n${MANAGED_END}`;

  if (!fs.existsSync(absTarget)) {
    fs.mkdirSync(path.dirname(absTarget), { recursive: true });
    const content = `${normalizedBlock}\n`;
    fs.writeFileSync(absTarget, content, "utf8");
    if (!insideNyxowlHome) {
      recordManifestEntry(
        {
          targetPath: absTarget,
          kind: "created-file",
          writtenSha256: sha256Buffer(content),
          ...(options.host ? { host: options.host } : {}),
        },
        options.nyxowlHome,
      );
    }
    return;
  }

  const existing = fs.readFileSync(absTarget, "utf8");
  const blockRegex = new RegExp(
    `${MANAGED_BEGIN}[\\s\\S]*?${MANAGED_END}`,
    "m",
  );

  let updated: string;
  if (blockRegex.test(existing)) {
    updated = existing.replace(blockRegex, normalizedBlock);
  } else {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    updated = `${existing}${sep}${normalizedBlock}\n`;
  }

  if (updated === existing) {
    return; // Idempotent no-op
  }

  const backupInfo = !insideNyxowlHome
    ? createBackupForUserFile(absTarget, options.nyxowlHome)
    : undefined;

  fs.writeFileSync(absTarget, updated, "utf8");
  if (!insideNyxowlHome) {
    recordManifestEntry(
      {
        targetPath: absTarget,
        kind: "modified-file",
        ...(backupInfo ? backupInfo : {}),
        writtenSha256: sha256Buffer(updated),
        ...(options.host ? { host: options.host } : {}),
      },
      options.nyxowlHome,
    );
  }
}

/**
 * Comment-preserving JSON/JSONC property upsert using `jsonc-parser`.
 */
export function upsertJsoncPropertyFile(options: {
  targetPath: string;
  jsonPath: jsonc.JSONPath;
  value: unknown;
  host?: string;
  nyxowlHome?: string;
}): void {
  const absTarget = path.resolve(options.targetPath);
  const paths = resolveGlobalNyxowlPaths(options.nyxowlHome);
  const insideNyxowlHome = absTarget.startsWith(paths.homeDir + path.sep);

  const existedBefore = fs.existsSync(absTarget);
  const existingText = existedBefore ? fs.readFileSync(absTarget, "utf8") : "{\n}\n";

  const edits = jsonc.modify(existingText, options.jsonPath, options.value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const updatedText = jsonc.applyEdits(existingText, edits);

  if (existedBefore && updatedText === existingText) {
    return; // Idempotent no-op
  }

  const backupInfo =
    existedBefore && !insideNyxowlHome
      ? createBackupForUserFile(absTarget, options.nyxowlHome)
      : undefined;

  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  fs.writeFileSync(absTarget, updatedText, "utf8");

  if (!insideNyxowlHome) {
    recordManifestEntry(
      {
        targetPath: absTarget,
        kind: existedBefore ? "modified-file" : "created-file",
        ...(backupInfo ? backupInfo : {}),
        writtenSha256: sha256Buffer(updatedText),
        ...(options.host ? { host: options.host } : {}),
      },
      options.nyxowlHome,
    );
  }
}

/**
 * Merges a key path into a TOML file using `smol-toml` while recording backups in the manifest.
 */
export function upsertTomlSectionFile(options: {
  targetPath: string;
  sectionKey: string;
  subKey: string;
  value: Record<string, unknown>;
  host?: string;
  nyxowlHome?: string;
}): void {
  const absTarget = path.resolve(options.targetPath);
  const paths = resolveGlobalNyxowlPaths(options.nyxowlHome);
  const insideNyxowlHome = absTarget.startsWith(paths.homeDir + path.sep);

  const existedBefore = fs.existsSync(absTarget);
  const existingText = existedBefore ? fs.readFileSync(absTarget, "utf8") : "";
  const parsed = existingText.trim()
    ? (smolToml.parse(existingText) as Record<string, unknown>)
    : {};

  const section =
    typeof parsed[options.sectionKey] === "object" && parsed[options.sectionKey] !== null
      ? (parsed[options.sectionKey] as Record<string, unknown>)
      : {};
  section[options.subKey] = options.value;
  parsed[options.sectionKey] = section;

  const updatedText = `${smolToml.stringify(parsed).trim()}\n`;
  if (existedBefore && updatedText === existingText) {
    return;
  }

  const backupInfo =
    existedBefore && !insideNyxowlHome
      ? createBackupForUserFile(absTarget, options.nyxowlHome)
      : undefined;

  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  fs.writeFileSync(absTarget, updatedText, "utf8");

  if (!insideNyxowlHome) {
    recordManifestEntry(
      {
        targetPath: absTarget,
        kind: existedBefore ? "modified-file" : "created-file",
        ...(backupInfo ? backupInfo : {}),
        writtenSha256: sha256Buffer(updatedText),
        ...(options.host ? { host: options.host } : {}),
      },
      options.nyxowlHome,
    );
  }
}

/**
 * Restores all modified user files byte-identically from backups (or strips Nyxowl keys/blocks if user edited after install)
 * and removes all created files recorded in `install-manifest.json`.
 */
export function uninstallFromManifest(options?: {
  nyxowlHome?: string;
  purge?: boolean;
}): {
  restoredFiles: string[];
  deletedFiles: string[];
  skippedUserEditedFiles: string[];
  purgedHome: boolean;
} {
  const paths = resolveGlobalNyxowlPaths(options?.nyxowlHome);
  const manifest = loadInstallManifest(options?.nyxowlHome);
  const restoredFiles: string[] = [];
  const deletedFiles: string[] = [];
  const skippedUserEditedFiles: string[] = [];

  for (const entry of [...manifest.entries].reverse()) {
    const absTarget = path.resolve(entry.targetPath);
    if (!fs.existsSync(absTarget)) continue;

    if (entry.kind === "created-file") {
      fs.rmSync(absTarget, { force: true });
      deletedFiles.push(absTarget);
    } else if (entry.kind === "created-dir") {
      fs.rmSync(absTarget, { recursive: true, force: true });
      deletedFiles.push(absTarget);
    } else if (entry.kind === "modified-file") {
      const currentBuf = fs.readFileSync(absTarget);
      const currentSha = sha256Buffer(currentBuf);

      // If the file hasn't been touched since Nyxowl wrote it, restore byte-identical backup!
      if (
        entry.backupPath &&
        fs.existsSync(entry.backupPath) &&
        (!entry.writtenSha256 || currentSha === entry.writtenSha256)
      ) {
        const backupBuf = fs.readFileSync(entry.backupPath);
        fs.writeFileSync(absTarget, backupBuf);
        restoredFiles.push(absTarget);
      } else {
        // User edited the file after Nyxowl wrote it: strip only the managed block or JSONC nyxowl key so user edits survive!
        const text = currentBuf.toString("utf8");
        if (text.includes(MANAGED_BEGIN) && text.includes(MANAGED_END)) {
          const blockRegex = new RegExp(
            `\\n?${MANAGED_BEGIN}[\\s\\S]*?${MANAGED_END}\\n?`,
            "m",
          );
          fs.writeFileSync(absTarget, text.replace(blockRegex, "\n"), "utf8");
          restoredFiles.push(absTarget);
        } else if (absTarget.endsWith(".json") || absTarget.endsWith(".jsonc")) {
          const edits = jsonc.modify(text, ["mcpServers", "nyxowl"], undefined, {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
          });
          fs.writeFileSync(absTarget, jsonc.applyEdits(text, edits), "utf8");
          restoredFiles.push(absTarget);
        } else {
          skippedUserEditedFiles.push(absTarget);
        }
      }
    }
  }

  manifest.entries = [];
  saveInstallManifest(manifest, options?.nyxowlHome);

  let purgedHome = false;
  if (options?.purge && fs.existsSync(paths.homeDir)) {
    fs.rmSync(paths.homeDir, { recursive: true, force: true });
    purgedHome = true;
  }

  return {
    restoredFiles,
    deletedFiles,
    skippedUserEditedFiles,
    purgedHome,
  };
}

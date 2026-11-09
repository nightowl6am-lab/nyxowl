import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsDir = path.join(repoRoot, "docs");

const SKIPPED_PREFIXES = ["http://", "https://", "mailto:"];

interface MarkdownLink {
  readonly source: string;
  readonly target: string;
}

function listDocsFiles(): string[] {
  return fs
    .readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(docsDir, entry.name))
    .sort();
}

function markdownFiles(): string[] {
  return [path.join(repoRoot, "README.md"), ...listDocsFiles()];
}

function extractLinks(source: string, contents: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  // `(?<!!)` excludes image links such as `![alt](image.png)`.
  const pattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contents)) !== null) {
    const rawTarget = match[1];
    if (rawTarget === undefined) {
      continue;
    }
    const target = rawTarget.trim().replace(/^<|>$/g, "");
    if (target.startsWith("#") || SKIPPED_PREFIXES.some((prefix) => target.startsWith(prefix))) {
      continue;
    }
    links.push({ source, target });
  }
  return links;
}

describe("documentation links", () => {
  it("keeps the user-facing updating guide present", () => {
    expect(fs.existsSync(path.join(docsDir, "updating.md"))).toBe(true);
  });

  it("resolves every relative Markdown link in README.md and docs/*.md", () => {
    const missing: string[] = [];

    for (const file of markdownFiles()) {
      const contents = fs.readFileSync(file, "utf8");
      for (const link of extractLinks(file, contents)) {
        const withoutFragment = link.target.split("#")[0] ?? "";
        const withoutQuery = withoutFragment.split("?")[0] ?? "";
        if (withoutQuery.length === 0) {
          continue;
        }
        const resolved = path.resolve(path.dirname(file), withoutQuery);
        if (!fs.existsSync(resolved)) {
          missing.push(`${path.relative(repoRoot, file)} -> ${link.target}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

describe("package publishing manifest", () => {
  const packageFile = path.join(repoRoot, "package.json");

  function readPublishedFiles(): string[] {
    const parsed: unknown = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("package.json must be a JSON object");
    }
    const files = (parsed as { files?: unknown }).files;
    if (!Array.isArray(files) || !files.every((entry): entry is string => typeof entry === "string")) {
      throw new Error('package.json "files" must be an array of strings');
    }
    return files;
  }

  it("ships the docs directory and the files linked from docs/updating.md", () => {
    const files = readPublishedFiles();
    // docs/updating.md links to ../CHANGELOG.md, so both must reach npm consumers.
    expect(files).toContain("docs");
    expect(files).toContain("CHANGELOG.md");
    expect(files).toContain("README.md");
  });

  it("does not ship the local readiness tracker or the .github directory", () => {
    const files = readPublishedFiles();
    expect(files).not.toContain("READINESS.md");
    expect(files).not.toContain(".github");
    expect(files).not.toContain(".github/");
    expect(files.filter((entry) => entry === ".github" || entry.startsWith(".github/"))).toEqual([]);
  });

  it("keeps the skills vendor script out of the published package", () => {
    const files = readPublishedFiles();
    expect(files.filter((entry) => entry === "scripts/skills" || entry.startsWith("scripts/skills/"))).toEqual(
      [],
    );
  });
});

describe("local readiness tracker", () => {
  it("stays gitignored so it is never committed or shipped", () => {
    const gitignoreLines = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8").split(/\r?\n/);
    expect(gitignoreLines).toContain("READINESS.md");
  });
});

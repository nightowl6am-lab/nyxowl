import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsDir = path.join(repoRoot, "docs");
const readinessFile = path.join(repoRoot, ".github", "READINESS.md");

const SKIPPED_PREFIXES = ["http://", "https://", "mailto:"];

interface MarkdownLink {
  readonly source: string;
  readonly target: string;
}

interface SliceRow {
  readonly id: number;
  readonly priority: string;
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

const TABLE_SEPARATOR = /^:?-+:?$/;

/**
 * Parses the Markdown table inside the `## Slices` section.
 * Rows are the pipe-delimited lines after the header and separator; each row
 * must supply a numeric ID and a priority cell.
 */
function parseSliceRows(contents: string): SliceRow[] {
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Slices");
  if (start === -1) {
    return [];
  }

  const tableLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    if (line.trim().startsWith("|")) {
      tableLines.push(line);
    } else if (tableLines.length > 0) {
      // Table ended; stop at the first non-table content after it.
      break;
    }
  }

  if (tableLines.length < 2) {
    return [];
  }

  const splitRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  // The first table line is the header, the second is the separator.
  const separator = splitRow(tableLines[1] ?? "");
  if (!separator.every((cell) => TABLE_SEPARATOR.test(cell))) {
    return [];
  }

  return tableLines.slice(2).map((line) => {
    const cells = splitRow(line);
    return {
      id: Number(cells[0] ?? Number.NaN),
      priority: cells[1] ?? "",
    };
  });
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

  it("does not ship the internal .github readiness tracker", () => {
    const files = readPublishedFiles();
    const internal = files.filter((entry) => entry === ".github" || entry.startsWith(".github/"));
    expect(internal).toEqual([]);
  });
});

describe("internal readiness tracker", () => {
  it("stays outside the shipped docs directory", () => {
    expect(fs.existsSync(readinessFile)).toBe(true);
    expect(fs.existsSync(path.join(docsDir, "readiness.md"))).toBe(false);
  });

  it("records the frozen 0/8 and 0/6 snapshots", () => {
    const contents = fs.readFileSync(readinessFile, "utf8");
    expect(contents).toContain("0/8 complete");
    expect(contents).toContain("0/6 P0 complete");
  });

  it("has exactly 8 slices with numeric IDs 1-8 and 6 P0 / 2 P1 priorities", () => {
    const contents = fs.readFileSync(readinessFile, "utf8");
    const rows = parseSliceRows(contents);

    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.filter((row) => row.priority === "P0")).toHaveLength(6);
    expect(rows.filter((row) => row.priority === "P1")).toHaveLength(2);
  });
});

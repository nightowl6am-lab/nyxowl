import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { execCommand } from "../../../core/exec.ts";
import { getGitCommonDir, getHeadCommitHash } from "../../../core/git.ts";
import { isSecretEnvFileName } from "../../../core/redact.ts";
import { NYXOWL_VERSION } from "../../../core/version.ts";
import { defineTool } from "../../tool.ts";
import { scanContentForSecrets } from "../worktree-slice/secret-scan.ts";

const BASE_SECRET_GITIGNORE_LINES = [
  "# Nyxowl Secret & Environment Protection",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "!.env.defaults",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*credentials*.json",
  ".nyxowl/",
  "node_modules/",
  "dist/",
  "coverage/",
  "__pycache__/",
  ".venv/",
  "target/",
];

const MAX_ADOPT_FILE_BYTES = 50 * 1024 * 1024; // 50 MB (§1.6)

async function ensureGitUserConfig(repoDir: string): Promise<void> {
  const emailRes = await execCommand("git", ["config", "user.email"], { cwd: repoDir });
  if (!emailRes.stdout.trim()) {
    await execCommand("git", ["config", "user.email", "nyxowl@users.noreply.github.com"], {
      cwd: repoDir,
    });
  }
  const nameRes = await execCommand("git", ["config", "user.name"], { cwd: repoDir });
  if (!nameRes.stdout.trim()) {
    await execCommand("git", ["config", "user.name", "Nyxowl"], { cwd: repoDir });
  }
}

function walkFilesForAdoptScan(
  rootDir: string,
  currentDir = rootDir,
  acc: string[] = [],
): string[] {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === ".venv" ||
      entry.name === "target" ||
      entry.name === ".nyxowl"
    ) {
      continue;
    }
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFilesForAdoptScan(rootDir, full, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(rootDir, full));
    }
  }
  return acc;
}

function scaffoldGreenfieldProject(
  projectPath: string,
  stackSpec: "ts-node" | "python" | "go" | "rust",
  projectName: string,
): string[] {
  const filesCreated: string[] = [];
  const write = (relPath: string, content: string): void => {
    const full = path.join(projectPath, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    filesCreated.push(relPath);
  };

  write(".gitignore", BASE_SECRET_GITIGNORE_LINES.join("\n") + "\n");
  write(".env.example", "# Example Environment Configuration\nPORT=3000\n");

  if (stackSpec === "ts-node") {
    write(
      "package.json",
      JSON.stringify(
        {
          name: projectName,
          version: "0.1.0",
          type: "module",
          scripts: {
            test: "node --test tests/*.test.mjs",
            lint: "node -e \"process.stdout.write('lint ok\\n')\"",
            typecheck: "node -e \"process.stdout.write('typecheck ok\\n')\"",
            build: "node -e \"process.stdout.write('build ok\\n')\"",
          },
        },
        null,
        2,
      ) + "\n",
    );
    write(
      "src/index.mjs",
      `export function greet(name = "world") {\n  return \`Hello, \${name}!\`;\n}\n`,
    );
    write(
      "tests/index.test.mjs",
      `import assert from "node:assert/strict";\nimport { describe, it } from "node:test";\nimport { greet } from "../src/index.mjs";\n\ndescribe("${projectName}", () => {\n  it("greets properly", () => {\n    assert.equal(greet("Nyxowl"), "Hello, Nyxowl!");\n  });\n});\n`,
    );
  } else if (stackSpec === "python") {
    write(
      "pyproject.toml",
      `[project]\nname = "${projectName}"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n`,
    );
    write("src/__init__.py", "");
    write("src/app.py", `def add(a: int, b: int) -> int:\n    return a + b\n`);
    write(
      "tests/test_app.py",
      `from src.app import add\n\ndef test_add() -> None:\n    assert add(2, 3) == 5\n`,
    );
  } else if (stackSpec === "go") {
    write("go.mod", `module example.com/${projectName}\n\ngo 1.22\n`);
    write("main.go", `package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n\nfunc main() {}\n`);
    write(
      "main_test.go",
      `package main\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("expected 5")\n\t}\n}\n`,
    );
  } else if (stackSpec === "rust") {
    write(
      "Cargo.toml",
      `[package]\nname = "${projectName}"\nversion = "0.1.0"\nedition = "2021"\n`,
    );
    write(
      "src/lib.rs",
      `pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn it_works() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n`,
    );
  }

  return filesCreated;
}

export const projectBootstrapInputSchema = z.object({
  projectPath: z.string().min(1),
  mode: z.enum(["greenfield", "adopt"]),
  stackSpec: z.enum(["ts-node", "python", "go", "rust"]).optional(),
  projectName: z.string().optional(),
   createInitialWorktree: z.boolean().optional(),
  taskSlug: z.string().optional(),
});

export const projectBootstrapOutputSchema = z.object({
  mode: z.enum(["greenfield", "adopt"]),
  projectPath: z.string(),
  baselineCommitSha: z.string(),
  filesCreated: z.array(z.string()),
  ignoredSecretFiles: z.array(z.string()),
  ignoredLargeFiles: z.array(z.string()),
  worktreePath: z.string().nullable(),
});

export const nyxProjectBootstrapTool = defineTool({
  name: "nyx_project_bootstrap",
  description: "Bootstraps an empty folder (greenfield) or adopts an unversioned folder with secret/large-file guards.",
  annotations: {
    title: "Project Bootstrap (Greenfield & Adopt)",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: projectBootstrapInputSchema,
  outputSchema: projectBootstrapOutputSchema,
  handler: async (input, ctx) => {
    const absProject = path.resolve(input.projectPath);
    fs.mkdirSync(absProject, { recursive: true });

    const existingGit = await getGitCommonDir(absProject);
    if (existingGit) {
      throw new NyxError(
        "ERR_ALREADY_GIT_REPO",
        `Path "${absProject}" is already a git repository.`,
      );
    }

    const entries = fs
      .readdirSync(absProject)
      .filter((e) => e !== "." && e !== ".." && e !== ".DS_Store");

    if (input.mode === "greenfield") {
      if (entries.length > 0) {
        throw new NyxError(
          "ERR_FOLDER_NOT_EMPTY",
          `Greenfield mode requires an empty directory, but "${absProject}" contains ${entries.length} item(s). Use mode: "adopt" instead.`,
        );
      }

      const stackSpec = input.stackSpec ?? "ts-node";
      const projectName =
        input.projectName ??
        (path
          .basename(absProject)
          .toLowerCase()
          .replace(/[^a-z0-9-_]+/g, "-") || "nyx-app");

      const filesCreated = scaffoldGreenfieldProject(absProject, stackSpec, projectName);

      await execCommand("git", ["init", "-b", "main"], {
        cwd: absProject,
        throwOnNonZero: true,
      });
      await ensureGitUserConfig(absProject);
      await execCommand("git", ["add", "-A"], { cwd: absProject, throwOnNonZero: true });

      const trailer =
        ctx.config.github.attribution === "none"
          ? ""
          : `\n\nAssisted-by: Nyxowl v${NYXOWL_VERSION}`;
      await execCommand(
        "git",
        ["commit", "-m", `chore: initial greenfield scaffold (nyxowl)${trailer}`],
        { cwd: absProject, throwOnNonZero: true },
      );

      const baselineCommitSha = await getHeadCommitHash(absProject);

      let worktreePath: string | null = null;
      if (input.createInitialWorktree) {
        const slug = input.taskSlug ?? "initial-slice";
        const wtDir = path.join(ctx.projectLayout.externalWorktreeRoot, slug);
        fs.mkdirSync(path.dirname(wtDir), { recursive: true, mode: 0o700 });
        await execCommand("git", ["worktree", "add", "-b", `nyx/${slug}`, wtDir, "HEAD"], {
          cwd: absProject,
          throwOnNonZero: true,
        });
        worktreePath = wtDir;
      }

      return {
        mode: "greenfield" as const,
        projectPath: absProject,
        baselineCommitSha,
        filesCreated,
        ignoredSecretFiles: [],
        ignoredLargeFiles: [],
        worktreePath,
      };
    }

    // mode === "adopt" (§1.6)
    const ignoredSecretFiles: string[] = [];
    const ignoredLargeFiles: string[] = [];

    const candidateFiles = walkFilesForAdoptScan(absProject);
    for (const relFile of candidateFiles) {
      const fullPath = path.join(absProject, relFile);
      const baseName = path.basename(relFile);

      if (isSecretEnvFileName(baseName) || /\.(?:pem|key|p12|pfx)$/i.test(baseName)) {
        ignoredSecretFiles.push(relFile);
        continue;
      }

      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_ADOPT_FILE_BYTES) {
        ignoredLargeFiles.push(relFile);
        continue;
      }

      // Scan text files <= 2 MB for embedded secrets
      if (stat.size <= 2 * 1024 * 1024) {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const findings = scanContentForSecrets(content, relFile);
          if (findings.length > 0) {
            ignoredSecretFiles.push(relFile);
          }
        } catch {
          // Ignore binary files
        }
      }
    }

    // 1. Write .gitignore FIRST (secret patterns + stack ignores + offending files)
    const gitignorePath = path.join(absProject, ".gitignore");
    const existingIgnore = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, "utf8")
      : "";
    const existingLines = new Set(
      existingIgnore
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    );

    const linesToAdd: string[] = [];
    for (const line of BASE_SECRET_GITIGNORE_LINES) {
      if (!existingLines.has(line)) {
        linesToAdd.push(line);
      }
    }
    for (const secFile of ignoredSecretFiles) {
      if (!existingLines.has(secFile)) {
        linesToAdd.push(secFile);
      }
    }
    for (const largeFile of ignoredLargeFiles) {
      if (!existingLines.has(largeFile)) {
        linesToAdd.push(largeFile);
      }
    }

    const updatedIgnore =
      (existingIgnore ? existingIgnore.trimEnd() + "\n\n" : "") + linesToAdd.join("\n") + "\n";
    fs.writeFileSync(gitignorePath, updatedIgnore, "utf8");

    // 2. git init and baseline commit
    await execCommand("git", ["init", "-b", "main"], {
      cwd: absProject,
      throwOnNonZero: true,
    });
    await ensureGitUserConfig(absProject);
    await execCommand("git", ["add", "-A"], { cwd: absProject, throwOnNonZero: true });

    const trailer =
      ctx.config.github.attribution === "none"
        ? ""
        : `\n\nAssisted-by: Nyxowl v${NYXOWL_VERSION}`;
    await execCommand(
      "git",
      ["commit", "--allow-empty", "-m", `chore: baseline (nyxowl adopt)${trailer}`],
      { cwd: absProject, throwOnNonZero: true },
    );

    const baselineCommitSha = await getHeadCommitHash(absProject);

    return {
      mode: "adopt" as const,
      projectPath: absProject,
      baselineCommitSha,
      filesCreated: [".gitignore"],
      ignoredSecretFiles,
      ignoredLargeFiles,
      worktreePath: null,
    };
  },
});

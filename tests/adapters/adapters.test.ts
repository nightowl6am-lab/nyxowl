import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import { generateAntigravityHostPackage } from "../../src/cli/adapters/antigravity.ts";
import {
  buildClaudeSessionSettings,
  evaluateClaudePermissionPrecedence,
  generateClaudeHostPackage,
} from "../../src/cli/adapters/claude.ts";
import { generateCodexHostPackage } from "../../src/cli/adapters/codex.ts";
import { generateCursorHostPackage } from "../../src/cli/adapters/cursor.ts";
import { generateGeminiHostPackage } from "../../src/cli/adapters/gemini.ts";
import {
  buildOpenCodePermissions,
  evaluateOpenCodeLastMatchPermission,
  generateOpenCodeHostPackage,
} from "../../src/cli/adapters/opencode.ts";
import { generateWindsurfHostPackage } from "../../src/cli/adapters/windsurf.ts";
import { uninstallFromManifest } from "../../src/cli/manifest.ts";

describe("Step 9 — Host Adapters, Permission Precedence & Manifest Uninstall", () => {
  let tmpRoot: string;
  let nyxowlHome: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-adapters-test-"));
    nyxowlHome = path.join(tmpRoot, "nyxowl-home");
    projectDir = path.join(tmpRoot, "sample-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Sample\n");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("Claude Code golden permission precedence: denies .env and .env.*, allows .env.example, asks on red-lines (§1.2.1)", () => {
    const settings = buildClaudeSessionSettings({
      worktreeRoot: "/tmp/worktrees",
    }) as {
      permissions: { deny: string[]; ask: string[]; allow: string[] };
    };

    expect(evaluateClaudePermissionPrecedence(settings, "Read(.env)")).toBe("deny");
    expect(evaluateClaudePermissionPrecedence(settings, "Read(apps/api/.env)")).toBe("deny");
    expect(evaluateClaudePermissionPrecedence(settings, "Read(.env.local)")).toBe("deny");
    expect(evaluateClaudePermissionPrecedence(settings, "Read(apps/web/.env.production)")).toBe(
      "deny",
    );
    expect(evaluateClaudePermissionPrecedence(settings, "Edit(.env.local)")).toBe("deny");
    expect(evaluateClaudePermissionPrecedence(settings, "Read(certs/server.pem)")).toBe("deny");

    // .env.example, .env.sample, .env.template must be ALLOWED
    expect(evaluateClaudePermissionPrecedence(settings, "Read(.env.example)")).toBe("allow");
    expect(evaluateClaudePermissionPrecedence(settings, "Read(apps/api/.env.example)")).toBe(
      "allow",
    );
    expect(evaluateClaudePermissionPrecedence(settings, "Read(.env.sample)")).toBe("allow");
    expect(evaluateClaudePermissionPrecedence(settings, "Read(.env.template)")).toBe("allow");

    // Red lines must trigger `ask`
    expect(evaluateClaudePermissionPrecedence(settings, "Bash(gh pr merge 12)")).toBe("ask");
    expect(evaluateClaudePermissionPrecedence(settings, "Edit(.github/workflows/ci.yml)")).toBe(
      "ask",
    );
  });

  it("OpenCode golden last-match-wins permission ordering: .env* denied, .env.example allowed after denies (§1.2.1)", () => {
    const perms = buildOpenCodePermissions("/tmp/worktrees");

    expect(evaluateOpenCodeLastMatchPermission(perms.read, ".env")).toBe("deny");
    expect(evaluateOpenCodeLastMatchPermission(perms.read, ".env.local")).toBe("deny");
    expect(evaluateOpenCodeLastMatchPermission(perms.read, "packages/db/.env.production")).toBe(
      "deny",
    );
    expect(evaluateOpenCodeLastMatchPermission(perms.read, "secrets/private.key")).toBe("deny");

    // Because .env.example/.env.sample/.env.template appear AFTER .env* in perms.read, last-match wins -> allow!
    expect(evaluateOpenCodeLastMatchPermission(perms.read, ".env.example")).toBe("allow");
    expect(evaluateOpenCodeLastMatchPermission(perms.read, "packages/db/.env.example")).toBe(
      "allow",
    );
    expect(evaluateOpenCodeLastMatchPermission(perms.read, ".env.sample")).toBe("allow");
    expect(evaluateOpenCodeLastMatchPermission(perms.read, ".env.template")).toBe("allow");
  });

  it("generates all 7 host packages idempotently with zero project footprint and passes agy plugin validate --strict", async () => {
    const beforeProjectFiles = fs.readdirSync(projectDir);

    const claudePkg = generateClaudeHostPackage({ nyxowlHome, projectPath: projectDir });
    const opencodePkg = generateOpenCodeHostPackage({ nyxowlHome, projectPath: projectDir });
    const codexPkg = generateCodexHostPackage({ nyxowlHome, projectPath: projectDir });
    const geminiPkg = generateGeminiHostPackage({ nyxowlHome, projectPath: projectDir });
    const agyPkg = generateAntigravityHostPackage({ nyxowlHome, projectPath: projectDir });

    expect(fs.existsSync(claudePkg.settingsPath)).toBe(true);
    expect(fs.existsSync(opencodePkg.configPath)).toBe(true);
    expect(fs.existsSync(codexPkg.configTomlPath)).toBe(true);
    expect(fs.existsSync(geminiPkg.extensionManifestPath)).toBe(true);
    expect(fs.existsSync(agyPkg.settingsPath)).toBe(true);

    // Verify zero project footprint
    const afterProjectFiles = fs.readdirSync(projectDir);
    expect(afterProjectFiles).toEqual(beforeProjectFiles);

    // Live validation against `agy plugin validate --strict --json` if `agy` is installed
    const agyBin = "/home/nightowl/.local/bin/agy";
    if (fs.existsSync(agyBin)) {
      const valRes = await execCommand(
        agyBin,
        ["plugin", "validate", agyPkg.pluginDir, "--strict", "--json"],
        { timeoutMs: 5000 },
      );
      expect(valRes.exitCode).toBe(0);
      const parsed = JSON.parse(valRes.stdout) as {
        name: string;
        components: { agents: number; hooks: number; mcpServers: number; skills: number };
        findings: unknown[];
      };
      expect(parsed.name).toBe("nyxowl");
      expect(parsed.components.agents).toBe(10);
      expect(parsed.components.hooks).toBe(1);
      expect(parsed.components.mcpServers).toBe(1);
      expect(parsed.findings).toEqual([]);
    }
  });

  it("preserves user JSONC comments and restores byte-identical user files on uninstall", () => {
    const userCursorDir = path.join(tmpRoot, "user-cursor");
    const userWindsurfDir = path.join(tmpRoot, "user-windsurf");
    const userCodexDir = path.join(tmpRoot, "user-codex");
    fs.mkdirSync(userCursorDir, { recursive: true });
    fs.mkdirSync(path.join(userWindsurfDir, "memories"), { recursive: true });
    fs.mkdirSync(userCodexDir, { recursive: true });

    const initialCursorMcp = [
      "{",
      "  // User custom comment that must be preserved",
      '  "mcpServers": {',
      '    "existing-server": {',
      '      "command": "node",',
      '      "args": ["server.js"]',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const cursorMcpPath = path.join(userCursorDir, "mcp.json");
    fs.writeFileSync(cursorMcpPath, initialCursorMcp, "utf8");

    const initialWindsurfRules = "# My Custom Windsurf Rules\n- Keep functions pure.\n";
    const windsurfRulesPath = path.join(userWindsurfDir, "memories", "global_rules.md");
    fs.writeFileSync(windsurfRulesPath, initialWindsurfRules, "utf8");

    // Run Cursor, Windsurf, and Codex user-level installs twice (idempotency check)
    generateCursorHostPackage({ nyxowlHome, userCursorDir, projectPath: projectDir });
    const afterFirstCursor = fs.readFileSync(cursorMcpPath, "utf8");
    expect(afterFirstCursor).toContain("// User custom comment that must be preserved");
    expect(afterFirstCursor).toContain('"nyxowl"');

    generateCursorHostPackage({ nyxowlHome, userCursorDir, projectPath: projectDir });
    const afterSecondCursor = fs.readFileSync(cursorMcpPath, "utf8");
    expect(afterSecondCursor).toBe(afterFirstCursor);

    generateWindsurfHostPackage({ nyxowlHome, userWindsurfDir, projectPath: projectDir });
    generateCodexHostPackage({
      nyxowlHome,
      userCodexHome: userCodexDir,
      writeUserFallbackBlock: true,
      projectPath: projectDir,
    });

    // Now run uninstallFromManifest({ purge: true }) and verify byte-identical restoration!
    const uninstallRes = uninstallFromManifest({ nyxowlHome, purge: true });
    expect(uninstallRes.purgedHome).toBe(true);
    expect(fs.existsSync(nyxowlHome)).toBe(false);

    expect(fs.readFileSync(cursorMcpPath, "utf8")).toBe(initialCursorMcp);
    expect(fs.readFileSync(windsurfRulesPath, "utf8")).toBe(initialWindsurfRules);
    expect(fs.existsSync(path.join(userCursorDir, "rules", "nyxowl.mdc"))).toBe(false);
    expect(fs.existsSync(path.join(userCodexDir, "AGENTS.md"))).toBe(false);
  });
});

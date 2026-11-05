import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
import {
  buildOpenCodePermissions,
  generateOpenCodeHostPackage,
} from "../../src/cli/adapters/opencode.ts";
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

  it("OpenCode v2 last-match-wins permission ordering: .env* denied, .env.example allowed after denies (§1.2.1)", () => {
    const perms = buildOpenCodePermissions("/tmp/worktrees");

    expect(perms.every((rule) => ["allow", "deny", "ask"].includes(rule.effect))).toBe(true);
    const envDenyIndex = perms.findIndex(
      (rule) => rule.action === "read" && rule.resource === ".env*" && rule.effect === "deny",
    );
    const envAllowIndex = perms.findIndex(
      (rule) => rule.action === "read" && rule.resource === ".env.example" && rule.effect === "allow",
    );
    expect(envDenyIndex).toBeGreaterThanOrEqual(0);
    expect(envAllowIndex).toBeGreaterThan(envDenyIndex);

    const readDenies = perms.filter((rule) => rule.action === "read" && rule.effect === "deny");
    expect(readDenies.map((rule) => rule.resource)).toContain("**/.env*");
    expect(readDenies.map((rule) => rule.resource)).toContain("~/.nyxowl/secrets/**");

    expect(
      perms.some(
        (rule) => rule.action === "shell" && rule.resource === "git push --force*" && rule.effect === "ask",
      ),
    ).toBe(true);
    expect(perms.some((rule) => rule.action === "webfetch" && rule.effect === "deny")).toBe(true);
    expect(
      perms.some(
        (rule) =>
          rule.action === "external_directory" &&
          rule.resource === "/tmp/worktrees" &&
          rule.effect === "allow",
      ),
    ).toBe(true);
    expect(
      perms.some(
        (rule) =>
          rule.action === "external_directory" &&
          rule.resource === "/tmp/worktrees/**" &&
          rule.effect === "allow",
      ),
    ).toBe(true);
  });

  it("generates native OpenCode v2 config, inline agents, plugin directory, and launch args", async () => {
    const worktreeRoot = path.join(tmpRoot, "worktrees");
    const pkg = generateOpenCodeHostPackage({
      nyxowlHome,
      projectPath: projectDir,
      worktreeRoot,
    });
    const cfg = JSON.parse(fs.readFileSync(pkg.configPath, "utf8")) as {
      $schema: string;
      default_agent: string;
      mcp: Record<string, unknown> & {
        servers: {
          nyxowl: {
            type: string;
            command: string[];
            environment: Record<string, string>;
            enabled?: boolean;
            disabled?: boolean;
          };
        };
      };
      permissions: Array<{ action: string; resource: string; effect: string }>;
      agents: Record<
        string,
        { mode: string; description: string; system: string; permissions: unknown[]; prompt?: unknown }
      >;
      commands: Record<string, { description: string; template: string }>;
      plugins: string[];
      agent?: unknown;
      command?: unknown;
      permission?: unknown;
      plugin?: unknown;
    };

    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
    expect(cfg.default_agent).toBe("nyxowl");
    expect(Object.keys(cfg.mcp)).toEqual(["servers"]);
    expect(cfg.mcp.servers.nyxowl.type).toBe("local");
    expect(cfg.mcp.servers.nyxowl.command.slice(-1)).toEqual(["mcp"]);
    expect(cfg.mcp.servers.nyxowl.environment["NYXOWL_SESSION"]).toBe("1");
    expect(cfg.mcp.servers.nyxowl.enabled).toBeUndefined();
    expect(cfg.mcp.servers.nyxowl.disabled).toBeUndefined();
    expect(cfg.agent).toBeUndefined();
    expect(cfg.command).toBeUndefined();
    expect(cfg.permission).toBeUndefined();
    expect(cfg.plugin).toBeUndefined();

    expect(Array.isArray(cfg.permissions)).toBe(true);
    const envDenyIndex = cfg.permissions.findIndex(
      (rule) => rule.action === "read" && rule.resource === ".env*" && rule.effect === "deny",
    );
    const envAllowIndex = cfg.permissions.findIndex(
      (rule) =>
        rule.action === "read" && rule.resource === ".env.example" && rule.effect === "allow",
    );
    expect(envDenyIndex).toBeGreaterThanOrEqual(0);
    expect(envAllowIndex).toBeGreaterThan(envDenyIndex);

    expect(cfg.agents["nyxowl"]).toBeDefined();
    for (const agent of Object.values(cfg.agents)) {
      expect(typeof agent.system).toBe("string");
      expect(agent.system.length).toBeGreaterThan(0);
      expect(agent.prompt).toBeUndefined();
      expect(Array.isArray(agent.permissions)).toBe(true);
    }
    expect(cfg.agents["nyxowl"]?.permissions).toContainEqual({
      action: "webfetch",
      resource: "*",
      effect: "deny",
    });

    expect(cfg.commands).toBeTypeOf("object");
    expect(cfg.plugins).toEqual([pkg.pluginPath]);
    expect(pkg.pluginPath).toBe(path.join(nyxowlHome, "hosts", "opencode-plugin", "nyxowl"));
    expect(fs.statSync(pkg.pluginPath).isDirectory()).toBe(true);
    const pluginEntry = path.join(pkg.pluginPath, "index.js");
    expect(fs.existsSync(pluginEntry)).toBe(true);
    const pluginCode = fs.readFileSync(pluginEntry, "utf8");
    expect(pluginCode).not.toContain("@opencode/plugin");
    expect(pluginCode).toContain('ctx.permission.hook("evaluate"');
    expect(pluginCode).toContain('ctx.session.hook("context"');
    expect(pluginCode).not.toContain("tool.execute.before");
    expect(pluginCode).not.toContain("experimental.session.compacting");

    // Dynamic registration accuracy gate: plugin exports and registers both v2 hooks.
    const mod = (await import(pathToFileURL(pluginEntry).href)) as {
      default: { id: string; setup(ctx: unknown): Promise<void> };
    };
    const calls: Array<[string, string]> = [];
    const mockCtx = {
      permission: {
        hook: async (name: string, _callback: unknown) => {
          calls.push(["permission", name]);
        },
      },
      session: {
        hook: async (name: string, _callback: unknown) => {
          calls.push(["session", name]);
        },
      },
    };
    await expect(mod.default.setup(mockCtx)).resolves.toBeUndefined();
    expect(mod.default.id).toBe("nyxowl");
    expect(calls).toEqual([
      ["permission", "evaluate"],
      ["session", "context"],
    ]);

    expect(pkg.launchArgs).toEqual(["--standalone", projectDir]);
    expect(pkg.launchEnv["OPENCODE_CONFIG"]).toBe(pkg.configPath);
  });

  it("never caches edit decisions: consecutive edit actions invoke edit-guard twice", async () => {
    const fakeRoot = path.join(tmpRoot, "fake-pkg");
    const fakeEntry = path.join(fakeRoot, "dist", "cli", "index.js");
    fs.mkdirSync(path.dirname(fakeEntry), { recursive: true });
    fs.writeFileSync(
      fakeEntry,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const counter = process.env.FAKE_GUARD_COUNTER;",
        'const subcommand = process.argv[2] === "hook" ? process.argv[3] : process.argv[2];',
        'if (counter) fs.appendFileSync(counter, subcommand + "\\n");',
        'process.stdout.write(JSON.stringify({ permissionDecision: "allow", reason: "ok" }));',
      ].join("\n"),
      { mode: 0o755 },
    );
    // compileAllAgentsAndCommands resolves agents/skills from pkgRoot, so expose the real ones.
    fs.symlinkSync(path.join(process.cwd(), "agents"), path.join(fakeRoot, "agents"));
    fs.symlinkSync(path.join(process.cwd(), "skills-vendor"), path.join(fakeRoot, "skills-vendor"));

    const pkg = generateOpenCodeHostPackage({
      nyxowlHome,
      projectPath: projectDir,
      pkgRoot: fakeRoot,
    });
    const mod = (await import(pathToFileURL(path.join(pkg.pluginPath, "index.js")).href)) as {
      default: { setup(ctx: unknown): Promise<void> };
    };

    let permissionCallback: ((event: Record<string, unknown>) => void) | undefined;
    const mockCtx = {
      permission: {
        hook: async (name: string, callback: unknown) => {
          if (name === "evaluate" && typeof callback === "function") {
            permissionCallback = callback as (event: Record<string, unknown>) => void;
          }
        },
      },
      session: { hook: async () => {} },
    };
    await mod.default.setup(mockCtx);
    expect(permissionCallback).toBeTypeOf("function");

    const counterFile = path.join(tmpRoot, "guard-counter.txt");
    const previousCounter = process.env["FAKE_GUARD_COUNTER"];
    process.env["FAKE_GUARD_COUNTER"] = counterFile;
    try {
      const editEvent = () => ({
        action: "edit",
        resources: ["/tmp/qa/.nyxowl/worktrees/wt/src/a.ts"],
        agent: "nyx-devops",
        effect: "allow",
      });
      permissionCallback!(editEvent());
      permissionCallback!(editEvent());
      expect(fs.readFileSync(counterFile, "utf8").trim().split("\n")).toEqual([
        "edit-guard",
        "edit-guard",
      ]);

      const readEvent = () => ({
        action: "read",
        resources: ["/tmp/qa/project/src/plain.ts"],
        agent: "nyx-devops",
        effect: "allow",
      });
      permissionCallback!(readEvent());
      permissionCallback!(readEvent());
      expect(fs.readFileSync(counterFile, "utf8").trim().split("\n")).toEqual([
        "edit-guard",
        "edit-guard",
      ]);
    } finally {
      if (previousCounter === undefined) {
        delete process.env["FAKE_GUARD_COUNTER"];
      } else {
        process.env["FAKE_GUARD_COUNTER"] = previousCounter;
      }
    }
  });

  it("generates supported host packages idempotently with zero project footprint and passes agy plugin validate --strict", async () => {
    const beforeProjectFiles = fs.readdirSync(projectDir);
    const userCursorDir = path.join(tmpRoot, "user-cursor-generation");

    const claudePkg = generateClaudeHostPackage({ nyxowlHome, projectPath: projectDir });
    const opencodePkg = generateOpenCodeHostPackage({ nyxowlHome, projectPath: projectDir });
    const codexPkg = generateCodexHostPackage({ nyxowlHome, projectPath: projectDir });
    const agyPkg = generateAntigravityHostPackage({ nyxowlHome, projectPath: projectDir });
    const cursorPkg = generateCursorHostPackage({
      nyxowlHome,
      projectPath: projectDir,
      userCursorDir,
    });

    expect(fs.existsSync(claudePkg.settingsPath)).toBe(true);
    expect(fs.existsSync(opencodePkg.configPath)).toBe(true);
    expect(fs.existsSync(codexPkg.configTomlPath)).toBe(true);
    expect(fs.existsSync(agyPkg.settingsPath)).toBe(true);
    expect(fs.existsSync(cursorPkg.mcpConfigPath)).toBe(true);

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
      expect(parsed.components.agents).toBe(11);
      expect(parsed.components.hooks).toBe(1);
      expect(parsed.components.mcpServers).toBe(1);
      expect(parsed.findings).toEqual([]);
    }
  });

  it("preserves user JSONC comments and restores byte-identical user files on uninstall", () => {
    const userCursorDir = path.join(tmpRoot, "user-cursor");
    const userCodexDir = path.join(tmpRoot, "user-codex");
    fs.mkdirSync(userCursorDir, { recursive: true });
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

    // Run Cursor and Codex user-level installs twice (idempotency check)
    generateCursorHostPackage({ nyxowlHome, userCursorDir, projectPath: projectDir });
    const afterFirstCursor = fs.readFileSync(cursorMcpPath, "utf8");
    expect(afterFirstCursor).toContain("// User custom comment that must be preserved");
    expect(afterFirstCursor).toContain('"nyxowl"');

    generateCursorHostPackage({ nyxowlHome, userCursorDir, projectPath: projectDir });
    const afterSecondCursor = fs.readFileSync(cursorMcpPath, "utf8");
    expect(afterSecondCursor).toBe(afterFirstCursor);

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
    expect(fs.existsSync(path.join(userCursorDir, "rules", "nyxowl.mdc"))).toBe(false);
    expect(fs.existsSync(path.join(userCodexDir, "AGENTS.md"))).toBe(false);
  });
});

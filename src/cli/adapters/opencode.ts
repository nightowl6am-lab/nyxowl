import fs from "node:fs";
import { NYXOWL_VERSION } from "../../core/version.ts";
import path from "node:path";
import { resolveGlobalNyxowlPaths } from "../../core/paths.ts";
import { compileAllAgentsAndCommands } from "../compiler.ts";
import { writeTrackedFile } from "../manifest.ts";
import { resolveNyxowlCliCommand } from "./claude.ts";

export interface OpenCodePackageResult {
  packageDir: string;
  configPath: string;
  pluginPath: string;
  launchArgs: string[];
  launchEnv: Record<string, string>;
}

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

function rules(
  action: string,
  effect: OpenCodePermissionRule["effect"],
  resources: readonly string[],
): OpenCodePermissionRule[] {
  return resources.map((resource) => ({ action, resource, effect }));
}

const SECRET_DENY_RESOURCES: readonly string[] = [
  ".env*",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*credentials*.json",
  "**/*service-account*.json",
  "~/.aws/credentials",
  "~/.ssh/id_*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "~/.nyxowl/secrets/**",
  "~/.nyxowl/projects/**",
];

const ENV_EXAMPLE_ALLOW_RESOURCES: readonly string[] = [
  ".env.example",
  "**/.env.example",
  ".env.sample",
  "**/.env.sample",
  ".env.template",
  "**/.env.template",
];

const EDIT_DENY_RESOURCES: readonly string[] = [
  ".env*",
  "**/.env*",
  "~/.nyxowl/secrets/**",
  "~/.nyxowl/projects/**",
];

const SHELL_DENY_RESOURCES: readonly string[] = [
  "printenv*",
  "env",
  "export -p*",
  "gh auth token*",
  "git config --list*",
];

const SHELL_ASK_RESOURCES: readonly string[] = [
  "gh pr merge*",
  "git push --force*",
  "git push -f*",
  "git push origin main*",
  "git push origin master*",
  "npm publish*",
  "cargo publish*",
  "docker push*",
  "terraform apply*",
  "terraform destroy*",
  "kubectl delete*",
];

/**
 * Builds OpenCode v2's ordered permission rules (last-match-wins, §1.2.1, §8.4):
 * broad allows first, specific denies/asks next, and env example allows LAST.
 */
export function buildOpenCodePermissions(
  worktreeRoot: string,
  projectPath?: string,
): OpenCodePermissionRule[] {
  const resolvedWorktreeRoot = path.resolve(worktreeRoot);
  const externalAllows = [worktreeRoot];
  if (projectPath) {
    const resolvedProject = path.resolve(projectPath);
    const insideWorktree =
      resolvedProject === resolvedWorktreeRoot ||
      resolvedProject.startsWith(`${resolvedWorktreeRoot}${path.sep}`);
    if (!insideWorktree) {
      externalAllows.push(projectPath);
    }
  }

  // Exact paths plus descendant globs so v2 glob matching covers nested worktrees.
  const externalAllowResources = [
    ...new Set(
      externalAllows.flatMap((externalPath) => {
        const normalized = externalPath.replace(/\/+$/, "");
        return [normalized, `${normalized}/**`];
      }),
    ),
  ];

  return [
    // Broad read allow, then secret denies, then example allows last.
    { action: "read", resource: "*", effect: "allow" },
    ...rules("read", "deny", SECRET_DENY_RESOURCES),
    ...rules("read", "allow", ENV_EXAMPLE_ALLOW_RESOURCES),

    // Broad edit allow, then secret/workflow rules, then example allows last.
    { action: "edit", resource: "*", effect: "allow" },
    ...rules("edit", "deny", EDIT_DENY_RESOURCES),
    { action: "edit", resource: ".github/workflows/**", effect: "ask" },
    ...rules("edit", "allow", ENV_EXAMPLE_ALLOW_RESOURCES),

    // Shell secret/red-line rules.
    { action: "shell", resource: "*", effect: "allow" },
    ...rules("shell", "deny", SHELL_DENY_RESOURCES),
    ...rules("shell", "ask", SHELL_ASK_RESOURCES),

    // Web fetch stays disabled; external directory access is scoped to Nyxowl worktrees.
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "ask" },
    ...rules("external_directory", "allow", externalAllowResources),
  ];
}

function buildAgentPermissionRules(agent: {
  contract: {
    host_tools: {
      read: "allow" | "deny";
      edit: "worktree" | "tests" | "deny";
      write: "worktree" | "tests" | "deny";
      bash: "worktree" | "ask_redline" | "deny";
    };
    nyx_tools: readonly string[];
  };
}): OpenCodePermissionRule[] {
  const rulesOut: OpenCodePermissionRule[] = [];
  if (agent.contract.host_tools.read === "deny") {
    rulesOut.push({ action: "read", resource: "*", effect: "deny" });
  }
  if (agent.contract.host_tools.edit === "deny" || agent.contract.host_tools.write === "deny") {
    rulesOut.push({ action: "edit", resource: "*", effect: "deny" });
  }
  if (agent.contract.host_tools.bash === "deny") {
    rulesOut.push({ action: "shell", resource: "*", effect: "deny" });
  }
  rulesOut.push({ action: "webfetch", resource: "*", effect: "deny" });

  // Last-match-wins: deny every MCP tool, then allow only this role's tools.
  rulesOut.push({ action: "nyxowl_*", resource: "*", effect: "deny" });
  for (const tool of agent.contract.nyx_tools) {
    const fullToolName = tool.startsWith("nyx_") ? tool : `nyx_${tool}`;
    rulesOut.push({ action: `nyxowl_${fullToolName}`, resource: "*", effect: "allow" });
  }
  return rulesOut;
}

function buildOpenCodePluginCode(cliCmd: { command: string; args: string[] }): string {
  return [
    `// generated by nyxowl v${NYXOWL_VERSION}`,
    'import { execFileSync } from "node:child_process";',
    "",
    `const CLI = ${JSON.stringify([cliCmd.command, ...cliCmd.args])};`,
    "const CACHE_CAP = 256;",
    "const HYDRATE_CAP = 64;",
    "const DECISIONS = new Map();",
    "const HYDRATED = new Set();",
    'const SECRET_NAMES = [".npmrc", ".pypirc", ".netrc", ".git-credentials", "kubeconfig"];',
    "",
    "function cacheDecision(key, decision) {",
    "  if (DECISIONS.size >= CACHE_CAP) {",
    "    const oldest = DECISIONS.keys().next().value;",
    "    if (oldest !== undefined) DECISIONS.delete(oldest);",
    "  }",
    "  DECISIONS.set(key, decision);",
    "}",
    "",
    "function isSecretPath(raw) {",
    '  const normalized = String(raw || "").replace(/\\\\/g, "/");',
    '  const base = (normalized.split("/").pop() || "").toLowerCase();',
    '  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") return false;',
    '  if (base === ".env" || base.startsWith(".env.")) return true;',
    '  if (base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12") || base.endsWith(".pfx")) return true;',
    '  if (base.includes("credentials") && base.endsWith(".json")) return true;',
    '  if (base.includes("service-account") && base.endsWith(".json")) return true;',
    '  if (SECRET_NAMES.includes(base) || base.startsWith("id_")) return true;',
    "  const lowered = normalized.toLowerCase();",
    '  if (lowered.includes("/.aws/credentials") || lowered.includes("/.ssh/")) return true;',
    '  if (lowered.includes("/.nyxowl/secrets/") || lowered.includes("/.nyxowl/projects/")) return true;',
    "  return false;",
    "}",
    "",
    "function parseJson(raw) {",
    "  if (!raw) return null;",
    "  try {",
    "    return JSON.parse(raw);",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
    "",
    "function runCliJson(subcommand, payload) {",
    "  const argv = CLI.slice(1).concat([\"hook\", subcommand]);",
    "  try {",
    "    const stdout = execFileSync(CLI[0], argv, {",
    "      input: JSON.stringify(payload),",
    '      env: Object.assign({}, process.env, { NYXOWL_SESSION: "1" }),',
    '      encoding: "utf8",',
    "      timeout: 5000,",
    '      stdio: ["pipe", "pipe", "pipe"],',
    "    });",
    "    return parseJson(stdout);",
    "  } catch (err) {",
    '    const stdout = err && typeof err.stdout === "string" ? err.stdout : "";',
    "    return parseJson(stdout);",
    "  }",
    "}",
    "",
    "function runPermissionCli(subcommand, payload) {",
    "  const parsed = runCliJson(subcommand, payload);",
    "  if (!parsed) return null;",
    "  const effect = parsed.permissionDecision || parsed.decision;",
    '  if (effect !== "allow" && effect !== "deny" && effect !== "ask") return null;',
    "  return {",
    "    effect,",
    '    reason: parsed.reason || parsed.permissionDecisionReason || "",',
    "  };",
    "}",
    "",
    "function toPayload(action, resource) {",
    '  if (action === "shell" || action === "bash") {',
    '    return { tool_name: "bash", tool_input: { command: resource } };',
    "  }",
    '  if (action === "edit" || action === "write" || action === "patch") {',
    '    return { tool_name: "edit", tool_input: { file_path: resource } };',
    "  }",
    '  return { tool_name: "read", tool_input: { file_path: resource } };',
    "}",
    "",
    "function evaluatePermission(event) {",
    "  try {",
    '    if (!event || typeof event.action !== "string") return;',
    "    const action = event.action;",
    "    const resources = Array.isArray(event.resources) ? event.resources : [];",
    '    const resource = typeof resources[0] === "string" ? resources[0] : "*";',
    '    if (action === "external_directory" && !isSecretPath(resource)) return;',
    '    if (action === "read" && !isSecretPath(resource)) return;',
    "    const supported =",
    '      action === "shell" || action === "bash" || action === "edit" ||',
    '      action === "write" || action === "patch" || action === "read" ||',
    '      action === "external_directory";',
    "    if (!supported) return;",
    '    const agentName = typeof event.agent === "string" && event.agent ? event.agent : "nyxowl";',
    '    const isEditAction = action === "edit" || action === "write" || action === "patch";',
    '    const cacheKey = action + "\\u0000" + agentName + "\\u0000" + resource;',
    "    if (!isEditAction) {",
    "      const cached = DECISIONS.get(cacheKey);",
    "      if (cached) {",
    '        if (cached.effect === "deny") {',
    '          event.effect = "deny";',
    "          if (cached.reason) event.message = cached.reason;",
    '        } else if (cached.effect === "ask") {',
    '          event.effect = "ask";',
    "        }",
    "        return;",
    "      }",
    "    }",
    "    const payload = Object.assign(toPayload(action, resource), { agent_name: agentName });",
    '    const subcommand = isEditAction ? "edit-guard" : "guard";',
    "    const decision = runPermissionCli(subcommand, payload);",
    "    if (!decision) return;",
    '    if (decision.effect === "deny") {',
    '      event.effect = "deny";',
    "      if (decision.reason) event.message = decision.reason;",
    '    } else if (decision.effect === "ask") {',
    '      event.effect = "ask";',
    "    }",
    '    if (!isEditAction && (decision.effect === "deny" || decision.effect === "ask")) {',
    "      cacheDecision(cacheKey, decision);",
    "    }",
    "  } catch {",
    "    // Fail-open: an OpenCode API or guard mismatch must not prevent startup.",
    "  }",
    "}",
    "",
    "function hydrateSession(event) {",
    "  try {",
    '    if (!event || typeof event.sessionID !== "string" || !event.sessionID) return;',
    "    if (HYDRATED.has(event.sessionID)) return;",
    "    if (HYDRATED.size >= HYDRATE_CAP) {",
    "      const oldest = HYDRATED.values().next().value;",
    "      if (oldest !== undefined) HYDRATED.delete(oldest);",
    "    }",
    "    HYDRATED.add(event.sessionID);",
    '    const parsed = runCliJson("session-start", { agent_name: "nyxowl" });',
    '    const text = parsed && typeof parsed.additionalContext === "string" ? parsed.additionalContext : "";',
    "    if (!text) return;",
    '    if (Array.isArray(event.system)) event.system.push({ type: "text", text });',
    "  } catch {",
    "    // Fail-open: hydration is best-effort and must not block the session.",
    "  }",
    "}",
    "",
    "export default {",
    '  id: "nyxowl",',
    "  async setup(ctx) {",
    "    try {",
    "      if (ctx && ctx.permission && typeof ctx.permission.hook === \"function\") {",
    '        await ctx.permission.hook("evaluate", evaluatePermission);',
    "      }",
    "    } catch {",
    "      // Fail-open to native OpenCode permissions.",
    "    }",
    "    try {",
    "      if (ctx && ctx.session && typeof ctx.session.hook === \"function\") {",
    '        await ctx.session.hook("context", hydrateSession);',
    "      }",
    "    } catch {",
    "      // Fail-open: hydration is optional.",
    "    }",
    "  },",
    "};",
    "",
  ].join("\n");
}

export function generateOpenCodeHostPackage(options?: {
  nyxowlHome?: string;
  projectPath?: string;
  worktreeRoot?: string;
  dnaTags?: Iterable<string>;
  pkgRoot?: string;
}): OpenCodePackageResult {
  const globalPaths = resolveGlobalNyxowlPaths(options?.nyxowlHome);
  const packageDir = path.join(globalPaths.hostsDir, "opencode");
  const worktreeRoot = options?.worktreeRoot ?? globalPaths.worktreesDir;
  const cliCmd = resolveNyxowlCliCommand(options?.pkgRoot);

  const bundle = compileAllAgentsAndCommands({
    ...(options?.dnaTags ? { dnaTags: options.dnaTags } : {}),
    includeConditionalAll: !options?.dnaTags,
    ...(options?.pkgRoot ? { pkgRoot: options.pkgRoot } : {}),
  });

  const agentsConfig: Record<string, unknown> = {};
  for (const agent of bundle.agents) {
    agentsConfig[agent.contract.id] = {
      mode: agent.contract.mode,
      description: agent.contract.description,
      system: agent.compiledPrompt.trim(),
      permissions: buildAgentPermissionRules(agent),
    };
  }

  const commandsConfig: Record<string, unknown> = {};
  for (const cmd of bundle.commands) {
    commandsConfig[cmd.name] = {
      description: cmd.description,
      template: cmd.bodyMarkdown,
    };
  }

  // Copy resolved skills into packageDir/skills
  for (const skill of bundle.allResolvedSkills) {
    const srcMd = path.join(skill.sourcePath, "SKILL.md");
    if (fs.existsSync(srcMd)) {
      writeTrackedFile({
        targetPath: path.join(packageDir, "skills", skill.name, "SKILL.md"),
        content: fs.readFileSync(srcMd, "utf8"),
        host: "opencode",
        ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
      });
    }
  }

  // OpenCode v2 auto-discovers plugins inside the config directory, so keep the
  // explicit plugin directory as a sibling of hosts/opencode to avoid double loads.
  const pluginPath = path.join(globalPaths.hostsDir, "opencode-plugin", "nyxowl");
  writeTrackedFile({
    targetPath: path.join(pluginPath, "index.js"),
    content: buildOpenCodePluginCode(cliCmd),
    host: "opencode",
    ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
  });

  // Write opencode.json
  const configPath = path.join(packageDir, "opencode.json");
  const opencodeConfig = {
    // nyx-allow: hardcoded-url — official OpenCode JSON schema URL
    $schema: "https://opencode.ai/config.json",
    default_agent: "nyxowl",
    mcp: {
      servers: {
        nyxowl: {
          type: "local",
          command: [cliCmd.command, ...cliCmd.args, "mcp"],
          environment: {
            NYXOWL_SESSION: "1",
            ...(options?.projectPath ? { NYXOWL_PROJECT: options.projectPath } : {}),
          },
        },
      },
    },
    permissions: buildOpenCodePermissions(worktreeRoot, options?.projectPath),
    agents: agentsConfig,
    commands: commandsConfig,
    plugins: [pluginPath],
  };
  writeTrackedFile({
    targetPath: configPath,
    content: `${JSON.stringify(opencodeConfig, null, 2)}\n`,
    host: "opencode",
    ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
  });

  const targetDir = options?.projectPath ?? process.cwd();
  return {
    packageDir,
    configPath,
    pluginPath,
    launchArgs: ["--standalone", targetDir],
    launchEnv: {
      NYXOWL_SESSION: "1",
      OPENCODE_CONFIG: configPath,
      ...(options?.projectPath ? { NYXOWL_PROJECT: options.projectPath } : {}),
    },
  };
}

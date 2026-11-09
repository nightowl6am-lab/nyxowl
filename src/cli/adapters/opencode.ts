import { NYXOWL_VERSION } from "../../core/version.ts";
import fs from "node:fs";
import path from "node:path";
import { resolveGlobalNyxowlPaths } from "../../core/paths.ts";
import {
  compileAllAgentsAndCommands,
  NYX_MCP_TOOL_BASENAMES,
} from "../compiler.ts";
import { resolveNyxowlCliCommand } from "../cli-command.ts";
import { writeTrackedFile } from "../manifest.ts";
import {
  AGENT_SKILL_IDS,
  agentSkillDir,
  loadAgentSkillPackage,
} from "../skills.ts";

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

    // Web fetch/search stay disabled; external directory access is scoped to Nyxowl worktrees.
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "ask" },
    ...rules("external_directory", "allow", externalAllowResources),
  ];
}

// Host actions denied explicitly for a fully isolated subagent. A whole-action
// "*" wildcard deny is deliberately NOT used: live QA showed OpenCode removes
// the allowed nyxowl_* MCP tools from the model's tool surface when one is
// present, even though last-match-wins keeps them allowed in the rule list.
//
// The OpenCode resource-listing actions (`opencode_list_mcp_resources`,
// `opencode_read_mcp_resource`) are intentionally NOT denied here: live QA
// showed denying them also hides the five nyxowl_nyx_testwriter_* MCP tools
// from the model. They are blocked per-agent by the plugin hook instead.
const FULLY_ISOLATED_DENY_ACTIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "shell",
  "webfetch",
  "websearch",
  "subagent",
  "skill",
  "question",
  "external_directory",
  "experimental_image_generate",
  "execute",
] as const;

export function buildAgentPermissionRules(agent: {
  contract: {
    id: string;
    host_tools: {
      read: "allow" | "deny";
      edit: "worktree" | "tests" | "deny";
      write: "worktree" | "tests" | "deny";
      bash: "worktree" | "ask_redline" | "deny";
    };
    nyx_tools: readonly string[];
  };
  skillMode?: "native" | "inline";
}): OpenCodePermissionRule[] {
  const rulesOut: OpenCodePermissionRule[] = [];
  const hostTools = agent.contract.host_tools;
  const fullyIsolated =
    hostTools.read === "deny" &&
    hostTools.edit === "deny" &&
    hostTools.write === "deny" &&
    hostTools.bash === "deny";
  // Fully isolated agents (e.g. nyx-testwriter) get explicit denies for every
  // known host action, including MCP-resource and host-inspection actions, so a
  // wildcard deny is never needed. Partially privileged agents keep the narrower
  // read/edit/shell/webfetch/websearch rule set.
  if (fullyIsolated) {
    for (const action of FULLY_ISOLATED_DENY_ACTIONS) {
      rulesOut.push({ action, resource: "*", effect: "deny" });
    }
  } else {
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
    rulesOut.push({ action: "websearch", resource: "*", effect: "deny" });
  }

  // Per-agent skill permissions: deny every skill, then allow only the exact
  // native skill id. Inline agents have no host skill and get no allow. Fully
  // isolated agents already received the skill deny in their host-action list.
  if (!fullyIsolated) {
    rulesOut.push({ action: "skill", resource: "*", effect: "deny" });
  }
  if ((agent.skillMode ?? "native") === "native") {
    rulesOut.push({ action: "skill", resource: agent.contract.id, effect: "allow" });
  }

  // Last-match-wins: deny every known MCP tool by exact name, then allow only
  // this role's tools. A `nyxowl_*` action wildcard is deliberately avoided:
  // live QA showed OpenCode hides the allowed MCP tools when a wildcard action
  // is present, even though last-match-wins keeps them allowed.
  for (const tool of NYX_MCP_TOOL_BASENAMES) {
    rulesOut.push({ action: `nyxowl_nyx_${tool}`, resource: "*", effect: "deny" });
  }
  const allowedToolNames = new Set(
    agent.contract.nyx_tools.map((tool) =>
      tool.startsWith("nyx_") ? tool : `nyx_${tool}`,
    ),
  );
  for (const fullToolName of allowedToolNames) {
    rulesOut.push({ action: `nyxowl_${fullToolName}`, resource: "*", effect: "allow" });
  }

  return rulesOut;
}

/**
 * Returns every symlink under a skill package. The caller must reject rather
 * than dereference: a symlink could point outside the skills root.
 */
function findSkillSymlinks(root: string, base = root): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const relative = path.relative(base, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      out.push(relative);
      continue;
    }
    if (entry.isDirectory()) out.push(...findSkillSymlinks(full, base));
  }
  return out;
}

/**
 * Copies all 11 authored skill packages into the host skills root and prunes
 * any stale directory. The host advertises only this absolute root.
 */
export function syncSkillPackages(options: {
  packageDir: string;
  pkgRoot?: string;
}): { skillsRoot: string; copied: string[]; pruned: string[] } {
  const skillsRoot = path.join(options.packageDir, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  const expected = new Set<string>(AGENT_SKILL_IDS);
  const pruned: string[] = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    const full = path.join(skillsRoot, entry.name);
    if (entry.isDirectory() || entry.isFile()) {
      if (!expected.has(entry.name as (typeof AGENT_SKILL_IDS)[number])) {
        fs.rmSync(full, { recursive: true, force: true });
        pruned.push(entry.name);
      }
    }
  }
  const copied: string[] = [];
  for (const agentId of AGENT_SKILL_IDS) {
    const pkg = loadAgentSkillPackage(agentId, options.pkgRoot);
    if (!pkg.loaded || !pkg.licensePresent) {
      throw new Error(
        `Skill package ${agentId} is missing SKILL.md or LICENSE at ${pkg.dir}`,
      );
    }
    const destination = path.join(skillsRoot, agentId);
    const sourceDir = agentSkillDir(agentId, options.pkgRoot);
    const symlinks = findSkillSymlinks(sourceDir);
    if (symlinks.length > 0) {
      throw new Error(
        `Skill package ${agentId} contains unsupported symlink(s): ${symlinks.join(", ")}`,
      );
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(sourceDir, destination, { recursive: true });
    copied.push(agentId);
  }
  return { skillsRoot, copied, pruned };
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
    "const TESTWRITER_ACTIONS = new Set([",
    '  "nyxowl_nyx_testwriter_job",',
    '  "nyxowl_nyx_testwriter_write",',
    '  "nyxowl_nyx_testwriter_lint",',
    '  "nyxowl_nyx_testwriter_gate",',
    '  "nyxowl_nyx_testwriter_finish",',
    "]);",
    "// The live snapshot shape is unconfirmed, so match by suffix, not exact key.",
    "const TESTWRITER_TOOL_SUFFIXES = [",
    '  "testwriter_job",',
    '  "testwriter_write",',
    '  "testwriter_lint",',
    '  "testwriter_gate",',
    '  "testwriter_finish",',
    "];",
    "// Native host tools that must not reach nyx-testwriter. The pre-MCP context",
    "// snapshot contains only these and other host tools, so the filter is phased:",
    "// it denylists this set until an allowed MCP tool appears, then allowlists.",
    "const TESTWRITER_DENY_TOOLS = new Set([",
    '  "opencode_models",',
    '  "opencode_session_move",',
    '  "opencode_session_rename",',
    '  "opencode_worktree_create",',
    '  "opencode_worktree_list",',
    "]);",
    'const TESTWRITER_BOUNDARY = "nyx-testwriter may only use the five tools: job, write, lint, gate, finish.";',
    'const SECRET_NAMES = [".npmrc", ".pypirc", ".netrc", ".git-credentials", "kubeconfig"];',
    "",
    "function resolveAgentName(event) {",
    '  if (event && typeof event.agent === "string" && event.agent) return event.agent;',
    '  if (event && typeof event.agent_name === "string" && event.agent_name) return event.agent_name;',
    '  return "nyxowl";',
    "}",
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
    "    const agentName = resolveAgentName(event);",
    '    if (agentName === "nyx-testwriter") {',
    "      // Per-agent allowlist: only the five Test-Writer MCP actions pass.",
    "      if (TESTWRITER_ACTIONS.has(action)) return;",
    '      event.effect = "deny";',
    "      event.message = TESTWRITER_BOUNDARY;",
    "      return;",
    "    }",
    "    const resources = Array.isArray(event.resources) ? event.resources : [];",
    '    const resource = typeof resources[0] === "string" ? resources[0] : "*";',
    '    if (action === "external_directory" && !isSecretPath(resource)) return;',
    '    if (action === "read" && !isSecretPath(resource)) return;',
    "    const supported =",
    '      action === "shell" || action === "bash" || action === "edit" ||',
    '      action === "write" || action === "patch" || action === "read" ||',
    '      action === "external_directory";',
    "    if (!supported) return;",
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
    '    if (event && typeof event === "object" && resolveAgentName(event) === "nyx-testwriter") {',
    '      event.effect = "deny";',
    "      event.message = TESTWRITER_BOUNDARY;",
    "      return;",
    "    }",
    "    // Fail-open for other agents: an API mismatch must not prevent startup.",
    "  }",
    "}",
    "",
    "function toolNameOf(entry) {",
    '  if (typeof entry === "string") return entry;',
    '  if (!entry || typeof entry !== "object") return "";',
    '  const candidates = [entry.id, entry.name, entry.tool, entry.function && entry.function.name];',
    "  for (const candidate of candidates) {",
    '    if (typeof candidate === "string" && candidate) return candidate;',
    "  }",
    '  return "";',
    "}",
    "",
    "function isAllowedTool(entry) {",
    "  const name = toolNameOf(entry);",
    "  if (name) {",
    "    for (const suffix of TESTWRITER_TOOL_SUFFIXES) {",
    "      if (name.endsWith(suffix)) return true;",
    "    }",
    "    return false;",
    "  }",
    "  try {",
    '    return JSON.stringify(entry).includes("testwriter_");',
    "  } catch {",
    "    return false;",
    "  }",
    "}",
    "",
    "function isDeniedTool(entry) {",
    "  const name = toolNameOf(entry);",
    "  return Boolean(name) && TESTWRITER_DENY_TOOLS.has(name);",
    "}",
    "",
    "function restrictTools(event) {",
    "  try {",
    '    const isTestWriter = event && event.agent === "nyx-testwriter";',
    "    if (!isTestWriter) return;",
    '    if (!event.tools || typeof event.tools !== "object") return;',
    "    // Two-phase filter. Before the MCP tools register, the snapshot has only",
    "    // host tools, so deleting every non-allowed key would suppress MCP",
    "    // registration. Delete just the five bypassing host tools in that phase.",
    "    // Once any allowed Test-Writer tool appears, keep only allowed entries.",
    "    if (Array.isArray(event.tools)) {",
    "      const tools = event.tools;",
    "      const hasAllowed = tools.some(function (entry) { return isAllowedTool(entry); });",
    "      if (hasAllowed) {",
    "        for (let i = tools.length - 1; i >= 0; i -= 1) {",
    "          if (!isAllowedTool(tools[i])) tools.splice(i, 1);",
    "        }",
    "        return;",
    "      }",
    "      for (let i = tools.length - 1; i >= 0; i -= 1) {",
    "        if (isDeniedTool(tools[i])) tools.splice(i, 1);",
    "      }",
    "      return;",
    "    }",
    "    const tools = event.tools;",
    "    const keys = Object.keys(tools);",
    "    const hasAllowed = keys.some(function (name) {",
    "      return isAllowedTool(name) || isAllowedTool(tools[name]);",
    "    });",
    "    if (hasAllowed) {",
    "      for (const name of keys) {",
    "        if (!isAllowedTool(name) && !isAllowedTool(tools[name])) delete tools[name];",
    "      }",
    "      return;",
    "    }",
    "    for (const name of keys) {",
    "      if (TESTWRITER_DENY_TOOLS.has(name)) delete tools[name];",
    "    }",
    "  } catch {",
    "    // Fail-open: tool filtering must not break the model call.",
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
    "    try {",
    "      if (ctx && ctx.session && typeof ctx.session.hook === \"function\") {",
    '        await ctx.session.hook("context", restrictTools);',
    "      }",
    "    } catch {",
    "      // Fail-open: tool filtering is optional and must not block setup.",
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
  pkgRoot?: string;
}): OpenCodePackageResult {
  const globalPaths = resolveGlobalNyxowlPaths(options?.nyxowlHome);
  const packageDir = path.join(globalPaths.hostsDir, "opencode");
  const worktreeRoot = options?.worktreeRoot ?? globalPaths.worktreesDir;
  const cliCmd = resolveNyxowlCliCommand(options?.pkgRoot);

  const bundle = compileAllAgentsAndCommands({
    ...(options?.pkgRoot ? { pkgRoot: options.pkgRoot } : {}),
  });

  const { skillsRoot } = syncSkillPackages({
    packageDir,
    ...(options?.pkgRoot ? { pkgRoot: options.pkgRoot } : {}),
  });

  // Skills live outside the worktree. Non-interactive runs cannot answer an
  // `external_directory` prompt, so allow only the skills root and its
  // descendants after the worktree rules (last-match-wins).
  const hostPermissions = buildOpenCodePermissions(worktreeRoot, options?.projectPath);
  hostPermissions.push(
    { action: "external_directory", resource: skillsRoot, effect: "allow" },
    { action: "external_directory", resource: `${skillsRoot}/**`, effect: "allow" },
  );

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
    permissions: hostPermissions,
    skills: [skillsRoot],
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

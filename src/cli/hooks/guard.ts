import fs from "node:fs";
import path from "node:path";
import { parse as parseShellQuote, type ParseEntry } from "shell-quote";
import { computeRepoIdSync } from "../../core/git.ts";
import { resolveGlobalNyxowlPaths, resolveProjectNyxowlPaths } from "../../core/paths.ts";
import { openProjectDb } from "../../mcp/db/sqlite.ts";

export interface HookInputPayload {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  agent_name?: string;
  subagent_type?: string;
  agent?: string;
}

export interface GuardDecision {
  decision: "allow" | "deny" | "ask";
  reason?: string;
  ruleId?: string;
}

const ALLOWED_ENV_EXAMPLES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

const KNOWN_PRIVATE_KEY_FILENAMES = new Set([
  "server.key",
  "private.key",
  "privkey.key",
  "tls.key",
  "ssl.key",
  "host.key",
  "client.key",
  "signing.key",
  "ca.key",
  "root.key",
]);

/**
 * A `.key` token is only a private key when it plausibly names a file. Member expressions such
 * as `e.key` and `item.key` are identifiers, not paths, and must not trip the secret guard.
 */
function isPlausiblePrivateKeyPath(
  trimmed: string,
  normalized: string,
  lowerBase: string,
): boolean {
  if (!lowerBase.endsWith(".key")) return false;
  if (KNOWN_PRIVATE_KEY_FILENAMES.has(lowerBase)) return true;
  if (normalized.includes("/")) return true;
  if (trimmed.startsWith(".") || trimmed.startsWith("~")) return true;
  return false;
}

export function isNyxowlSessionActive(
  payload: HookInputPayload,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["NYXOWL_SESSION"] === "1") return true;
  const agentName = (
    payload.agent_name ??
    payload.subagent_type ??
    payload.agent ??
    env["NYXOWL_ROLE"] ??
    ""
  ).toLowerCase();
  if (agentName === "nyxowl" || agentName.startsWith("nyx-")) {
    return true;
  }
  return false;
}

export function isSecretFilePath(rawPath: string, nyxowlHome?: string): boolean {
  const trimmed = rawPath.trim().replace(/^@/, "");
  if (!trimmed) return false;

  const normalized = trimmed.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  const lowerBase = base.toLowerCase();
  const lowerNorm = normalized.toLowerCase();

  if (ALLOWED_ENV_EXAMPLES.has(lowerBase)) {
    return false;
  }

  // .env and .env.* variants
  if (lowerBase === ".env" || lowerBase.startsWith(".env.")) {
    return true;
  }

  // Certificates / private keys / credentials
  if (
    lowerBase.endsWith(".pem") ||
    isPlausiblePrivateKeyPath(trimmed, normalized, lowerBase) ||
    lowerBase.endsWith(".p12") ||
    lowerBase.endsWith(".pfx") ||
    (lowerBase.includes("credentials") && lowerBase.endsWith(".json")) ||
    (lowerBase.includes("service-account") && lowerBase.endsWith(".json")) ||
    lowerBase === ".npmrc" ||
    lowerBase === ".pypirc" ||
    lowerBase === ".netrc" ||
    lowerBase === ".git-credentials" ||
    lowerBase === "kubeconfig" ||
    lowerBase.startsWith("id_rsa") ||
    lowerBase.startsWith("id_ed25519") ||
    lowerBase.startsWith("id_ecdsa")
  ) {
    return true;
  }

  if (
    lowerNorm.includes("/.aws/credentials") ||
    lowerNorm.includes("/.ssh/id_") ||
    lowerNorm.includes("/proc/self/environ") ||
    /\/proc\/\d+\/environ/.test(lowerNorm)
  ) {
    return true;
  }

  // Check ~/.nyxowl/secrets and ~/.nyxowl/projects deny-list
  const globalPaths = resolveGlobalNyxowlPaths(nyxowlHome);
  const secretsNorm = globalPaths.secretsDir.replace(/\\/g, "/").toLowerCase();
  const projectsNorm = globalPaths.projectsDir.replace(/\\/g, "/").toLowerCase();
  if (
    lowerNorm.includes(".nyxowl/secrets") ||
    lowerNorm.includes(".nyxowl/projects") ||
    lowerNorm.startsWith(secretsNorm) ||
    lowerNorm.startsWith(projectsNorm)
  ) {
    return true;
  }

  return false;
}

/**
 * Extracts sub-commands from `$(...)` and backticks `` `...` `` before passing to shell-quote.
 */
function extractEmbeddedSubstitutions(cmd: string): string[] {
  const subs: string[] = [];
  const dollarParenRegex = /\$\(([^()]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = dollarParenRegex.exec(cmd)) !== null) {
    if (m[1]) subs.push(m[1]);
  }
  const backtickRegex = /`([^`]+)`/g;
  while ((m = backtickRegex.exec(cmd)) !== null) {
    if (m[1]) subs.push(m[1]);
  }
  return subs;
}

const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/g;

/**
 * Conservative allowlist of commands that treat stdin as inert data. A heredoc is only stripped
 * for these receivers; every other command (interpreters, `bash -c`, unknown binaries) keeps its
 * body in the scanned text so secret paths inside executable input are still blocked.
 */
const HEREDOC_DATA_SINKS = new Set(["cat", "tee", "printf", "echo", "logger"]);

function heredocReceiverIsDataSink(line: string, heredocIndex: number): boolean {
  const prefix = line.slice(0, heredocIndex);
  // Ambiguous command chains are never stripped.
  if (/(?:^|[^\\])(?:;|&&|\|\||\||&)/.test(prefix)) return false;

  let entries: ParseEntry[];
  try {
    entries = parseShellQuote(prefix, (varName) => `__VAR_${varName}__`);
  } catch {
    return false;
  }

  const tokens: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      tokens.push(entry);
    } else if (entry !== null && typeof entry === "object" && "op" in entry) {
      const op = entry.op;
      const isRedirection = op === "<" || op === ">" || op === ">>";
      if (!isRedirection) return false;
    }
  }

  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) {
    index++;
  }
  const receiver = (tokens[index] ?? "").replace(/\\/g, "/");
  const bin = path.posix.basename(receiver).toLowerCase();
  return HEREDOC_DATA_SINKS.has(bin);
}

/**
 * Removes heredoc bodies only when the receiving command is an inert data sink, so a body line
 * like `e.key` is not tokenized as a shell argument. Bodies fed to interpreters or unknown
 * commands are preserved and scanned for secret paths.
 */
export function stripHeredocBodies(commandStr: string): string {
  const lines = commandStr.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    output.push(line);
    index++;

    const delimiters: Array<{ token: string; allowIndent: boolean }> = [];
    let stripsBody = true;
    HEREDOC_START.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HEREDOC_START.exec(line)) !== null) {
      const token = match[2];
      if (!token) continue;
      const introducer = line.slice(match.index, match.index + 3);
      delimiters.push({ token, allowIndent: introducer.includes("-") });
      if (!heredocReceiverIsDataSink(line, match.index)) {
        stripsBody = false;
      }
    }

    // Conservative: if any heredoc on this line is not a data-sink feed, keep every body.
    if (!stripsBody) continue;

    for (const delimiter of delimiters) {
      while (index < lines.length) {
        const bodyLine = lines[index]!;
        index++;
        const candidate = delimiter.allowIndent
          ? bodyLine.replace(/^\t+/, "")
          : bodyLine;
        if (candidate === delimiter.token) break;
      }
    }
  }

  return output.join("\n");
}

/**
 * Splits a shell command string into individual simple command token arrays using `shell-quote`,
 * recursively expanding `bash -c`, `sh -c`, `eval`, `$(...)`, and backticks.
 */
export function splitShellCommandsRecursive(
  commandStr: string,
  depth = 0,
): { commands: string[][]; hasPipeToShell: boolean } {
  if (depth > 5) return { commands: [], hasPipeToShell: false };

  // Detect curl/wget piped to sh/bash/zsh
  const hasPipeToShell =
    /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i.test(commandStr);

  const embedded = extractEmbeddedSubstitutions(commandStr);
  // Replace $VARS with safe placeholders so shell-quote doesn't expand process.env
  const entries: ParseEntry[] = parseShellQuote(commandStr, (varName) => `__VAR_${varName}__`);

  const commands: string[][] = [];
  let current: string[] = [];

  for (const entry of entries) {
    if (typeof entry === "string") {
      current.push(entry);
    } else if (typeof entry === "object" && entry !== null && "op" in entry) {
      const op = entry.op;
      if (op === ";" || op === "&&" || op === "||" || op === "|" || op === "&") {
        if (current.length > 0) {
          commands.push(current);
          current = [];
        }
      } else if (op === "glob" && "pattern" in entry && typeof entry.pattern === "string") {
        current.push(entry.pattern);
      }
    }
  }
  if (current.length > 0) {
    commands.push(current);
  }

  // Expand `sh -c "..."`, `bash -c "..."`, `eval "..."`
  const finalCommands: string[][] = [];
  for (const tokens of commands) {
    finalCommands.push(tokens);
    const bin = path.posix.basename((tokens[0] ?? "").replace(/\\/g, "/"));
    if (
      (bin === "sh" || bin === "bash" || bin === "zsh" || bin === "dash") &&
      tokens.includes("-c")
    ) {
      const cIdx = tokens.indexOf("-c");
      const subCmd = tokens[cIdx + 1];
      if (subCmd) {
        const subRes = splitShellCommandsRecursive(subCmd, depth + 1);
        finalCommands.push(...subRes.commands);
      }
    } else if (bin === "eval" && tokens.length > 1) {
      const subRes = splitShellCommandsRecursive(tokens.slice(1).join(" "), depth + 1);
      finalCommands.push(...subRes.commands);
    }
  }

  for (const sub of embedded) {
    const subRes = splitShellCommandsRecursive(sub, depth + 1);
    finalCommands.push(...subRes.commands);
  }

  return { commands: finalCommands, hasPipeToShell };
}

function isApprovedDependency(
  pkgSpec: string,
  ecosystem: string,
  projectPath: string,
  nyxowlHome?: string,
): boolean {
  try {
    const repoId = computeRepoIdSync(projectPath);
    const projPaths = resolveProjectNyxowlPaths(repoId, nyxowlHome);
    if (!fs.existsSync(projPaths.stateDbFile)) {
      return false;
    }
    const db = openProjectDb(projPaths.stateDbFile);
    try {
      // Strip version spec if any (e.g. zod@^4.0.0 -> zod, @fastify/cors@1.0.0 -> @fastify/cors)
      let pkgName = pkgSpec.trim();
      const atIdx = pkgName.lastIndexOf("@");
      if (atIdx > 0) {
        pkgName = pkgName.slice(0, atIdx);
      }
      const row = db.db
        .prepare(
          "SELECT approved FROM dep_approvals WHERE package_name = ? AND ecosystem = ? AND approved = 1 LIMIT 1",
        )
        .get(pkgName, ecosystem) as { approved: number } | undefined;
      return Boolean(row);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function evaluateShellCommandGuard(
  commandStr: string,
  options?: {
    cwd?: string;
    projectPath?: string;
    nyxowlHome?: string;
  },
): GuardDecision {
  const raw = commandStr.trim();
  if (!raw) return { decision: "allow" };

  // Quick check for inline interpreter env dumps (node -e "...process.env...", python -c "...os.environ...")
  if (
    /\bprocess\.env\b/.test(raw) ||
    /\bos\.environ\b/.test(raw) ||
    /\bdotenv\b/i.test(raw) ||
    /\/proc\/(?:self|\d+)\/environ/.test(raw)
  ) {
    return {
      decision: "deny",
      ruleId: "SEC_ENV_DUMP",
      reason:
        "Blocked environment variable dump / secret inspection. Use nyx_env_inspect to inspect env key shapes safely.",
    };
  }

  // Heredoc bodies are data, not shell arguments: strip them before tokenization and path checks.
  const { commands, hasPipeToShell } = splitShellCommandsRecursive(stripHeredocBodies(raw));
  if (hasPipeToShell) {
    return {
      decision: "deny",
      ruleId: "DESTRUCTIVE_PIPE_SH",
      reason: "Blocked piping remote curl/wget output directly into a shell.",
    };
  }

  for (const tokens of commands) {
    if (tokens.length === 0) continue;

    // Strip leading VAR=val env assignments
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) {
      const assign = tokens[idx]!;
      const eqVal = assign.slice(assign.indexOf("=") + 1);
      if (isSecretFilePath(eqVal, options?.nyxowlHome)) {
        return {
          decision: "deny",
          ruleId: "SEC_SECRET_PATH",
          reason: `Blocked access to secret file path in assignment: ${assign}`,
        };
      }
      idx++;
    }
    const cmdTokens = tokens.slice(idx);
    if (cmdTokens.length === 0) continue;

    const bin = path.posix.basename(cmdTokens[0]!.replace(/\\/g, "/")).toLowerCase();
    const args = cmdTokens.slice(1);

    // 1. Check every token for secret file paths (.env*, *.pem, *.key, ~/.nyxowl/secrets, ~/.nyxowl/projects)
    for (const tok of cmdTokens) {
      // Handle flags like --env-file=.env or -d@.env
      const eqParts = tok.split("=");
      for (const part of eqParts) {
        const cleaned = part.replace(/^-d@?/, "").replace(/^@/, "");
        if (isSecretFilePath(cleaned, options?.nyxowlHome)) {
          return {
            decision: "deny",
            ruleId: "SEC_SECRET_PATH",
            reason: `Blocked command referencing protected secret or state path "${tok}". Use nyx_env_inspect instead.`,
          };
        }
      }
    }

    // 2. Check environment dump commands (§1.2.2)
    if (bin === "printenv") {
      return {
        decision: "deny",
        ruleId: "SEC_ENV_DUMP",
        reason: "Blocked printenv. Use nyx_env_inspect to check environment key shapes.",
      };
    }
    if (bin === "env" && args.length === 0) {
      return {
        decision: "deny",
        ruleId: "SEC_ENV_DUMP",
        reason: "Blocked bare `env` dump. Use nyx_env_inspect to check environment key shapes.",
      };
    }
    if (bin === "export" && (args.length === 0 || args.includes("-p"))) {
      return {
        decision: "deny",
        ruleId: "SEC_ENV_DUMP",
        reason: "Blocked `export -p` environment dump. Use nyx_env_inspect.",
      };
    }
    if (bin === "set" && args.length === 0) {
      return {
        decision: "deny",
        ruleId: "SEC_ENV_DUMP",
        reason: "Blocked bare `set` environment dump. Use nyx_env_inspect.",
      };
    }
    if (bin === "git" && args[0] === "config" && (args.includes("--list") || args.includes("-l"))) {
      return {
        decision: "deny",
        ruleId: "SEC_ENV_DUMP",
        reason: "Blocked `git config --list` credential/config dump.",
      };
    }
    if (bin === "gh" && args[0] === "auth" && args[1] === "token") {
      return {
        decision: "deny",
        ruleId: "SEC_ENV_DUMP",
        reason: "Blocked `gh auth token` secret token extraction.",
      };
    }

    // 3. Check Red-Line commands (§1.1.4)
    if (bin === "gh" && args[0] === "pr" && args[1] === "merge") {
      return {
        decision: "deny",
        ruleId: "REDLINE_PR_MERGE",
        reason: "Red Line: Nyxowl never merges pull requests (`gh pr merge`). Human review and merge required.",
      };
    }
    if (bin === "git" && args[0] === "push") {
      const hasForce = args.includes("--force") || args.includes("-f") || args.includes("--force-with-lease");
      const targetsProtected = args.some((a) =>
        ["main", "master", "production", "origin/main", "origin/master"].includes(a.toLowerCase()),
      );
      if (hasForce || targetsProtected) {
        return {
          decision: "deny",
          ruleId: "REDLINE_GIT_PUSH",
          reason:
            "Red Line: Direct push or force-push to protected branches (main/master/production) is forbidden. Push feature worktrees via nyx_worktree_pr.",
        };
      }
    }
    if (
      ((bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "cargo") &&
        args[0] === "publish") ||
      (bin === "twine" && args[0] === "upload") ||
      (bin === "gem" && args[0] === "push") ||
      (bin === "docker" && args[0] === "push") ||
      (bin === "terraform" && (args[0] === "apply" || args[0] === "destroy")) ||
      (bin === "kubectl" && (args[0] === "apply" || args[0] === "delete")) ||
      (bin === "fly" && args[0] === "deploy") ||
      (bin === "vercel" && args.includes("--prod"))
    ) {
      return {
        decision: "deny",
        ruleId: "REDLINE_DEPLOY_PUBLISH",
        reason: `Red Line: Publishing or production deployment command "${bin} ${args[0] ?? ""}" requires explicit human execution.`,
      };
    }

    // 4. Check destructive commands (§8.6)
    if (bin === "sudo" || bin === "su") {
      return {
        decision: "deny",
        ruleId: "DESTRUCTIVE_SUDO",
        reason: "Blocked privilege escalation (`sudo`/`su`).",
      };
    }
    if (bin === "chmod" && args.includes("-R") && args.includes("777")) {
      return {
        decision: "deny",
        ruleId: "DESTRUCTIVE_CHMOD",
        reason: "Blocked `chmod -R 777`.",
      };
    }
    if (bin === "docker" && args[0] === "system" && args[1] === "prune") {
      return {
        decision: "deny",
        ruleId: "DESTRUCTIVE_DOCKER_PRUNE",
        reason: "Blocked `docker system prune`.",
      };
    }
    if (bin === "rm") {
      const hasRecursive = args.some((a) => a === "-rf" || a === "-fr" || a === "-r" || a === "-R");
      if (hasRecursive) {
        for (const arg of args) {
          if (arg.startsWith("-")) continue;
          if (
            arg === "/" ||
            arg === "/*" ||
            arg === "~" ||
            arg.startsWith("~/") ||
            arg === ".." ||
            arg.startsWith("../")
          ) {
            return {
              decision: "deny",
              ruleId: "DESTRUCTIVE_RM_RF",
              reason: `Blocked destructive recursive removal target "${arg}".`,
            };
          }
        }
      }
    }
    if (bin === "git") {
      const isResetHard = args[0] === "reset" && args.includes("--hard");
      const isCleanX =
        args[0] === "clean" && args.some((a) => a.startsWith("-") && a.includes("x"));
      if (isResetHard || isCleanX) {
        const cwdNorm = (options?.cwd ?? "").replace(/\\/g, "/");
        const inWorktree = cwdNorm.includes("/worktrees/");
        if (!inWorktree) {
          return {
            decision: "deny",
            ruleId: "DESTRUCTIVE_GIT_MAIN",
            reason:
              "Blocked destructive `git reset --hard` or `git clean -x` outside an isolated Nyxowl worktree. Use nyx_slice_rewind.",
          };
        }
      }
    }

    // 5. Check package installation commands without dep_guard approval (§1.3.3, §8.6)
    const installCheck = detectPackageInstallCommand(bin, args);
    if (installCheck && installCheck.packages.length > 0) {
      const projPath = options?.projectPath ?? process.env["NYXOWL_PROJECT"] ?? options?.cwd ?? process.cwd();
      for (const pkgSpec of installCheck.packages) {
        if (!isApprovedDependency(pkgSpec, installCheck.ecosystem, projPath, options?.nyxowlHome)) {
          return {
            decision: "deny",
            ruleId: "DEP_GUARD_UNAPPROVED",
            reason: `Blocked installation of unapproved package "${pkgSpec}" (${installCheck.ecosystem}). Run nyx_dep_guard first to verify registry existence, typosquatting, and OSV advisories.`,
          };
        }
      }
    }
  }

  return { decision: "allow" };
}

function detectPackageInstallCommand(
  bin: string,
  args: string[],
): { ecosystem: string; packages: string[] } | null {
  const nonFlagArgs = (startIdx: number) =>
    args.slice(startIdx).filter((a) => !a.startsWith("-"));

  if (bin === "npm" && (args[0] === "i" || args[0] === "install" || args[0] === "add")) {
    return { ecosystem: "npm", packages: nonFlagArgs(1) };
  }
  if ((bin === "pnpm" || bin === "yarn" || bin === "bun") && args[0] === "add") {
    return { ecosystem: "npm", packages: nonFlagArgs(1) };
  }
  if ((bin === "pip" || bin === "pip3") && args[0] === "install") {
    return {
      ecosystem: "pypi",
      packages: args
        .slice(1)
        .filter((a) => !a.startsWith("-") && a !== "." && !a.endsWith(".txt")),
    };
  }
  if ((bin === "uv" || bin === "poetry") && args[0] === "add") {
    return { ecosystem: "pypi", packages: nonFlagArgs(1) };
  }
  if (bin === "cargo" && args[0] === "add") {
    return { ecosystem: "crates", packages: nonFlagArgs(1) };
  }
  if (bin === "go" && args[0] === "get") {
    return { ecosystem: "go", packages: nonFlagArgs(1) };
  }
  if (bin === "gem" && args[0] === "install") {
    return { ecosystem: "rubygems", packages: nonFlagArgs(1) };
  }
  if (bin === "composer" && args[0] === "require") {
    return { ecosystem: "packagist", packages: nonFlagArgs(1) };
  }
  return null;
}

export function evaluateGuardPayload(
  payload: HookInputPayload,
  options?: {
    env?: NodeJS.ProcessEnv;
    nyxowlHome?: string;
  },
): GuardDecision | null {
  const env = options?.env ?? process.env;
  if (!isNyxowlSessionActive(payload, env)) {
    return null; // Self-scoped no-op outside Nyxowl sessions
  }

  const toolName = (payload.tool_name ?? "").toLowerCase();
  const toolInput = payload.tool_input ?? {};

  // 1. Check file read / grep / glob tools for secret paths
  const candidatePathKeys = [
    "file_path",
    "path",
    "target_file",
    "filePath",
    "directory",
    "pattern",
  ];
  for (const key of candidatePathKeys) {
    const val = toolInput[key];
    if (typeof val === "string" && isSecretFilePath(val, options?.nyxowlHome)) {
      return {
        decision: "deny",
        ruleId: "SEC_SECRET_PATH",
        reason: `Blocked reading protected secret/state path "${val}". Use nyx_env_inspect to inspect environment keys without exposing values.`,
      };
    }
  }

  // 2. Check shell / bash execution tools
  const cmdVal =
    toolInput["command"] ??
    toolInput["CommandLine"] ??
    toolInput["cmd"] ??
    toolInput["script"];
  if (
    typeof cmdVal === "string" ||
    toolName.includes("bash") ||
    toolName.includes("shell") ||
    toolName.includes("run_command") ||
    toolName.includes("exec")
  ) {
    if (typeof cmdVal === "string") {
      return evaluateShellCommandGuard(cmdVal, {
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
        ...(env["NYXOWL_PROJECT"] ? { projectPath: env["NYXOWL_PROJECT"] } : {}),
        ...(options?.nyxowlHome ? { nyxowlHome: options.nyxowlHome } : {}),
      });
    }
  }

  return { decision: "allow" };
}

export function formatHookOutput(decision: GuardDecision): string {
  const reason = decision.reason ?? "Permitted by Nyxowl guard.";
  // Unified response consumed by the OpenCode plugin (permissionDecision) and Nyxowl hooks.
  return JSON.stringify({
    decision: decision.decision === "deny" ? "deny" : "allow",
    reason,
    permissionDecision: decision.decision,
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      permissionDecisionReason: reason,
    },
  });
}

export async function runGuardCli(stdinText?: string): Promise<{
  exitCode: number;
  stdout: string;
}> {
  try {
    const raw =
      stdinText !== undefined ? stdinText : fs.readFileSync(0, "utf8");
    if (!raw.trim()) {
      return { exitCode: 0, stdout: "" };
    }
    const payload = JSON.parse(raw) as HookInputPayload;
    const decision = evaluateGuardPayload(payload);
    if (!decision) {
      // Outside Nyxowl session -> self-scoped no-op
      return { exitCode: 0, stdout: "" };
    }
    const stdout = formatHookOutput(decision);
    const exitCode =
      decision.decision === "deny" && process.env["NYXOWL_HOOK_EXIT_ON_DENY"] === "1"
        ? 2
        : 0;
    return { exitCode, stdout };
  } catch (err) {
    // Fail-safe (§8.6): a crashing guard DENIES when inside a Nyxowl session!
    if (process.env["NYXOWL_SESSION"] !== "1") {
      return { exitCode: 0, stdout: "" };
    }
    const failSafe: GuardDecision = {
      decision: "deny",
      ruleId: "FAIL_SAFE_GUARD_ERROR",
      reason: `Nyxowl guard fail-safe deny: ${(err as Error).message}`,
    };
    return {
      exitCode: process.env["NYXOWL_HOOK_EXIT_ON_DENY"] === "1" ? 2 : 0,
      stdout: formatHookOutput(failSafe),
    };
  }
}

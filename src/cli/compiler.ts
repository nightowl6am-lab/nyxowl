import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { NyxError } from "../core/errors.ts";
import { estimateTokens } from "../core/tokens.ts";
import { NYXOWL_VERSION } from "../core/version.ts";
import {
  agentSkillPath,
  loadAgentSkill,
  resolvePackageRoot,
} from "./skills.ts";

export const REQUIRED_AGENT_SECTIONS = [
  "Mission",
  "Inputs",
  "Procedure",
  "Hard Rules",
  "Done Criteria",
  "Output Format",
] as const;

export const ROLE_ALLOWED_NYX_TOOLS: Record<string, readonly string[]> = {
  nyxowl: [
    "context_hydrate",
    "task_handoff",
    "task_dispatch",
    "dna_extract",
    "dna_get",
    "env_doctor",
    "project_bootstrap",
    "worktree_start",
    "worktree_manage",
    "worktree_pr",
    "slice_checkpoint",
    "slice_rewind",
    "blackboard_read",
    "blackboard_publish",
    "env_inspect",
    "artifact_read",
    "testwriter_prepare",
    "testwriter_status",
  ],
  "nyx-product": [
    "web_fetch",
    "sanitize_untrusted",
    "docs_ground",
    "blackboard_read",
    "blackboard_publish",
    "artifact_read",
  ],
  "nyx-architect": [
    "dna_get",
    "symbol_skeleton",
    "trace_symbol",
    "seam_check",
    "pkg_verify",
    "blackboard_read",
    "blackboard_publish",
    "artifact_read",
  ],
  "nyx-designer": [
    "dna_get",
    "symbol_skeleton",
    "trace_symbol",
    "pkg_verify",
    "dep_guard",
    "blackboard_read",
    "lock_acquire",
    "lock_release",
    "slice_checkpoint",
    "slop_check",
    "verify_slice",
    "proc",
    "artifact_read",
  ],
  "nyx-ui": [
    "dna_get",
    "symbol_skeleton",
    "trace_symbol",
    "pkg_verify",
    "dep_guard",
    "blackboard_read",
    "lock_acquire",
    "lock_release",
    "slice_checkpoint",
    "slop_check",
    "verify_slice",
    "proc",
    "artifact_read",
  ],
  "nyx-db": [
    "dna_get",
    "symbol_skeleton",
    "trace_symbol",
    "pkg_verify",
    "dep_guard",
    "blackboard_read",
    "blackboard_publish",
    "lock_acquire",
    "lock_release",
    "slice_checkpoint",
    "verify_slice",
    "debug_isolate",
    "proc",
    "env_inspect",
    "seam_check",
    "artifact_read",
  ],
  "nyx-api": [
    "dna_get",
    "symbol_skeleton",
    "trace_symbol",
    "pkg_verify",
    "dep_guard",
    "blackboard_read",
    "blackboard_publish",
    "lock_acquire",
    "lock_release",
    "slice_checkpoint",
    "verify_slice",
    "debug_isolate",
    "proc",
    "env_inspect",
    "seam_check",
    "artifact_read",
  ],
  "nyx-sec": [
    "exploit_probe",
    "proc",
    "env_inspect",
    "dep_guard",
    "symbol_skeleton",
    "trace_symbol",
    "blackboard_read",
    "blackboard_publish",
    "artifact_read",
  ],
  "nyx-probe": [
    "debug_isolate",
    "verify_slice",
    "proc",
    "symbol_skeleton",
    "trace_symbol",
    "slice_checkpoint",
    "slice_rewind",
    "artifact_read",
  ],
  "nyx-devops": [
    "worktree_manage",
    "verify_slice",
    "env_inspect",
    "dep_guard",
    "proc",
    "blackboard_read",
    "artifact_read",
  ],
  "nyx-testwriter": [
    "testwriter_job",
    "testwriter_write",
    "testwriter_lint",
    "testwriter_gate",
    "testwriter_finish",
  ],
};

export const agentContractSchema = z.object({
  id: z.string().regex(/^nyx(owl|-[a-z]+)$/),
  title: z.string().min(3).max(100),
  mode: z.enum(["primary", "subagent"]),
  description: z.string().min(10).max(200),
  model: z.union([z.string(), z.record(z.string(), z.string())]),
  host_tools: z.object({
    read: z.enum(["allow", "deny"]),
    edit: z.enum(["worktree", "tests", "deny"]),
    write: z.enum(["worktree", "tests", "deny"]),
    bash: z.enum(["worktree", "ask_redline", "deny"]),
    webfetch: z.literal("deny"),
  }),
  nyx_tools: z.array(z.string()),
  skills: z.literal("local"),
  output_contract: z.enum(["orchestrator-report-v1", "subagent-summary-v1"]),
});

export type AgentContractFrontmatter = z.infer<typeof agentContractSchema>;

export interface CompiledAgentIR {
  contract: AgentContractFrontmatter;
  bodyMarkdown: string;
  compiledPrompt: string;
  tokenCount: number;
  skillPath: string;
  skillLoaded: boolean;
  sourceFile: string;
}

export interface CompiledCommandIR {
  name: string;
  description: string;
  bodyMarkdown: string;
  sourceFile: string;
}

export interface CompiledBundleIR {
  agents: CompiledAgentIR[];
  commands: CompiledCommandIR[];
}

function splitMarkdownFrontmatter(raw: string, filePath: string): {
  frontmatterRaw: string;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new NyxError("ERR_CONFIG_INVALID", `Missing YAML frontmatter in ${filePath}`);
  }
  return { frontmatterRaw: match[1], body: match[2].trim() };
}

export function parseAndCompileAgentFile(options: {
  filePath: string;
  maxPromptTokens?: number;
  pkgRoot?: string;
}): CompiledAgentIR {
  const maxPromptTokens = options.maxPromptTokens ?? 1200;
  const raw = fs.readFileSync(options.filePath, "utf8");
  const { frontmatterRaw, body } = splitMarkdownFrontmatter(raw, options.filePath);

  const parsedYaml = YAML.parse(frontmatterRaw) as unknown;
  const parsedContract = agentContractSchema.safeParse(parsedYaml);
  if (!parsedContract.success) {
    throw new NyxError(
      "ERR_CONFIG_INVALID",
      `Invalid agent frontmatter in ${options.filePath}: ${parsedContract.error.message}`,
    );
  }
  const contract = parsedContract.data;

  // Validate required body sections (§4.2)
  for (const section of REQUIRED_AGENT_SECTIONS) {
    const regex = new RegExp(`^##\\s+${section}\\b`, "m");
    if (!regex.test(body)) {
      throw new NyxError(
        "ERR_CONFIG_INVALID",
        `Agent ${contract.id} (${options.filePath}) is missing required section "## ${section}"`,
      );
    }
  }

  // Validate per-role MCP tool scoping (§4.4)
  const allowedTools = ROLE_ALLOWED_NYX_TOOLS[contract.id];
  if (!allowedTools) {
    throw new NyxError(
      "ERR_CONFIG_INVALID",
      `Agent ${contract.id} is not in ROLE_ALLOWED_NYX_TOOLS (§4.4)`,
    );
  }
  const allowedSet = new Set(allowedTools);
  for (const t of contract.nyx_tools) {
    if (!allowedSet.has(t)) {
      throw new NyxError(
        "ERR_CONFIG_INVALID",
        `Agent ${contract.id} requests unauthorized nyx_tool "${t}" (not allowed by §4.4)`,
      );
    }
  }
  for (const expected of allowedTools) {
    if (!contract.nyx_tools.includes(expected)) {
      throw new NyxError(
        "ERR_CONFIG_INVALID",
        `Agent ${contract.id} is missing required nyx_tool "${expected}" per §4.4`,
      );
    }
  }

  const pkgRoot = options.pkgRoot ?? resolvePackageRoot();
  const skillPath = agentSkillPath(contract.id, pkgRoot);
  const skillContent = loadAgentSkill(contract.id, pkgRoot);

  const compiledPrompt = skillContent
    ? `${body}\n\n## Agent Skill\n${skillContent}\n`
    : body;
  const tokenCount = estimateTokens(compiledPrompt);
  if (tokenCount > maxPromptTokens) {
    throw new NyxError(
      "ERR_BUDGET_EXCEEDED",
      `Compiled prompt for ${contract.id} exceeds budget (${tokenCount} tokens > ${maxPromptTokens} max)`,
    );
  }

  return {
    contract,
    bodyMarkdown: body,
    compiledPrompt,
    tokenCount,
    skillPath,
    skillLoaded: skillContent !== null,
    sourceFile: options.filePath,
  };
}

export function compileAllAgentsAndCommands(options?: {
  maxPromptTokens?: number;
  pkgRoot?: string;
}): CompiledBundleIR {
  const pkgRoot = options?.pkgRoot ?? resolvePackageRoot();
  const primaryPath = path.join(pkgRoot, "agents", "primary", "nyxowl.md");
  const subagentsDir = path.join(pkgRoot, "agents", "subagents");
  const commandsDir = path.join(pkgRoot, "agents", "commands");

  const agentFiles: string[] = [primaryPath];
  if (fs.existsSync(subagentsDir)) {
    const subFiles = fs
      .readdirSync(subagentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => path.join(subagentsDir, f));
    agentFiles.push(...subFiles);
  }

  const agents: CompiledAgentIR[] = [];

  for (const filePath of agentFiles) {
    const compiled = parseAndCompileAgentFile({
      filePath,
      ...(options?.maxPromptTokens !== undefined
        ? { maxPromptTokens: options.maxPromptTokens }
        : {}),
      pkgRoot,
    });
    agents.push(compiled);
  }

  const commands: CompiledCommandIR[] = [];
  if (fs.existsSync(commandsDir)) {
    const cmdFiles = fs
      .readdirSync(commandsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of cmdFiles) {
      const fullPath = path.join(commandsDir, f);
      const raw = fs.readFileSync(fullPath, "utf8");
      const { frontmatterRaw, body } = splitMarkdownFrontmatter(raw, fullPath);
      const parsed = YAML.parse(frontmatterRaw) as { name?: string; description?: string };
      if (!parsed?.name || !parsed?.description) {
        throw new NyxError("ERR_CONFIG_INVALID", `Invalid command frontmatter in ${fullPath}`);
      }
      commands.push({
        name: parsed.name,
        description: parsed.description,
        bodyMarkdown: body,
        sourceFile: fullPath,
      });
    }
  }

  return {
    agents,
    commands,
  };
}

/**
 * Generates the compact <= 300-token generic nyx_* AGENTS.md managed block (§8.5, §12).
 */
export function buildProjectAgentsBlock(): string {
  const block = [
    "<!-- nyxowl:begin -->",
    `# Nyxowl Orchestrator Rules (generated by nyxowl v${NYXOWL_VERSION})`,
    "- Start every session with `nyx_context_hydrate` and `nyx_dna_get`.",
    "- Never edit the main checkout directly; create an isolated worktree via `nyx_worktree_start`.",
    "- Never read `.env*` secret values; inspect environment keys only via `nyx_env_inspect`.",
    "- Never install dependencies without `nyx_dep_guard` approval.",
    "- Execute roles sequentially (`nyx-product` -> `nyx-architect` -> `nyx-db`/`nyx-api`/`nyx-ui` -> `nyx-sec`/`nyx-probe`), emitting `subagent-summary-v1` JSON on each role switch.",
    "- Checkpoint slices via `nyx_slice_checkpoint`, verify via `nyx_verify_slice`, `nyx_slop_check`, `nyx_seam_check`, and `nyx_exploit_probe`.",
    "- Open PRs via `nyx_worktree_pr`; never run `gh pr merge` without explicit human approval.",
    "<!-- nyxowl:end -->",
  ].join("\n");

  const tokens = estimateTokens(block);
  if (tokens > 300) {
    throw new NyxError(
      "ERR_BUDGET_EXCEEDED",
      `AGENTS.md managed block exceeds 300-token budget (${tokens} tokens)`,
    );
  }
  return block;
}

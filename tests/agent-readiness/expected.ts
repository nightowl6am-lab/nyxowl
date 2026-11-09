/**
 * Canonical expectations for the all-agent readiness matrix.
 * Order is the documented role sequence, not directory order.
 */

export interface ExpectedHostTools {
  read: "allow" | "deny";
  edit: "worktree" | "tests" | "deny";
  write: "worktree" | "tests" | "deny";
  bash: "worktree" | "ask_redline" | "deny";
  webfetch: "deny";
}

export interface ExpectedAgent {
  id: string;
  mode: "primary" | "subagent";
  outputContract: "orchestrator-report-v1" | "subagent-summary-v1";
  hostTools: ExpectedHostTools;
}

const READ_ONLY = {
  read: "allow",
  edit: "deny",
  write: "deny",
  bash: "deny",
  webfetch: "deny",
} as const satisfies ExpectedHostTools;

const WRITE_WORKTREE = {
  read: "allow",
  edit: "worktree",
  write: "worktree",
  bash: "worktree",
  webfetch: "deny",
} as const satisfies ExpectedHostTools;

const TESTS_ONLY = {
  read: "allow",
  edit: "tests",
  write: "tests",
  bash: "deny",
  webfetch: "deny",
} as const satisfies ExpectedHostTools;

const FULLY_ISOLATED = {
  read: "deny",
  edit: "deny",
  write: "deny",
  bash: "deny",
  webfetch: "deny",
} as const satisfies ExpectedHostTools;

export const EXPECTED_AGENTS: readonly ExpectedAgent[] = [
  {
    id: "nyxowl",
    mode: "primary",
    outputContract: "orchestrator-report-v1",
    hostTools: {
      read: "allow",
      edit: "worktree",
      write: "worktree",
      bash: "ask_redline",
      webfetch: "deny",
    },
  },
  {
    id: "nyx-product",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: READ_ONLY,
  },
  {
    id: "nyx-architect",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: READ_ONLY,
  },
  {
    id: "nyx-designer",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: WRITE_WORKTREE,
  },
  {
    id: "nyx-db",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: WRITE_WORKTREE,
  },
  {
    id: "nyx-api",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: WRITE_WORKTREE,
  },
  {
    id: "nyx-ui",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: WRITE_WORKTREE,
  },
  {
    id: "nyx-sec",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: TESTS_ONLY,
  },
  {
    id: "nyx-testwriter",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: FULLY_ISOLATED,
  },
  {
    id: "nyx-probe",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: {
      read: "allow",
      edit: "tests",
      write: "tests",
      bash: "worktree",
      webfetch: "deny",
    },
  },
  {
    id: "nyx-devops",
    mode: "subagent",
    outputContract: "subagent-summary-v1",
    hostTools: {
      read: "allow",
      edit: "worktree",
      write: "worktree",
      bash: "ask_redline",
      webfetch: "deny",
    },
  },
];

export const EXPECTED_COMMANDS: readonly string[] = [
  "nyx-audit",
  "nyx-handoff",
  "nyx-research",
  "nyx-rewind",
  "nyx-ship",
  "nyx-status",
];

/** The full canonical MCP tool inventory: 39 names, stable order (server.ts order). */
export const EXPECTED_NYX_TOOL_NAMES: readonly string[] = [
  "model_preflight",
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
  "web_fetch",
  "sanitize_untrusted",
  "docs_ground",
  "symbol_skeleton",
  "trace_symbol",
  "seam_check",
  "pkg_verify",
  "dep_guard",
  "lock_acquire",
  "lock_release",
  "slop_check",
  "verify_slice",
  "proc",
  "exploit_probe",
  "debug_isolate",
  "testwriter_job",
  "testwriter_write",
  "testwriter_lint",
  "testwriter_gate",
  "testwriter_finish",
];

function hostToolsFor(agent: ExpectedAgent): string[] {
  if (agent.id === "nyx-testwriter") return [];
  const tools: string[] = [];
  if (agent.hostTools.read === "allow") tools.push("read", "glob", "grep");
  if (agent.hostTools.edit !== "deny") tools.push("edit");
  if (agent.hostTools.write !== "deny") tools.push("write");
  if (agent.hostTools.bash !== "deny") tools.push("shell");
  tools.push("skill", "todowrite");
  return tools;
}

/** Host tool names a live round may observe for each agent. */
export const EXPECTED_HOST_TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(EXPECTED_AGENTS.map((agent) => [agent.id, hostToolsFor(agent)]));

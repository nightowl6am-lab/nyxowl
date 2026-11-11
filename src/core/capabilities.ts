import { ROLE_ALLOWED_NYX_TOOLS } from "../cli/compiler.ts";

/**
 * Machine-readable capability flags for a Nyxowl tool.
 *
 * The orchestrator must never plan around an ability that the tool does not
 * declare. Every registered MCP tool therefore has exactly one manifest entry,
 * and `nyx_task_dispatch` returns the entries for the tools the target role may
 * call. A missing entry is a defect (see `missingCapabilityEntries`).
 */
export const CAPABILITY_FLAG_NAMES = [
  "executeCommands",
  "browserControl",
  "authenticatedProbing",
  "customHeaders",
  "multiServiceProbe",
  "writeAccess",
  "networkEgress",
] as const;

export type CapabilityFlag = (typeof CAPABILITY_FLAG_NAMES)[number];
export type CapabilityFlags = Record<CapabilityFlag, boolean>;

export interface ToolCapability extends CapabilityFlags {
  /** Fully qualified MCP tool name (`nyx_...`). */
  tool: string;
  /** Exact reasons the tool cannot do more than its flags claim. */
  limitations: string[];
}

const NO_CAPABILITIES: CapabilityFlags = {
  executeCommands: false,
  browserControl: false,
  authenticatedProbing: false,
  customHeaders: false,
  multiServiceProbe: false,
  writeAccess: false,
  networkEgress: false,
};

interface CapabilitySpec {
  flags?: Partial<CapabilityFlags>;
  limitations?: string[];
}

/**
 * The single source of truth for tool capabilities. Keys are canonical tool
 * basenames (no `nyx_` prefix). Keep this registry in sync with `ALL_NYX_TOOLS`;
 * the drift test fails when a tool is registered without an entry.
 */
const TOOL_CAPABILITY_SPECS: Readonly<Record<string, CapabilitySpec>> = {
  model_preflight: {},
  context_hydrate: {},
  task_handoff: { flags: { writeAccess: true } },
  task_dispatch: {},
  dna_extract: { flags: { writeAccess: true } },
  dna_get: {},
  env_doctor: { flags: { executeCommands: true } },
  project_bootstrap: { flags: { executeCommands: true, writeAccess: true } },
  worktree_start: { flags: { executeCommands: true, writeAccess: true } },
  worktree_manage: { flags: { executeCommands: true, writeAccess: true } },
  worktree_pr: {
    flags: { executeCommands: true, writeAccess: true, networkEgress: true },
    limitations: ["publishes only through the configured Git remote / gh path"],
  },
  slice_checkpoint: { flags: { writeAccess: true } },
  slice_rewind: { flags: { writeAccess: true } },
  blackboard_read: {},
  blackboard_publish: { flags: { writeAccess: true } },
  env_inspect: {
    flags: { executeCommands: true },
    limitations: ["reports key presence and shape only; never reads secret values"],
  },
  artifact_read: {},
  testwriter_prepare: { flags: { writeAccess: true } },
  testwriter_status: {},
  web_fetch: {
    flags: { networkEgress: true },
    limitations: ["external GET only; no credentials; SSRF allow/deny lists apply"],
  },
  sanitize_untrusted: {},
  docs_ground: {
    flags: { networkEgress: true },
    limitations: ["external documentation fetch only"],
  },
  symbol_skeleton: {},
  trace_symbol: {},
  seam_check: {},
  pkg_verify: { flags: { executeCommands: true } },
  dep_guard: {
    flags: { networkEgress: true },
    limitations: ["queries public package registries; no project credentials"],
  },
  lock_acquire: { flags: { writeAccess: true } },
  lock_release: { flags: { writeAccess: true } },
  slop_check: {},
  verify_slice: {
    flags: { executeCommands: true },
    limitations: [
      "runs the project's configured code steps and e2e command; it does not drive a browser itself",
      "does not authenticate or add caller-supplied request headers",
    ],
  },
  proc: {
    flags: { executeCommands: true, writeAccess: true },
    limitations: ["starts and stops local loopback processes only"],
  },
  exploit_probe: {
    flags: { networkEgress: true },
    limitations: [
      "loopback targets only",
      "authenticated probing is not implemented; probes run unauthenticated and the receipt is partial",
      "request headers are fixed (Accept/Content-Type); no caller-supplied auth headers",
      "single target origin; no multi-service probes",
    ],
  },
  debug_isolate: {},
  testwriter_job: { flags: { executeCommands: true, writeAccess: true } },
  testwriter_write: { flags: { writeAccess: true } },
  testwriter_lint: {},
  testwriter_gate: { flags: { executeCommands: true } },
  testwriter_finish: { flags: { writeAccess: true } },
};

function bareToolName(toolName: string): string {
  return toolName.startsWith("nyx_") ? toolName.slice("nyx_".length) : toolName;
}

function buildCapability(bareName: string, spec: CapabilitySpec): ToolCapability {
  return {
    tool: `nyx_${bareName}`,
    ...NO_CAPABILITIES,
    ...(spec.flags ?? {}),
    limitations: [...(spec.limitations ?? [])],
  };
}

/** Capability manifest keyed by canonical tool basename. */
export const TOOL_CAPABILITIES: Readonly<Record<string, ToolCapability>> = Object.fromEntries(
  Object.entries(TOOL_CAPABILITY_SPECS).map(([name, spec]) => [name, buildCapability(name, spec)]),
);

export function getToolCapability(toolName: string): ToolCapability | null {
  return TOOL_CAPABILITIES[bareToolName(toolName)] ?? null;
}

/**
 * Tools a role is allowed to call, with their declared capabilities.
 * Unknown roles return an empty list (fail closed: no capability claim).
 */
export function getRoleCapabilities(role: string): ToolCapability[] {
  const allowed = ROLE_ALLOWED_NYX_TOOLS[role];
  if (!allowed) {
    return [];
  }
  return allowed
    .map((name) => getToolCapability(name))
    .filter((capability): capability is ToolCapability => capability !== null);
}

/**
 * Returns registered tool names that have no manifest entry. The MCP drift test
 * asserts this is empty, so a new tool cannot ship an undeclared capability.
 */
export function missingCapabilityEntries(registeredToolNames: readonly string[]): string[] {
  return registeredToolNames
    .filter((name) => getToolCapability(name) === null)
    .sort();
}

/** Declared capability limits for a tool, or a fail-closed explanation. */
export function toolCapabilityLimitations(toolName: string): string[] {
  const capability = getToolCapability(toolName);
  if (!capability) {
    return [`capability manifest has no entry for ${toolName}; treat every capability as unavailable`];
  }
  return capability.limitations;
}

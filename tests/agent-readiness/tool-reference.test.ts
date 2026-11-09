import { describe, expect, it } from "vitest";
import { compileAllAgentsAndCommands, type CompiledAgentIR } from "../../src/cli/compiler.ts";
import { loadAgentSkillPackage, stripFrontmatter } from "../../src/cli/skills.ts";

/**
 * The orchestrator delegates slice/evidence and lock operations to writer and
 * probe roles. These names may appear in its prose as descriptions of another
 * role's tool, but the orchestrator must never call them itself.
 */
const DELEGATED_TOOL_REFERENCES: Record<string, readonly string[]> = {
  nyxowl: [
    "nyx_verify_slice",
    "nyx_slop_check",
    "nyx_seam_check",
    "nyx_exploit_probe",
    "nyx_lock_acquire",
    "nyx_lock_release",
  ],
};

const TOOL_REFERENCE_RE = /`(nyx_[a-z0-9_]+)`/g;

function allowedToolSet(agent: CompiledAgentIR): Set<string> {
  return new Set(
    agent.contract.nyx_tools.map((tool) => (tool.startsWith("nyx_") ? tool : `nyx_${tool}`)),
  );
}

function findDisallowedToolReferences(
  text: string,
  allowed: ReadonlySet<string>,
  delegated: ReadonlySet<string>,
): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(TOOL_REFERENCE_RE)) {
    const name = match[1];
    if (name) refs.add(name);
  }
  return [...refs].filter((name) => !allowed.has(name) && !delegated.has(name)).sort();
}

describe("agent tool references", () => {
  const bundle = compileAllAgentsAndCommands();

  it("keeps every backticked nyx_* reference in the agent body inside its allowlist", () => {
    expect(bundle.agents).toHaveLength(11);
    for (const agent of bundle.agents) {
      const allowed = allowedToolSet(agent);
      const delegated = new Set(DELEGATED_TOOL_REFERENCES[agent.contract.id] ?? []);
      const disallowed = findDisallowedToolReferences(agent.bodyMarkdown, allowed, delegated);
      expect(
        disallowed,
        `${agent.contract.id} body references tools outside its allowlist: ${disallowed.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("keeps skill-package references allowlisted, except documented delegated role tools", () => {
    for (const agent of bundle.agents) {
      const pkg = loadAgentSkillPackage(agent.contract.id);
      expect(pkg.loaded, `${agent.contract.id} skill package`).toBe(true);
      const allowed = allowedToolSet(agent);
      const delegated = new Set(DELEGATED_TOOL_REFERENCES[agent.contract.id] ?? []);
      const skillBody = stripFrontmatter(pkg.skillContent ?? "");
      const disallowed = findDisallowedToolReferences(skillBody, allowed, delegated);
      expect(
        disallowed,
        `${agent.contract.id} skill references tools outside its allowlist: ${disallowed.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("would catch the product nyx_dna_get regression", () => {
    const product = bundle.agents.find((agent) => agent.contract.id === "nyx-product");
    expect(product).toBeDefined();
    if (!product) return;
    const allowed = allowedToolSet(product);
    expect(allowed.has("nyx_dna_get")).toBe(false);
    expect(
      findDisallowedToolReferences(
        "Read repository context with `nyx_dna_get` and `nyx_blackboard_read`.",
        allowed,
        new Set(),
      ),
    ).toEqual(["nyx_dna_get"]);
  });

  it("does not grant the orchestrator any delegated tool", () => {
    const nyxowl = bundle.agents.find((agent) => agent.contract.id === "nyxowl");
    expect(nyxowl).toBeDefined();
    if (!nyxowl) return;
    const allowed = allowedToolSet(nyxowl);
    for (const tool of DELEGATED_TOOL_REFERENCES["nyxowl"] ?? []) {
      expect(allowed.has(tool), `${tool} must be delegated, not owned`).toBe(false);
    }
  });
});

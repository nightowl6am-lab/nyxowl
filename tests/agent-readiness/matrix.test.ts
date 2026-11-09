import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_BUDGET_OVERRIDES,
  buildProjectAgentsBlock,
  compileAllAgentsAndCommands,
  NYX_MCP_TOOL_BASENAMES,
  REQUIRED_AGENT_SECTIONS,
  ROLE_ALLOWED_NYX_TOOLS,
} from "../../src/cli/compiler.ts";
import {
  AGENT_SKILL_IDS,
  AGENT_SKILL_MODES,
  agentSkillPath,
  loadAgentSkillPackage,
} from "../../src/cli/skills.ts";
import { estimateTokens } from "../../src/core/tokens.ts";
import { ALL_NYX_TOOLS } from "../../src/mcp/server.ts";
import {
  EXPECTED_AGENTS,
  EXPECTED_COMMANDS,
  EXPECTED_NYX_TOOL_NAMES,
  type ExpectedAgent,
} from "./expected.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKS_DIR = path.join(ROOT, "tests", "agent-readiness", "checks");
const BASE_DIR = path.join(ROOT, "tests", "agent-readiness", "base");
const FIXTURES_DIR = path.join(ROOT, "tests", "agent-readiness", "fixtures");

type CheckModule = Record<string, unknown>;
type OutputContractResult = { ok: boolean; errors: string[] };
type OutputContractModule = {
  validateOutputContract: (kind: string, value: unknown) => OutputContractResult;
};

interface AgentFixture {
  agent: string;
  contract: string;
  prompt: string;
  expectedNyTools: string[];
  forbiddenNyTools: string[];
  expectedArtifact: string;
  check: string;
  forbiddenHost: string[];
  artifactSchema: Record<string, unknown>;
}

async function loadModule(file: string): Promise<CheckModule> {
  return (await import(pathToFileURL(file).href)) as CheckModule;
}

async function loadCheck(name: string): Promise<CheckModule> {
  return loadModule(path.join(CHECKS_DIR, name));
}

function readBase(relativePath: string): string {
  return fs.readFileSync(path.join(BASE_DIR, relativePath), "utf8");
}

function readFixture(agentId: string): AgentFixture {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, `${agentId}.json`), "utf8"),
  ) as AgentFixture;
}

const bundle = compileAllAgentsAndCommands();
const agentById = new Map(bundle.agents.map((agent) => [agent.contract.id, agent]));

describe("agent readiness: contract matrix", () => {
  it("compiles exactly the 11 canonical agents with exact modes, contracts, and host tools", () => {
    expect(bundle.agents).toHaveLength(EXPECTED_AGENTS.length);
    for (const expected of EXPECTED_AGENTS) {
      const actual = agentById.get(expected.id);
      expect(actual, `missing agent ${expected.id}`).toBeDefined();
      if (!actual) continue;
      expect(actual.contract.mode, `${expected.id} mode`).toBe(expected.mode);
      expect(actual.contract.output_contract, `${expected.id} output contract`).toBe(
        expected.outputContract,
      );
      expect(actual.contract.host_tools, `${expected.id} host tools`).toEqual(expected.hostTools);
    }
  });

  it("keeps each role's nyx_tools exactly equal to the compiler allowlist", () => {
    for (const expected of EXPECTED_AGENTS) {
      const actual = agentById.get(expected.id);
      expect(actual, `missing agent ${expected.id}`).toBeDefined();
      if (!actual) continue;
      expect(actual.contract.nyx_tools, `${expected.id} nyx_tools`).toEqual([
        ...(ROLE_ALLOWED_NYX_TOOLS[expected.id] ?? []),
      ]);
    }
  });

  it("keeps native prompts under 1200 tokens and the inline testwriter under 6000", () => {
    for (const expected of EXPECTED_AGENTS) {
      const actual = agentById.get(expected.id);
      expect(actual, `missing agent ${expected.id}`).toBeDefined();
      if (!actual) continue;
      const budget =
        AGENT_BUDGET_OVERRIDES[expected.id] ??
        (actual.skillMode === "inline" ? 6000 : 1200);
      expect(actual.tokenCount, `${expected.id} token budget`).toBeLessThanOrEqual(budget);
      for (const section of REQUIRED_AGENT_SECTIONS) {
        expect(actual.bodyMarkdown, `${expected.id} section ${section}`).toMatch(
          new RegExp(`^##\\s+${section}\\b`, "m"),
        );
      }
      if (actual.skillMode === "native") {
        expect(actual.compiledPrompt.match(/^## Agent Skill$/gm)).toHaveLength(1);
        expect(actual.compiledPrompt).not.toContain("Trust boundary.");
      } else {
        expect(actual.compiledPrompt).toContain("Security Fix Test-Writer");
      }
    }
  });

  it("keeps every prompt body to the six-section professional contract", () => {
    const delegated = new Set([
      "nyx_verify_slice",
      "nyx_slop_check",
      "nyx_seam_check",
      "nyx_exploit_probe",
      "nyx_lock_acquire",
      "nyx_lock_release",
    ]);

    for (const expected of EXPECTED_AGENTS) {
      const actual = agentById.get(expected.id);
      expect(actual, `missing agent ${expected.id}`).toBeDefined();
      if (!actual) continue;
      const body = actual.bodyMarkdown;
      const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]?.trim());
      expect(headings, `${expected.id} headings`).toEqual([...REQUIRED_AGENT_SECTIONS]);

      const section = (name: string): string => {
        const start = body.indexOf(`## ${name}`);
        expect(start, `${expected.id} ${name}`).toBeGreaterThanOrEqual(0);
        const next = body.indexOf("\n## ", start + 1);
        return body.slice(start, next === -1 ? undefined : next);
      };

      expect(section("Mission"), `${expected.id} non-goals`).toMatch(/Non-goals:/);

      const steps = [...section("Procedure").matchAll(/^\d+\.\s+(.+)$/gm)].map(
        (match) => match[1] ?? "",
      );
      expect(steps.length, `${expected.id} procedure steps`).toBeGreaterThan(0);
      expect(steps.length, `${expected.id} procedure steps`).toBeLessThanOrEqual(7);
      const allowed = new Set(
        (ROLE_ALLOWED_NYX_TOOLS[expected.id] ?? []).map((tool) =>
          tool.startsWith("nyx_") ? tool : `nyx_${tool}`,
        ),
      );
      for (const step of steps) {
        const refs = [...step.matchAll(/`(nyx_[a-z0-9_]+)`/g)].map((match) => match[1] ?? "");
        expect(refs.length, `${expected.id} step must name a tool`).toBeGreaterThan(0);
        for (const ref of refs) {
          const permitted = allowed.has(ref) || (expected.id === "nyxowl" && delegated.has(ref));
          expect(permitted, `${expected.id} step references ${ref}`).toBe(true);
        }
      }

      const hardRules = section("Hard Rules");
      expect(hardRules, `${expected.id} no questions`).toContain("Do not ask questions");
      expect(hardRules, `${expected.id} blocked decision`).toMatch(/BLOCKED|SPEC_INSUFFICIENT/);
      expect(hardRules, `${expected.id} untrusted inputs`).toMatch(/untrusted/i);
      expect(hardRules, `${expected.id} test integrity`).toMatch(/weaken, skip, or delete tests/);
      expect(section("Done Criteria"), `${expected.id} evidence bound`).toMatch(
        /GREEN|receipt|grader/i,
      );
    }
  });

  it("enforces output-contract and dispatch-contract wording in every prompt", () => {
    const subagents = EXPECTED_AGENTS.filter((expected) => expected.mode === "subagent");
    expect(subagents).toHaveLength(10);

    for (const expected of subagents) {
      const actual = agentById.get(expected.id);
      expect(actual, `missing agent ${expected.id}`).toBeDefined();
      if (!actual) continue;
      expect(actual.bodyMarkdown, `${expected.id} parse contract`).toContain(
        "it must parse",
      );
      expect(actual.bodyMarkdown, `${expected.id} receipts shape`).toContain(
        "`receipts` is `{id, status}` only",
      );
      expect(actual.bodyMarkdown, `${expected.id} array fields`).toContain(
        "`filesChanged` and `openIssues` are arrays",
      );
      expect(actual.bodyMarkdown, `${expected.id} contracts shape`).toContain(
        "`contractsPublished` is a string array",
      );
      expect(actual.bodyMarkdown, `${expected.id} human sentence`).toContain(
        "one short human sentence",
      );
    }

    for (const agent of bundle.agents) {
      expect(agent.bodyMarkdown, `${agent.contract.id} lean prompt`).not.toContain("Self-check");
    }

    const architect = agentById.get("nyx-architect")?.bodyMarkdown ?? "";
    expect(architect).toContain("Never set `promote: true`");
    expect(architect).toMatch(/`slices`/);
    expect(architect).toMatch(/`endpoints`/);

    const product = agentById.get("nyx-product")?.bodyMarkdown ?? "";
    expect(product).toMatch(/do not fetch the web/);
    expect(product).toMatch(/local repository|docs-only/);

    const nyxowl = agentById.get("nyxowl")?.bodyMarkdown ?? "";
    expect(nyxowl).toMatch(/malformed/);
    expect(nyxowl).toMatch(/re-dispatch/);
    expect(nyxowl).toMatch(/docs-only/);
    expect(nyxowl).toContain("human summary");
    expect(nyxowl).toContain("0-command");
    expect(nyxowl).toContain("copy 0-command");
    expect(nyxowl).toContain("GREEN but limited");
    expect(nyxowl).toContain("never 'full coverage'");
    expect(nyxowl).toContain("no Git remote");
    expect(nyxowl).toContain("it must parse");
    expect(nyxowl).toContain("`slicesCompleted` is an array of strings");
    expect(nyxowl).toContain("`receipts` is an array of `{id, status}` objects only");
    expect(nyxowl).toContain("`prUrlOrPath` is never null");
    expect(nyxowl).toContain("`nyx_worktree_pr` requires all four receipts");
    expect(nyxowl).toContain("Do not call gate tools yourself");

    for (const gateOwner of [
      "nyx-architect",
      "nyx-api",
      "nyx-db",
      "nyx-ui",
      "nyx-designer",
      "nyx-sec",
      "nyx-probe",
    ]) {
      const body = agentById.get(gateOwner)?.bodyMarkdown ?? "";
      expect(body, `${gateOwner} gate-only dispatch`).toContain("If dispatched only for the");
    }

    expect(nyxowl).toContain("empty folder");
    expect(nyxowl).toContain("`nyx_project_bootstrap`");
    expect(nyxowl).toContain("createInitialWorktree");
    expect(nyxowl).toContain("Dispatch a subagent only when");
    expect(nyxowl).toContain("Never invent");
    expect(nyxowl).toContain("Run independent, disjoint work in parallel");
    expect(nyxowl.toLowerCase()).toContain("skip");

    const doneStart = nyxowl.indexOf("## Done Criteria");
    expect(doneStart, "nyxowl done criteria section").toBeGreaterThanOrEqual(0);
    const doneCriteria = nyxowl.slice(doneStart, nyxowl.indexOf("## Output Format"));
    expect(doneCriteria).toContain("GREEN or justified NA");

    const nyxowlSkill = loadAgentSkillPackage("nyxowl").skillContent ?? "";
    expect(nyxowlSkill).toContain("Starting from an Empty Folder");
    expect(nyxowlSkill).toContain("Gate Ownership and Dispatch Economy");
    expect(nyxowlSkill).toContain("Focus, Evidence, and Token Discipline");
    expect(nyxowlSkill).toContain("## Parallel Dispatch");
    expect(nyxowlSkill).toContain("Dispatch decision");
    expect(nyxowlSkill).toContain("## Output and Reporting");
    expect(nyxowlSkill).toContain("vacuous");
    expect(nyxowlSkill).toContain("GREEN but limited");
    expect(nyxowlSkill).toContain("Carry every `openIssues` caveat");
    expect(nyxowlSkill).toContain("local PR body path");
    expect(nyxowlSkill).toContain("local PR");
    expect(nyxowlSkill).toContain('"slicesCompleted":[');
    expect(nyxowlSkill).toContain('"receipts":[{"id');

    for (const expected of subagents) {
      const body = agentById.get(expected.id)?.bodyMarkdown ?? "";
      expect(body, `${expected.id} anti-hallucination`).toContain(
        "Use only tool results as facts",
      );
      expect(body, `${expected.id} caveat propagation`).toContain(
        "put that exact caveat in `openIssues`",
      );
      expect(body, `${expected.id} no full coverage claim`).toContain(
        "never call it full coverage",
      );
    }
  });

  it("keeps every skill package loaded with a mode, references, and license", () => {
    expect(AGENT_SKILL_IDS).toHaveLength(11);
    let native = 0;
    let inline = 0;
    for (const agentId of AGENT_SKILL_IDS) {
      const actual = agentById.get(agentId);
      expect(actual, `missing agent ${agentId}`).toBeDefined();
      if (!actual) continue;
      expect(actual.skillLoaded, `${agentId} skillLoaded`).toBe(true);
      expect(actual.skillMode, `${agentId} skillMode`).toBe(AGENT_SKILL_MODES[agentId]);
      if (actual.skillMode === "native") native += 1;
      else inline += 1;
      const pkg = loadAgentSkillPackage(agentId);
      expect(pkg.loaded, `${agentId} package loaded`).toBe(true);
      expect(pkg.licensePresent, `${agentId} license`).toBe(true);
      expect(pkg.references.length, `${agentId} references`).toBeGreaterThan(0);
      const stat = fs.statSync(agentSkillPath(agentId));
      expect(stat.size, `${agentId} SKILL.md size`).toBeGreaterThan(0);
    }
    expect(native).toBe(10);
    expect(inline).toBe(1);
  });

  it("exposes exactly the six canonical command names", () => {
    expect(bundle.commands.map((command) => command.name)).toEqual([...EXPECTED_COMMANDS]);
  });

  it("pins the full 38-tool inventory with valid descriptions and JSON-object schemas", () => {
    const actualNames = ALL_NYX_TOOLS.map((tool) => tool.name).map((name) =>
      name.startsWith("nyx_") ? name.slice("nyx_".length) : name,
    );
    expect(actualNames).toHaveLength(38);
    expect(new Set(actualNames).size).toBe(38);
    expect([...actualNames].sort()).toEqual([...EXPECTED_NYX_TOOL_NAMES].sort());
    expect([...NYX_MCP_TOOL_BASENAMES].sort()).toEqual([...actualNames].sort());
    for (const tool of ALL_NYX_TOOLS) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(0);
      expect(tool.description.length, `${tool.name} description`).toBeLessThanOrEqual(200);
      expect(z.toJSONSchema(tool.inputSchema).type, `${tool.name} input schema`).toBe("object");
      expect(z.toJSONSchema(tool.outputSchema).type, `${tool.name} output schema`).toBe("object");
    }
  });

  it("keeps the generated AGENTS.md block within 300 tokens", () => {
    expect(estimateTokens(buildProjectAgentsBlock())).toBeLessThanOrEqual(300);
  });

  it("references only tools that exist in the MCP server", () => {
    const known = new Set(ALL_NYX_TOOLS.map((tool) => tool.name));
    for (const agent of bundle.agents) {
      for (const tool of agent.contract.nyx_tools) {
        const fullName = tool.startsWith("nyx_") ? tool : `nyx_${tool}`;
        expect(known.has(fullName), `${agent.contract.id} references ${fullName}`).toBe(true);
      }
    }
  });
});

describe("agent readiness: fixtures and checks", () => {
  it("provides a valid bounded fixture for every agent", () => {
    for (const expected of EXPECTED_AGENTS) {
      const fixture = readFixture(expected.id);
      expect(fixture.agent).toBe(expected.id);
      expect(fixture.contract).toBe(expected.outputContract);
      expect(fixture.prompt.length).toBeGreaterThan(40);
      expect(fixture.prompt).not.toMatch(/https?:\/\//);
      expect(fixture.expectedNyTools.length).toBeGreaterThan(0);
      expect(fixture.expectedArtifact).toBeTruthy();
      expect(fixture.check).toMatch(/\.check\.mjs$/);
      expect(fs.existsSync(path.join(CHECKS_DIR, fixture.check)), fixture.check).toBe(true);
      expect(fixture.artifactSchema).toBeTypeOf("object");
      const allowed = new Set(ROLE_ALLOWED_NYX_TOOLS[expected.id] ?? []);
      for (const tool of fixture.expectedNyTools) {
        expect(allowed.has(tool), `${expected.id} expected tool ${tool}`).toBe(true);
      }
      for (const tool of fixture.forbiddenNyTools) {
        expect(allowed.has(tool), `${expected.id} forbidden tool ${tool}`).toBe(false);
      }
      expect(fixture.forbiddenHost).toContain("webfetch");
      expect(fixture.forbiddenHost).toContain("websearch");
    }
  });

  it("rls check detects disabled RLS and tautological policies", async () => {
    const mod = await loadCheck("rls.check.mjs");
    const audit = mod["auditRls"] as (sql: string) => Array<{ code: string }>;
    const findings = audit(readBase("migrations/001_init.sql"));
    expect(findings.map((finding) => finding.code)).toContain("RLS_DISABLED");
    expect(findings.map((finding) => finding.code)).toContain("TAUTOLOGICAL_POLICY");
    expect(
      audit(
        "create table a (id int); alter table a enable row level security; create policy p on a using (owner_id = auth.uid());",
      ),
    ).toEqual([]);
  });

  it("wcag check rejects #777777 on #ffffff and accepts #000000 on #ffffff", async () => {
    const mod = await loadCheck("wcag.check.mjs");
    const ratio = mod["contrastRatio"] as (fg: string, bg: string) => number;
    const evaluate = mod["evaluateTokenPairs"] as (
      pairs: Array<{ fg: string; bg: string }>,
    ) => Array<{ code: string }>;
    expect(ratio("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(ratio("#777777", "#ffffff")).toBeCloseTo(4.47, 1);
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(evaluate([{ fg: "#777777", bg: "#ffffff" }])).toHaveLength(1);
    expect(evaluate([{ fg: "#000000", bg: "#ffffff" }])).toEqual([]);
  });

  it("secretscan check detects only the inert patterns", async () => {
    const mod = await loadCheck("secretscan.check.mjs");
    const scan = mod["scanSecrets"] as (text: string) => Array<{ code: string }>;
    expect(scan(readBase("fixtures/canary.txt")).map((finding) => finding.code)).toContain(
      "NYX_SEC_CANARY",
    );
    expect(scan("The invoice total is 42 dollars.")).toEqual([]);
  });

  it("secretscan run requires both the canary and authz findings", async () => {
    const mod = await loadCheck("secretscan.check.mjs");
    const run = mod["run"] as (artifact: unknown) => OutputContractResult;
    const both = {
      findings: [
        { code: "NYX_SEC_CANARY" },
        { code: "AUTHZ_MISSING_OWNER_SCOPE" },
      ],
    };
    expect(run(both).ok).toBe(true);
    expect(run({ findings: [{ code: "NYX_SEC_CANARY" }] }).ok).toBe(false);
  });

  it("api-authz check flags an unscoped /:id route", async () => {
    const mod = await loadCheck("api-authz.check.mjs");
    const audit = mod["auditRoutes"] as (source: string) => Array<{ code: string }>;
    expect(audit(readBase("src/routes.ts")).map((finding) => finding.code)).toContain(
      "AUTHZ_MISSING_OWNER_SCOPE",
    );
    expect(
      audit(
        'router.get("/invoices/:id", async (req, res) => {\n  const invoice = await db.find(req.params.id, req.user.id);\n  res.json(invoice);\n});',
      ),
    ).toEqual([]);
  });

  it("flake check reports divergent seeds and accepts a stable function", async () => {
    const mod = await loadCheck("flake.check.mjs");
    const detect = mod["detectFlake"] as (
      fn: (seed: number) => string,
    ) => Array<{ code: string }>;
    const flaky = (await loadModule(path.join(BASE_DIR, "src", "flaky.mjs"))) as {
      flakyValue: (seed: number) => string;
      stableValue: (seed: number) => string;
    };
    expect(detect(flaky.flakyValue).map((finding) => finding.code)).toContain("FLAKE_DIVERGENCE");
    expect(detect(flaky.stableValue)).toEqual([]);
  });

  it("env-drift check finds one missing and one extra key", async () => {
    const mod = await loadCheck("env-drift.check.mjs");
    const diff = mod["diffEnvKeys"] as (
      example: string,
      config: string,
    ) => { missing: string[]; extra: string[] };
    const result = diff(readBase(".env.example"), readBase("src/loadConfig.ts"));
    expect(result.missing).toEqual(["FEATURE_X"]);
    expect(result.extra).toEqual(["FEATURE_Y"]);
    expect(
      diff("DATABASE_URL=\nAPI_KEY=\nFEATURE_X=\n", "process.env.DATABASE_URL; process.env.API_KEY; process.env.FEATURE_X;"),
    ).toEqual({ missing: [], extra: [] });
  });

  it("injection check flags both threat categories and scores clean text at zero", async () => {
    const mod = await loadCheck("injection.check.mjs");
    const scan = mod["scanInjection"] as (text: string) => {
      detectedThreats: string[];
      riskScore: number;
    };
    const threats = scan(readBase("fixtures/injection.txt"));
    expect(threats.detectedThreats).toContain("ignore-instructions");
    expect(threats.detectedThreats).toContain("secret-exfiltration-directive");
    const clean = scan("The invoice total is 42 dollars.");
    expect(clean.detectedThreats).toEqual([]);
    expect(clean.riskScore).toBe(0);
  });

  it("seam check reports a mismatched import symbol", async () => {
    const mod = await loadCheck("seam.check.mjs");
    const find = mod["findSeamMismatches"] as (input: {
      exports: string[];
      imports: string[];
    }) => string[];
    expect(find({ exports: ["applyPatch"], imports: ["applyPatchV2"] })).toEqual(["applyPatchV2"]);
    expect(find({ exports: ["applyPatch"], imports: ["applyPatch"] })).toEqual([]);
  });

  it("receipt gate accepts the golden report and rejects malformed reports", async () => {
    const mod = await loadCheck("receipt-gate.check.mjs");
    const golden = mod["GOLDEN_ORCHESTRATOR_REPORT"] as Record<string, unknown>;
    const validate = mod["validateReport"] as (value: unknown) => OutputContractResult;
    expect(validate(golden).ok).toBe(true);
    const missing = { ...golden };
    delete missing["branch"];
    expect(validate(missing).ok).toBe(false);
    expect(validate({ ...golden, extra: true }).ok).toBe(false);
    expect(validate({ ...golden, worktree: 42 }).ok).toBe(false);
  });

  it("ui-state check finds the missing error state", async () => {
    const mod = await loadCheck("ui-state.check.mjs");
    const analyze = mod["analyzeUiState"] as (source: string) => { missing: string[] };
    expect(analyze(readBase("src/component.tsx")).missing).toEqual(["error"]);
    expect(
      analyze(
        "loading empty error aria-live focus-visible",
      ).missing,
    ).toEqual([]);
  });

  it("testwriter lint rejects a tautology and accepts a real assertion", async () => {
    const mod = await loadCheck("testwriter-lint.check.mjs");
    const lint = mod["lintTestSource"] as (source: string) => Array<{ rule: string }>;
    const bad = lint(readBase("fixtures/bad_test.py"));
    expect(bad.map((violation) => violation.rule)).toContain("TAUTOLOGY");
    const clean = lint(
      "def test_increment():\n    value = 1\n    value += 1\n    assert value == 2\n",
    );
    expect(clean).toEqual([]);
  });

  it("validates both output contracts and rejects missing, extra, and wrong-type keys", async () => {
    const mod = (await loadModule(
      path.join(ROOT, "scripts", "agent-readiness", "output-contract.mjs"),
    )) as unknown as OutputContractModule;
    const orchestrator = {
      worktree: "/tmp/wt",
      branch: "wt/readiness",
      slicesCompleted: ["s1"],
      receipts: [{ id: "r1", status: "verified" }],
      prUrlOrPath: "local:wt/readiness",
      nextHumanAction: "review",
    };
    expect(mod.validateOutputContract("orchestrator-report-v1", orchestrator).ok).toBe(true);
    const missing = { ...orchestrator };
    delete (missing as Partial<typeof orchestrator>).branch;
    expect(mod.validateOutputContract("orchestrator-report-v1", missing).ok).toBe(false);
    expect(mod.validateOutputContract("orchestrator-report-v1", { ...orchestrator, extra: 1 }).ok).toBe(
      false,
    );
    expect(
      mod.validateOutputContract("orchestrator-report-v1", { ...orchestrator, receipts: [{ id: 1, status: "ok" }] }).ok,
    ).toBe(false);
    const subagent = {
      status: "done",
      role: "nyx-api",
      slice: "s1",
      filesChanged: ["src/routes.ts"],
      receipts: [{ id: "r1", status: "verified" }],
      contractsPublished: [],
      openIssues: [],
      nextAction: "handoff",
    };
    expect(mod.validateOutputContract("subagent-summary-v1", subagent).ok).toBe(true);
    expect(mod.validateOutputContract("subagent-summary-v1", { ...subagent, status: 1 }).ok).toBe(
      false,
    );
    expect(
      mod.validateOutputContract("subagent-summary-v1", { ...subagent, receipts: [{ id: "r1" }] }).ok,
    ).toBe(false);
  });

  it("gives every fixture a non-empty required list and a matching check module", () => {
    for (const expected of EXPECTED_AGENTS as readonly ExpectedAgent[]) {
      const fixture = readFixture(expected.id);
      expect(Array.isArray(fixture.artifactSchema["required"]), `${expected.id} required`).toBe(true);
      expect(
        (fixture.artifactSchema["required"] as string[]).length,
        `${expected.id} required list`,
      ).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(CHECKS_DIR, fixture.check)), fixture.check).toBe(true);
    }
  });
});

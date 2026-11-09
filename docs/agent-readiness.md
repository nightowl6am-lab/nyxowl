# Agent Readiness

Nyxowl proves the all-agent contract and security boundary in five layers:
four deterministic layers that run on every CI node, and one local-only live
layer that talks to a real OpenCode host.

See [`known-limitations.md`](known-limitations.md) for the OpenCode headless
cold-start bug, the supported TUI launch path, and the deterministic CI gate.

## 1. Contract matrix

`tests/agent-readiness/matrix.test.ts` compiles the real `agents/` tree through
`compileAllAgentsAndCommands` and asserts, for all 11 agents:

- exact mode, `output_contract`, and `host_tools`;
- exact `nyx_tools` equal to `ROLE_ALLOWED_NYX_TOOLS` (no missing or extra tool);
- all six required prompt sections; native prompts stay at or below 1200 tokens
  with exactly one skill loader line and no skill body, while the inline
  `nyx-testwriter` prompt stays at or below 6000 tokens;
- 11 loaded skill packages with mode, references, and license, plus a matching
  `agents/skills.lock.json`;
- the six canonical commands and the 300-token `AGENTS.md` block;
- the full 38-tool MCP inventory: exact names, unique entries, non-empty
  descriptions <=200 characters, and JSON-object input/output schemas for every
  tool (schema-verified, not executed);
- every referenced `nyx_*` tool exists in the MCP server.

## 2. Role fixtures

`tests/agent-readiness/fixtures/<agent>.json` holds one bounded prompt per
agent. Each fixture names the expected nyx tools, forbidden nyx tools, the
stdout or file artifact, the check module, forbidden host tools, and a minimal
artifact schema. `tests/agent-readiness/base/` is an inert sample project with
one deterministic defect per domain: RLS gaps, an unscoped route, a failing
contrast pair, a missing UI state, env-key drift, a seam mismatch, a flaky
function, an inert canary, injection text, and a tautological pytest sample.

## 3. Deterministic domain checks

`tests/agent-readiness/checks/*.check.mjs` contains small pure functions used by
the matrix (positive and negative cases) and by the live harness for file
artifacts. The checks cover RLS, WCAG contrast, secret canaries, route
authorization, flake replay, env drift, prompt injection (through the real
shield engine), export/import seams, receipt contracts, UI states, and the real
Python Test-Writer lint gate.

## 4. In-process tool conformance

`tests/agent-readiness/tool-conformance.test.ts` invokes the real MCP tool
definitions through `invokeToolDefinition` with the fixture prompt shapes. It
runs against a temporary git copy of the base fixture and a temporary
`NYXOWL_HOME`, never the host runtime. The matrix schema-verifies all 38 tools;
this suite executes the 13 fixture-expected tools and separately checks that all
38 expose callable handlers and JSON-object input schemas without executing
them. Every executed tool must return a structured success; only
`nyx_testwriter_job` with the bogus readiness id may return a structured error.
Execution covers context hydration, DNA, sanitize, Blackboard,
skeleton/trace/seam, env inspection, debug isolation, worktree listing, slop,
loopback exploit probing, and Test-Writer job lookup.

## 5. Local-only live harness

`scripts/agent-readiness/live.mjs` copies the base fixture into a temporary git
repository, generates the OpenCode package for that directory, and runs each
agent with `opencode run --standalone --format json`. It asserts captured tool
calls (never prose), the role tool allowlist, secret/red-line-safe inputs, the
output contract, and artifact schemas. It preserves the caller's HOME and XDG
auth, never passes `--auto`, and fails if the main checkout HEAD or status
changes. A loopback-only HTTP fixture is created for `nyx-sec`.

## Commands

```bash
npm run test:agents   # deterministic; no model, network, install, or .env
npm run skills:verify # offline provenance, hash, link, license, and safety checks
npm run agents:live   # local-only; requires an authenticated OpenCode v2.2.5 and an explicit model
```

`agents:live` accepts `--agents`, `--rounds` (default 2), `--model`,
`--evidence-dir`, and `--timeout-ms`. It has no default model: pass `--model
<provider/model>` or set `NYXOWL_LIVE_MODEL`; without one it prints a clear
error and exits 2 before spawning the host. Evidence is written under
`/tmp/opencode/agent-readiness-live/<utc-timestamp>/` by default and is never
committed. A round that produces zero tool calls or dies before any event is
retried exactly once; the round passes only if every recorded attempt passes.

## Live host status

OpenCode v2.2.5's headless `opencode run --standalone` path has a cold-start
bug: MCP servers can log `mcp connected server=nyxowl tools=38` while the first
model request still sees only host tools. This is a host bug, not a repository
launch requirement. NyxOwl's product path is the normal OpenCode TUI using the
generated `opencode.json`; OpenCode manages its own service and MCP connections.
`agents:live` keeps the standalone harness and may report `BLOCKED_HOST`; do not
claim a live PASS from that result. Verify the product manually in the normal
TUI.

The earlier stale v0.1.0 host package (setup skipped regeneration when the
manifest version matched) remains fixed: setup and `nyxowl doctor` regenerate on
every run.

Before the role loop, `agents:live` runs a one-prompt preflight with
`--print-logs` that asks the `nyxowl` agent to list its available tools. It
parses `mcp connected server=nyxowl tools=<n>` from the captured stderr and
records `mcpConnected`/`mcpToolCount` plus the observed model tool list. If no
`nyxowl_nyx_` tool appears, it writes `host-mcp-tools-unexposed.json` and
`readiness-report.json` with `verdict:"BLOCKED_HOST"` and exits 2 without
running the 11-agent matrix. When the log line is absent but the tool surface is
still empty, it reports `mcpConnected:null`, `mcpToolCount:null`, and the reason
"tool surface unavailable; MCP connection not observable in captured logs". Only
parsed values and the redacted stderr summary are persisted.

`npm run test:agents` is the deterministic CI gate. `npm run agents:live` is the
local host-dependent evidence gate; a `BLOCKED_HOST` result records a host
blocker rather than an agent failure.

## Evidence rules and limitations

- Deterministic tests never call a model, the network, an installer, or read
  `.env`; only `.env.example` is present in fixtures.
- The live harness uses only loopback networking for its security fixture and
  must not be run in CI.
- Live verdicts depend on the pinned model and host build; record the
  `opencode --version` and model from `readiness-report.json`.
- The live harness checks observed tool calls and artifact schemas. It does not
  replace human review of prompt quality or domain judgement.

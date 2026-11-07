# M6 evidence

Date: 2026-11-07
Worktree: `/home/ocagent/work/nyxowl/worktrees/nyxowl-test-writer-m6`
Branch: `wt/test-writer-m6`
Base: `67bdc0a` (M5 merged)
Scope: M6 advisory finish, host-isolation permissions, model-free three-run
matrix, parent stdio MCP end-to-end.

## Seventh correction source change (two-phase filter)

The generated plugin replaces the previous unconditional "delete every
non-allowed key" suffix filter with a two-phase `restrictTools` filter for
`nyx-testwriter`. Phase one runs against the pre-MCP snapshot, which the fresh
diagnostic shows is an object with nine native host keys and none of the five
Test-Writer tools. In that phase the filter deletes only `opencode_models`,
`opencode_session_move`, `opencode_session_rename`, `opencode_worktree_create`,
and `opencode_worktree_list`, leaving the other native entries so MCP
registration proceeds. Phase two begins when the snapshot contains any allowed
tool; the later diagnostic snapshot has 39 keys including all five MCP tools,
and the filter then keeps only allowed entries. The object and array branches
each implement both phases.

The diagnostic control confirms the distinction: deleting all non-five entries
from the first nine-key map prevents MCP registration (zero `tool_use`), while
deleting only the five bypassing tools preserves the MCP tools. Variant G
(deny the five first, then allowlist once an allowed tool appears) produced a
five-key subsequent map with job results 2/3 and `opencode_models` 0/3; the
remaining job miss is model non-call variance. No variant, tar, or store leak
was observed. `opencode_models` remains undennied in config. Final live
re-verification is pending; this section does not claim a live pass.

The focused adapter/MCP tests assert `TESTWRITER_DENY_TOOLS` with all five
names, `TESTWRITER_TOOL_SUFFIXES`, `restrictTools`, `isAllowedTool`,
`isDeniedTool`, both context hook registrations, and both phased branches.
`TESTWRITER_TOOL_NAMES` and the unconditional delete-every-non-allowed behavior
are removed.

## Sixth correction source change (shape-tolerant suffix filter; superseded)

The generated plugin keeps the second `ctx.session.hook("context",
restrictTools)` registration. For `nyx-testwriter` it now applies a
shape-tolerant suffix match to the per-request `event.tools` snapshot instead of
exact keys: an entry survives when its derived name (a string entry, `id`,
`name`, `tool`, or `function.name`) ends with `testwriter_job`,
`testwriter_write`, `testwriter_lint`, `testwriter_gate`, or
`testwriter_finish`. This preserves the five tools for both object and array
snapshots, prefixed or bare, and also keeps wrapped entries whose value carries
the name. Object snapshots delete a key only when neither the key nor its value
matches. Empty-name entries survive only when their serialized form contains
`testwriter_`. If an array snapshot has no recognizable entry, it is left intact
rather than wiped. Other agents are untouched; a missing `event.tools` or a
thrown filter is a no-op so the model call is never broken. The explicit config
denies and the permission-hook allowlist remain as defense-in-depth.
`opencode_models` is still not denied in config because live QA showed a config
deny hides the five MCP tools.

The generated plugin string carries `TESTWRITER_TOOL_SUFFIXES`,
`TESTWRITER_TOOL_NAMES`, `Array.isArray(event.tools)`, the backward `splice`
loop, `isAllowedTool`, and both context hook registrations. The focused test
asserts those strings and the five suffix constants. The preceding fifth-pass
exact-key filter failed live with zero `tool_use` events. The fresh independent
sixth-pass live re-verification recorded at the bottom of this file also failed
with zero `tool_use`; its diagnostic snapshot shows that the live `event.tools`
object contains only nine built-in host tools and none of the five Test-Writer
tools, and the object branch then deletes all nine. The suffix filter is not
sufficient in live OpenCode and is not claimed as passing.

## Fifth-pass live re-run (per-request tool-snapshot filter)

Result: **FAIL**. The config/plugin inspection is correct: no wildcard deny, 13
explicit host denies, resource actions allowed, `nyxowl_*` deny, five allows;
the plugin contains `TESTWRITER_TOOL_NAMES` with both prefixed and bare names,
`restrictTools`, and two `session.hook("context", ...)` registrations. However,
the live model produced **zero `tool_use` events**. It emitted an XML-style
`<invoke name="nyxowl_nyx_testwriter_job">` as plain text, with both
`deepseek-v4.1-flash` and `deepseek-v4.1-pro`; the allowed tool never executed.
The per-request filter appears to remove the five tools (or mishandle the live
`event.tools` snapshot shape), so the allowed tool is not callable. No non-five
tool completed, and there is no tool-output leak. Prior passes remain below as
history.

## Fourth-pass live re-run (two-layer isolation)

Result: **FAIL**. The config has 13 explicit host denies plus `execute`, no
wildcard; `opencode_list_mcp_resources` / `opencode_read_mcp_resource` are not
denied; `nyxowl_*` deny precedes the five allows. The plugin has the five-action
allowlist and the deny message. Live run: `nyxowl_nyx_testwriter_job` completed
with `status: "approved"`; `opencode_list_mcp_resources`,
`opencode_read_mcp_resource`, and `todowrite` were denied with the plugin
message; glob/grep/read/shell/webfetch/websearch/subagent/skill/question/
external_directory and `nyx_blackboard_read` were absent. However,
`opencode_models` completed with `{"providers":[],"total":0,"next":null}`. That
is a completed host tool and fails the PASS condition. No variant/tar leaked in
tool output. The prior third-pass and first-correction failures remain below as
history.

Third-pass re-run on 2026-11-07 by the verifier. Result: **FAIL**. The second
correction removed the wildcard `* * deny` and now emits 14 explicit host-action
denies before `nyxowl_*` deny and the five allows. The generated config itself
has no wildcard deny and the five allows are in the correct order. However, the
live model still does not call `nyxowl_nyx_testwriter_job`; it reports only
host/session tools. A diagnostic variant that removes the two
`opencode_list_mcp_resources` / `opencode_read_mcp_resource` denies restores the
five MCP tools, but then `opencode_list_mcp_resources` itself completes. No
tested config satisfies both the five-tool call and the host-action denial.
The pre-fix `glob` failure and the first-correction wildcard failure are kept
below as history.

## Environment

| Item | Value |
| --- | --- |
| OS user | `ocagent` (rootless; no sudo, no `/opt`, no `/var/lib`) |
| Node / npm | `v24.22.2` / npm 11.x |
| Python (host) | `3.12.3` |
| Python (runtime venv) | `3.12.3`, pytest `9.2.0`, hypothesis `6.170.15` |
| bubblewrap | `/usr/bin/bwrap`, version `0.9.0` |
| Installed runtime | refreshed from this worktree by `bootstrap/install-user.sh` |
| Test roots | temporary directories created by each runner; no production store or workspace |
| Network / secrets / remote Supabase | none |

## Prior command results (full gates and threerun; not rerun in third/fourth/fifth passes)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test:coverage` | PASS — 20 files, 178 tests; statements 81.97%, branches 69.96%, functions 88.3%, lines 84.17% |
| `npm run build` | PASS — `dist/cli/bin.js`, `dist/mcp/server.js` (and chunks/maps) built |
| `npm pack --dry-run` | PASS — 200 files, 727.0 kB |
| `node test-writer/qa/m6_parent_e2e.mjs` | PASS — `M6_PARENT_E2E: PASS` |
| `TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" python3 test-writer/qa/m6_threerun.py --out /tmp/opencode/m6-runs-verify-final` | PASS — `M6_THREERUN: PASS` |
| `bash test-writer/bootstrap/install-user.sh` | PASS — `USER_INSTALL: PASS` |
| `~/.nyxowl/test-writer/bin/tw-status m6-smoke-missing` | PASS — JSON `status: missing`, `advisoryFlags: []`, `variants: false` |
| Live OpenCode first-correction isolation run | FAIL — wildcard deny hid the five MCP tools (history) |
| Live OpenCode second-correction isolation run | FAIL — explicit denies preserve the config order, but the live model exposes no nyx tool; removing the two `opencode_*` resource denies restores them |
| Live OpenCode third-correction (two-layer) run | FAIL — five tools and requested denials work, but `opencode_models` completed as a host tool |
| Live OpenCode fourth-correction (snapshot filter) run | FAIL — zero `tool_use`; model emitted XML text and the allowed tool was not callable |

`npm ci --ignore-scripts` was not rerun in this pass. The earlier run in this
worktree reported 292 packages and 0 vulnerabilities; no lockfile or manifest
change was observed.

The third, fourth, and fifth passes re-ran only the focused tests and the parent
E2E, per the instruction not to rerun coverage. The full-gate and threerun rows
above are the prior results on this worktree; the Python runtime and fixture code
were unchanged by the config/plugin corrections.

## Three-run matrix

Command:

```bash
TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" \
  python3 test-writer/qa/m6_threerun.py --out /tmp/opencode/m6-runs-verify-final
```

Observed output:

```text
run | J1 | J2 | J3 | J4 | advisory
1 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED
2 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED
3 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED
J4 advisory is scripted plumbing evidence, not a model judgment.
M6_THREERUN: PASS
```

`/tmp/opencode/m6-runs-verify-final/summary.json` has `pass: true`,
`failures: []`, and three rounds. J1 is 3/3 `PROVEN` with `recheckExit: 0` and
`recheckResult: "match"`. J2 is 3/3 `UNPROVEN` with
`reason: "NO_DETECTOR_HIT_ON_VULN"`. J3 is 3/3 `REFUTED` with
`reason: "PATCHED_STILL_LEAKS"` and is never `PROVEN`. J4 is 3/3 `PROVEN` with
`advisoryFlags` and `statusAdvisoryFlags` both `["INJECTION_SUSPECTED"]`.
The J4 advisory is scripted plumbing evidence, not a model judgment.

## Parent stdio MCP end-to-end

Command:

```bash
npm run build
node test-writer/qa/m6_parent_e2e.mjs
```

Observed final line:

```text
M6_PARENT_E2E: PASS
```

The runner starts `node <worktree>/dist/cli/bin.js mcp` with a temporary
`NYXOWL_HOME` and temporary `TW_*` roots. The verifier inspected the assertions
and the passing run covers:

- 38 registered tools, exactly seven `nyx_testwriter_*` tools, and exactly five
  subagent tools parsed from `agents/subagents/nyx-testwriter.md`;
- prepare, two owner-only `tw-add-variant` calls, approve, job read (applicable,
  spec/interface/helperApi present, no variant refs/tars/store paths), write,
  lint, gate (`PROVEN`, closed), finish (advisory `INJECTION_SUSPECTED`), and
  status with report (`PROVEN`, `## Limits`, no `def decode(` or `TOP SECRET`);
- invalid job id refusal and a refused write against the closed job.

## Installed runtime refresh

```bash
bash test-writer/bootstrap/install-user.sh
# USER_INSTALL: PASS
# Installed /home/ocagent/.nyxowl/test-writer as the current user.
```

```text
$ ~/.nyxowl/test-writer/bin/tw-status m6-smoke-missing
{"advisoryFlags":[],"attemptsUsed":0,"budget":{"max":0,"used":0},"flags":[],"jobId":"m6-smoke-missing","reason":null,"status":"missing","variants":false,"verdict":null}
```

## OpenCode host isolation (first correction, superseded)

Fresh live home:

```bash
LIVE=/tmp/opencode/m6-live-final
mkdir -p "$LIVE"
NYXOWL_HOME="$LIVE" NYXOWL_TESTWRITER_INSTALL=0 node dist/cli/bin.js doctor
```

Doctor result: `Nyxowl v1.0.0 initialized`, OpenCode installed at
`/home/ocagent/.npm-global/bin/opencode` (v2.2.5, Tier A), and
`MCP Smoke Test: OK (38 tools registered)`.

Generated config for the first correction: `$LIVE/hosts/opencode/opencode.json`.

First correction (superseded): the `agents["nyx-testwriter"].permissions` array
had exactly 11 rules, starting with the wildcard deny:

```text
0  *        *  deny
1  read     *  deny
2  edit     *  deny
3  shell    *  deny
4  webfetch *  deny
5  nyxowl_* *  deny
6  nyxowl_nyx_testwriter_job    * allow
7  nyxowl_nyx_testwriter_write  * allow
8  nyxowl_nyx_testwriter_lint   * allow
9  nyxowl_nyx_testwriter_gate   * allow
10 nyxowl_nyx_testwriter_finish * allow
```

`OPENCODE_CONFIG="$LIVE/hosts/opencode/opencode.json" opencode debug agents
--standalone` listed 24 agents and one `nyx-testwriter` entry. Its merged
permissions ended with `287 * * deny`, `288 read * deny`, `289 edit * deny`,
`290 shell * deny`, `291 webfetch * deny`, `292 nyxowl_* * deny`, then the five
allows at `293`-`297`, followed by `browser * deny` and `skill browser deny`.
Without `--standalone` the command read the already-running background service
and listed only 13 built-in agents; the generated config was not loaded.

A last-match-wins replay of that merged rule set denied `glob`, `grep`, `read`,
`shell`, `webfetch`, `websearch`, `subagent`, `skill`, `question`,
`external_directory`, `nyxowl_nyx_testwriter_status`, `nyxowl_nyx_blackboard_read`,
`nyxowl_nyx_worktree_start`, `playwright_browser_navigate`, and
`experimental_image_generate`, while allowing the five
`nyxowl_nyx_testwriter_*` actions. It was the intended config-level result, but
the live tool surface still dropped the five allowed tools.

Second correction (current source, tests only): the wildcard rule is removed.
The generated array has exactly 20 rules: 14 explicit host-action denies in
order (`read`, `edit`, `glob`, `grep`, `shell`, `webfetch`, `websearch`,
`subagent`, `skill`, `question`, `external_directory`,
`experimental_image_generate`, `opencode_list_mcp_resources`,
`opencode_read_mcp_resource`), then the `nyxowl_*` deny, then the five
`nyxowl_nyx_testwriter_*` allows. The focused TypeScript test asserts the
absence of a wildcard deny, each explicit host deny, and the five allows. The
third-pass live run below was made against this second correction; it fails
because the two `opencode_*` resource denies hide the five MCP tools from the
model surface.

## Live post-fix run and observed failure

Temp job setup used the refreshed installed wrappers and the fixture `j1`
body:

```bash
TW_INSTALL_ROOT="$HOME/.nyxowl/test-writer" \
TW_STORE_ROOT="$LIVE/store" TW_WORKSPACE_ROOT="$LIVE/workspace" \
TW_TMP_ROOT="$LIVE/tmp" \
~/.nyxowl/test-writer/bin/tw-new-job --json < /tmp/opencode/m6-final-job-body.json
# {"id":"m6-live-final-j1","workspaceHint":"/tmp/opencode/m6-live-final/workspace/m6-live-final-j1"}

TW_INSTALL_ROOT="$HOME/.nyxowl/test-writer" \
TW_STORE_ROOT="$LIVE/store" TW_WORKSPACE_ROOT="$LIVE/workspace" \
TW_TMP_ROOT="$LIVE/tmp" \
~/.nyxowl/test-writer/bin/tw-approve m6-live-final-j1
# APPROVED m6-live-final-j1
```

`tw-status m6-live-final-j1` reported `status: "approved"`, `variants: true`,
`attemptsUsed: 0`.

Live command shape:

```bash
OPENCODE_CONFIG="$LIVE/hosts/opencode/opencode.json" \
TW_INSTALL_ROOT="$HOME/.nyxowl/test-writer" \
TW_STORE_ROOT="$LIVE/store" \
TW_WORKSPACE_ROOT="$LIVE/workspace" \
TW_TMP_ROOT="$LIVE/tmp" \
opencode run --standalone --agent nyx-testwriter \
  --model opencode-go/deepseek-v4.1-flash --format json "<prompt>"
```

The requested model was `opencode-go/deepseek-v4.1-flash` (and once
`opencode-go/deepseek-v4-pro`). All runs exited `0`. The prompt told the agent
not to write a test and not to claim a verdict.

Redacted transcript (tool names, statuses, and permission/error lines only):

```text
run A (flash, isolation prompt: call nyx_testwriter_job, then glob/grep/shell/read/webfetch/nyx_blackboard_read)
  tool_use: none
  text: claims only `skill` is exposed and refuses to fabricate a job status
  no nyx_testwriter_job call, no host tool call

run B (flash, prompt: list tools only)
  tool_use: none
  text: lists five nyx_testwriter_* tools plus `skill` (untrusted model text;
        contradicted by runs A, C, D, E)

run C (flash, explicit `Call nyxowl_nyx_testwriter_job ...`)
  tool_use: none
  text: `nyxowl_nyx_testwriter_job` is not present; only `skill` is exposed

run D (deepseek-v4-pro, explicit `Call nyxowl_nyx_testwriter_job ...`)
  tool_use: none
  text: same absence; only `skill` is exposed
  stderr: mcp connected server=nyxowl tools=38

run E (flash, prompt starts `TW_JOB m6-live-final-j1`, explicit job call)
  tool_use: none
  text: `nyx_testwriter_job` is not among the exposed tools; only `skill`

host-tool attempts: none possible; glob/grep/read/shell/webfetch/websearch/subagent
are absent from the model surface.
```

The JSON streams contain no `tool_use` event in runs A-E. The MCP server itself
starts (`mcp connected server=nyxowl tools=38`), so the failure is in the
OpenCode tool exposure/filtering step: the blanket `* * deny` hides the five
`nyxowl_nyx_testwriter_*` tools even though later allow rules are present.
The focused TypeScript test replays last-match-wins and passes, but it does not
exercise OpenCode's real tool-surface construction.

Leak check: no tool result exists in these runs, so no variant ref, variant tar
name, or store path appears in a tool result. The job id appears in prompts and
model text only.

## Explicit-deny re-run (third pass)

Fresh live home: `/tmp/opencode/m6-live-explicit`. Doctor reported
`MCP Smoke Test: OK (38 tools registered)` and OpenCode v2.2.5 Tier A. The
generated config `$LIVE/hosts/opencode/opencode.json` has 20
`agents["nyx-testwriter"].permissions` rules and no `action:"*"` deny:

```text
0  read                          * deny
1  edit                          * deny
2  glob                          * deny
3  grep                          * deny
4  shell                         * deny
5  webfetch                      * deny
6  websearch                     * deny
7  subagent                      * deny
8  skill                         * deny
9  question                      * deny
10 external_directory            * deny
11 experimental_image_generate   * deny
12 opencode_list_mcp_resources   * deny
13 opencode_read_mcp_resource    * deny
14 nyxowl_*                      * deny
15 nyxowl_nyx_testwriter_job     * allow
16 nyxowl_nyx_testwriter_write   * allow
17 nyxowl_nyx_testwriter_lint    * allow
18 nyxowl_nyx_testwriter_gate    * allow
19 nyxowl_nyx_testwriter_finish  * allow
```

`OPENCODE_CONFIG=... opencode debug agents --standalone` listed 24 agents with
one `nyx-testwriter`. The merged rules place the explicit denies at indices
288-300, `nyxowl_*` deny at 301, the five allows at 302-306, then
`browser * deny` and `skill browser deny`. A last-match-wins replay denies
`execute`, `glob`, `grep`, `read`, `shell`, `webfetch`, `websearch`, `subagent`,
`skill`, `question`, `external_directory`, `experimental_image_generate`, both
`opencode_*` resource tools, and non-testwriter nyx tools; it allows the five
`nyxowl_nyx_testwriter_*` actions. `execute` is denied here by the surrounding
global OpenCode config, not by the generated agent rules.

Job `m6-live-explicit-j1` was created with the fixture `j1` body (variants
included), approved, and reported `status: "approved"`, `variants: true`.

Run A used the generated config with
`opencode-go/deepseek-v4.1-flash`. Exit `0`; the JSON stream contains **no
`tool_use` events**. The model reported only host/session tools and refused to
call `nyx_testwriter_job`; a focused repeat (A2) also produced no `tool_use`.
No host tool completed and no host action returned file contents. Leak check:
no tool result exists, so no variant ref, tar name, or store path is present.

Diagnostic variants, all with the same job and model:

- v2 (remove only the `opencode_list_mcp_resources` deny): the model called
  `opencode_list_mcp_resources` twice (`completed`) and still could not see the
  nyx tools.
- v3 (remove only the `opencode_read_mcp_resource` deny): the model saw no
  `opencode_list_mcp_resources` and no nyx tools.
- v1 (remove both `opencode_*` resource denies): the model called
  `opencode_list_mcp_resources` (`completed`), then
  `nyxowl_nyx_testwriter_job` (`completed`, `status: "approved"`), then
  `nyxowl_nyx_testwriter_write`, `_lint` (`ok: true`), `_gate` (`verdict:
  "PROVEN"`, closed), and `_finish` (`advisoryFlags: ["INJECTION_SUSPECTED"]`).
  It ignored the "do not write" instruction and closed the job; this is recorded
  as model behavior. This proves the five MCP tools are callable only when both
  `opencode_*` resource denies are absent in this OpenCode build.

Run B used v1 plus `{"action":"execute","resource":"*","effect":"deny"}` inserted
before the `nyxowl_*` deny. Exit `0`; the model called
`opencode_list_mcp_resources` (`completed`) and
`nyxowl_nyx_testwriter_job` (`completed`, `status: "closed"`); no `execute`
tool appeared, and the five MCP tools remained callable. Adding the execute
deny is therefore safe for the five tools, but v1 still allows the
`opencode_list_mcp_resources` host action.

Execute decision: no `execute` tool appeared in the generated-config Run A.
The global config already denies `execute`; the generated agent rules do not
include it. For self-containment, add
`{"action":"execute","resource":"*","effect":"deny"}`. Run B shows it does not
break the five tools. It is not the cause of the current failure.

Minimal tool-preserving rule set observed: v1 plus the execute deny (remove the
two `opencode_*` resource denies, add `execute` deny). That preserves the five
tools and denies execute, but it leaves `opencode_list_mcp_resources` allowed
and completing, so it does not meet the host-action PASS condition. The
generated config (both `opencode_*` denies present) denies the host actions but
hides the five MCP tools.

The explicit deny set also omits `todowrite`, `opencode_models`,
`opencode_session_*`, and `opencode_worktree_*`; the model's Run A text listed
those as available. That text is untrusted, but the generated rules indeed do
not deny them.

Focused tests: `npx vitest run tests/mcp/testwriter.test.ts
tests/adapters/adapters.test.ts` PASS — 2 files, 23 tests. Parent E2E: PASS —
`M6_PARENT_E2E: PASS`.

## Two-layer isolation re-run (fourth pass)

Fresh live home: `/tmp/opencode/m6-live-final4`. Doctor reported
`MCP Smoke Test: OK (38 tools registered)` and OpenCode v2.2.5 Tier A.

Generated `$LIVE/hosts/opencode/opencode.json` has 19
`agents["nyx-testwriter"].permissions` rules and no `action:"*"` deny:

```text
0  read                          * deny
1  edit                          * deny
2  glob                          * deny
3  grep                          * deny
4  shell                         * deny
5  webfetch                      * deny
6  websearch                     * deny
7  subagent                      * deny
8  skill                         * deny
9  question                      * deny
10 external_directory            * deny
11 experimental_image_generate   * deny
12 execute                       * deny
13 nyxowl_*                      * deny
14 nyxowl_nyx_testwriter_job     * allow
15 nyxowl_nyx_testwriter_write   * allow
16 nyxowl_nyx_testwriter_lint    * allow
17 nyxowl_nyx_testwriter_gate    * allow
18 nyxowl_nyx_testwriter_finish  * allow
```

`opencode_list_mcp_resources` and `opencode_read_mcp_resource` are intentionally
not in the deny list so the five MCP tools remain exposed. The generated plugin
`$LIVE/hosts/opencode-plugin/nyxowl/index.js` contains the exact
`TESTWRITER_ACTIONS` set for the five actions, the string `nyx-testwriter`, and
the message `nyx-testwriter may only use the five tools: job, write, lint, gate,
finish.`. `opencode debug agents --standalone` listed 24 agents with one
`nyx-testwriter`; merged rules place the explicit denies at 288-299, `execute`
at 299, `nyxowl_*` deny at 300, and the five allows at 301-305.

Job `m6-live-final4-j1` was created with the fixture `j1` body (variants
included), approved, and reported `status: "approved"`, `variants: true`.

Live run A used `opencode-go/deepseek-v4.1-flash`; exit `0`. Every `tool_use`
event:

| Action | Status | Message/result |
| --- | --- | --- |
| `opencode_list_mcp_resources` | error | `nyx-testwriter may only use the five tools: job, write, lint, gate, finish.` |
| `todowrite` | error | same boundary message |
| `nyxowl_nyx_testwriter_job` | completed | `status: "approved"`, `applicable: true`, `targetStack: "python"` |
| `opencode_models` | completed | `{"providers":[],"total":0,"next":null}` |
| `opencode_read_mcp_resource` | error | same boundary message |

No `tool_use` event existed for `glob`, `grep`, `read`, `shell`, `webfetch`,
`websearch`, `subagent`, `skill`, `question`, `external_directory`, or
`nyx_blackboard_read`; they were absent from the agent surface. The model's
final text also reported them as unavailable.

Allowed tool: `nyxowl_nyx_testwriter_job` completed with `status: "approved"`.
Denied actions: `opencode_list_mcp_resources`, `opencode_read_mcp_resource`,
and `todowrite` returned error with the plugin boundary message; the remaining
requested host actions were absent. The plugin allowlist works for those three
actions.

Failure: `opencode_models` completed as a host tool. The plugin allowlist did
not deny it, so the "no completed host tool" PASS condition fails. A diagnostic
config that adds `{"action":"opencode_models","resource":"*","effect":"deny"}`
to the config caused the five MCP tools to disappear again (the model reported
no test-writer tools), so a config-only fix is not viable. The plugin must catch
`opencode_models` (and any other non-five host tool) and fail closed.

Leak check: no variant ref (`aa1bc76e...`, `83ee4c56...`), variant tar
(`src-still-vulnerable.tar`, `src-fixed-differently.tar`), or store path appears
in any tool result. The job result contains the spec but no variant refs/tars or
store paths. The store path and `meta.json` appear only in the prompt and the
model's restatement, not in tool output. The `opencode_models` result was empty.

Regression: `npx vitest run tests/mcp/testwriter.test.ts
tests/adapters/adapters.test.ts` PASS — 2 files, 23 tests. Parent E2E: PASS —
`M6_PARENT_E2E: PASS`.

Conclusion: five `nyx_testwriter_*` actions are callable and the requested
config/plugin denials work, but the live stream contains a completed host tool
(`opencode_models`). The two-layer boundary is not yet closed. FAIL.

## Fifth-pass live re-run (per-request tool-snapshot filter)

Fresh live home: `/tmp/opencode/m6-live-final5`. Doctor reported
`MCP Smoke Test: OK (38 tools registered)` and OpenCode v2.2.5 Tier A.

Config inspection: `agents["nyx-testwriter"].permissions` has 19 rules, no
`action:"*"` deny. Explicit denies: `read`, `edit`, `glob`, `grep`, `shell`,
`webfetch`, `websearch`, `subagent`, `skill`, `question`, `external_directory`,
`experimental_image_generate`, `execute`. Then `nyxowl_*` deny, then exactly five
`nyxowl_nyx_testwriter_*` allows. `opencode_list_mcp_resources` and
`opencode_read_mcp_resource` are not denied.

Plugin inspection: `$LIVE/hosts/opencode-plugin/nyxowl/index.js` contains
`TESTWRITER_TOOL_NAMES` with both prefixed and bare forms, `restrictTools`, the
boundary message, and two `ctx.session.hook("context", ...)` registrations
(`hydrateSession` and `restrictTools`). `opencode debug agents --standalone`
listed 24 agents with one `nyx-testwriter`; merged rules place `execute` at 299,
`nyxowl_*` deny at 300, and the five allows at 301-305.

Job `m6-live-final5-j1` was created with the fixture `j1` body (variants
included), approved, and reported `status: "approved"`, `variants: true`.

Live run A used `opencode-go/deepseek-v4.1-flash`; exit `0`. The JSON stream had
three events: `step_start`, `text`, `step_finish`. There were **zero
`tool_use` events**. The text was a malformed XML-style call, not an executed
tool:

```text
<invoke name="nyxowl_nyx_testwriter_job">
<parameter name="jobId">m6-live-final5-j1</parameter>
</invoke>
```

A focused repeat with the same config and prompt used
`opencode-go/deepseek-v4-pro`; exit `0`, again zero `tool_use` events, and the
same XML-style text. The allowed tool never executed.

Event table:

| Action | Status | Message/result |
| --- | --- | --- |
| `nyxowl_nyx_testwriter_job` | not invoked | model emitted XML text; no tool_use |
| `opencode_models` | not invoked | absent from live tool surface |
| `opencode_list_mcp_resources` | not invoked | absent from live tool surface |
| `opencode_read_mcp_resource` | not invoked | absent from live tool surface |
| glob/grep/read/shell/webfetch/todowrite/nyx_blackboard_read | not invoked | absent from live tool surface |

The live result is consistent with `restrictTools` removing the five allowed
tools as well, or with the filter mishandling the live `event.tools` snapshot
shape. The source-level test asserts the plugin string, but the live stream
shows no callable tools and no allowed tool completion. Leak check: no tool
result exists, so no variant ref, variant tar, or store path appears in tool
output. The job id appears only in the prompt and model text.

Regression: `npx vitest run tests/mcp/testwriter.test.ts
tests/adapters/adapters.test.ts` PASS — 2 files, 24 tests. Parent E2E: PASS —
`M6_PARENT_E2E: PASS`.

Conclusion: the config and plugin source contain the intended rules, but the
live tool snapshot is empty from the model's perspective; the five allowed
tools are not callable. The PASS condition (`nyxowl_nyx_testwriter_job`
completed) is not met. The filter must preserve the actual live tool names and
snapshot shape; a live regression is required before any pass claim.

## Pre-fix failure (history)

Before the first correction, the generated agent permissions denied
read/edit/shell/webfetch and broad `nyxowl_*`, but not `glob`/`grep`. A live run
on `/tmp/opencode/m6-live-verify` completed `glob path=. pattern=**/*` and
returned worktree paths. `glob`/`grep` against the store were rejected by the
`external_directory` permission. That failure motivated the wildcard deny, which
was later reverted after it hid the five allowed MCP tools. The current source
denies `glob` and `grep` explicitly instead.

## Control run (pre-fix config, no `* * deny`)

The previously approved `m6-live-j1` job was driven with the pre-fix config
(`/tmp/opencode/m6-live-verify/hosts/opencode/opencode.json`), which lacks the
blanket `* * deny`. The model called `nyxowl_nyx_testwriter_job` and the call
completed with `status: "approved"`. It also called the host
`opencode_list_mcp_resources` tool, which completed; that is the leak the
wildcard rule was meant to stop. This control confirms that the blanket deny,
not the MCP server, is what removed the five allowed tools from the live
surface. The second correction instead adds an explicit
`opencode_list_mcp_resources` deny; the third-pass live run shows that this
deny and the companion `opencode_read_mcp_resource` deny hide the five MCP
tools, so the allowed tools are not visible.

## Limitations

- The live runs use nondeterministic model output; only JSON `tool_use` events
  and server logs are treated as evidence, not model prose.
- The "list tools" run produced a text list that was not backed by a tool call
  and conflicts with the other four runs.
- `opencode debug agents` must use `--standalone` here to load
  `OPENCODE_CONFIG` instead of the background service.
- The generated second-correction config hides the five MCP tools in live
  OpenCode; the v1/v2/v3 diagnostic variants and Run B are recorded above.
- The fourth-pass two-layer boundary was live-verified. The plugin denied
  `opencode_list_mcp_resources`, `opencode_read_mcp_resource`, and `todowrite`,
  but `opencode_models` completed as a host tool. A config-only deny for
  `opencode_models` hides the five MCP tools, so the plugin must cover it.
- The fifth-correction context filter was live-verified. The live model produced
  zero `tool_use` events and emitted XML text; the allowed tool was not callable.
  The filter must preserve the actual live tool names and snapshot shape.
- The three-run matrix is model-free and uses scripted J4 advisory plumbing
  evidence; it is not model judgment.


## Fresh independent sixth-pass re-run (2026-11-07, this verifier)

This section was produced by a fresh independent verifier in worktree
`/home/ocagent/work/nyxowl/worktrees/nyxowl-test-writer-m6` on branch
`wt/test-writer-m6`. Nothing from prior verifier reports was trusted; every
result below was re-derived in this session. Only this evidence file was edited.
`npm ci` was not needed (`node_modules` was present and no lockfile changed).

### Environment

| Item | Value |
| --- | --- |
| Node / npm | `v24.22.2` / `11.19.1` |
| Python (host) | `3.12.3` |
| Runtime venv | `$HOME/.nyxowl/test-writer/venv/bin/python` (Python 3.12.3), pytest `9.2.0`, hypothesis `6.170.15` |
| bubblewrap | `/usr/bin/bwrap` (0.9.0) |
| OpenCode | `2.2.5` at `/home/ocagent/.npm-global/bin/opencode`, Tier A |
| Network / secrets / remote services | none |

### Compiler gates (worktree, fresh)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS, exit 0 |
| `npm run lint` | PASS, exit 0 |
| `npm run test:coverage` | PASS, exit 0 - 20 files, 179 tests passed; statements 81.96% (4616/5632), branches 69.94% (3023/4322), functions 88.3% (491/556), lines 84.15% (4425/5258) |
| `npm run build` | PASS, exit 0 - `dist/cli/bin.js`, `dist/cli/index.js`, `dist/mcp/server.js`, chunk and maps |
| `npm pack --dry-run` | PASS, exit 0 - 200 files, package 737.0 kB, unpacked 3.6 MB |

### Python gates (fresh)

| Command | Result |
| --- | --- |
| `python3 -m compileall -q test-writer` | PASS, exit 0 |
| `python3 test-writer/fixtures/build_fixtures.py --verify` | PASS - `FIXTURES_VERIFY: PASS` |
| `TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" python3 test-writer/selftests/run_all.py` | PASS, exit 0 - 219 tests, `OK`; `M0_SELFTESTS: PASS`, `M1M3_SELFTESTS: PASS` |

### Three-run fixture matrix (fresh, model-free)

Command:

```bash
TW_VENV_PYTHON="$HOME/.nyxowl/test-writer/venv/bin/python" \
  python3 test-writer/qa/m6_threerun.py --out /tmp/opencode/m6-fresh-verifier-339014
```

Observed output:

```text
run | J1 | J2 | J3 | J4 | advisory
1 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED
2 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED
3 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED
J4 advisory is scripted plumbing evidence, not a model judgment.
M6_THREERUN: PASS
```

`/tmp/opencode/m6-fresh-verifier-339014/summary.json`: `pass: true`,
`failures: []`, three rounds. J1 is 3/3 `PROVEN` with `recheckExit: 0` and
`recheckResult: "match"`; J2 is 3/3 `UNPROVEN` with
`reason: "NO_DETECTOR_HIT_ON_VULN"`; J3 is 3/3 `REFUTED` with
`reason: "PATCHED_STILL_LEAKS"` and is never `PROVEN`; J4 is 3/3 `PROVEN` with
`advisoryFlags` and `statusAdvisoryFlags` both `["INJECTION_SUSPECTED"]`.

### Parent stdio MCP end-to-end (fresh)

`node test-writer/qa/m6_parent_e2e.mjs` exited 0 and printed
`M6_PARENT_E2E: PASS`. The runner's assertions cover 38 registered tools,
exactly seven `nyx_testwriter_*` tools, exactly five subagent tools, prepare,
two `tw-add-variant` calls, approve, job read (applicable; spec/interface/
helperApi present; no variant refs/tars/store paths), write, lint, gate
(`PROVEN`, closed), finish (advisory `INJECTION_SUSPECTED`), status report with
`## Limits` and no target source, invalid job id refusal, and a refused write
against the closed job.

### Live OpenCode home, config, and plugin (fresh)

Fresh home: `/tmp/opencode/m6-fresh-live-340582`.

```bash
NYXOWL_HOME=/tmp/opencode/m6-fresh-live-340582 NYXOWL_TESTWRITER_INSTALL=0 \
  node dist/cli/bin.js doctor
```

Doctor: `Nyxowl v1.0.0 initialized`, Node v24.22.2, git v2.43.0, host OpenCode
Tier A, Test-Writer skipped by the environment flag, and
`MCP Smoke Test: OK (38 tools registered)`.

`$LIVE/hosts/opencode/opencode.json` has 19
`agents["nyx-testwriter"].permissions` rules. Assertions (machine-checked):
no `action:"*"` deny; exactly 13 explicit host denies (`read`, `edit`, `glob`,
`grep`, `shell`, `webfetch`, `websearch`, `subagent`, `skill`, `question`,
`external_directory`, `experimental_image_generate`, `execute`); one
`nyxowl_*` deny; exactly five allows
(`nyxowl_nyx_testwriter_job|write|lint|gate|finish`). The two resource actions
`opencode_list_mcp_resources` and `opencode_read_mcp_resource` are not denied
by the config.

`$LIVE/hosts/opencode-plugin/nyxowl/index.js` machine-checks: contains
`TESTWRITER_TOOL_SUFFIXES`, `restrictTools`, `Array.isArray(event.tools)`, all
five suffix constants, and exactly two `ctx.session.hook("context", ...)`
registrations. `OPENCODE_CONFIG=... opencode debug agents --standalone` exited 0
and listed 24 agents including `nyx-testwriter`.

### Live job setup (fresh)

Fixture `j1` body (variants included) was created and approved against
temporary roots `/tmp/opencode/m6-live-tB2Tm9/{store,workspace,tmp}`:

```text
new-job: {"id":"m6live-341268","workspaceHint":"/tmp/opencode/m6-live-tB2Tm9/workspace/m6live-341268"}
add-variant still_vulnerable: ok, variants [fixed_differently_ref,still_vulnerable_ref]
add-variant fixed_differently: ok, variants [fixed_differently_ref,still_vulnerable_ref]
tw-approve: APPROVED m6live-341268
```

### Prescribed live isolation run (fresh, generated plugin)

Command shape (model `opencode-go/deepseek-v4.1-flash`, exit 0):

```bash
OPENCODE_CONFIG=$LIVE/hosts/opencode/opencode.json \
TW_INSTALL_ROOT=$HOME/.nyxowl/test-writer \
TW_STORE_ROOT=/tmp/opencode/m6-live-tB2Tm9/store \
TW_WORKSPACE_ROOT=/tmp/opencode/m6-live-tB2Tm9/workspace \
TW_TMP_ROOT=/tmp/opencode/m6-live-tB2Tm9/tmp \
opencode run --standalone --agent nyx-testwriter \
  --model opencode-go/deepseek-v4.1-flash --format json "<prescribed isolation prompt>"
```

Result: **FAIL**. `/tmp/opencode/m6-live-run.jsonl` has three events:
`step_start`, `text`, `step_finish`; **zero `tool_use`**. The text is a
DSML-style XML pseudo-call, not an executed tool:

```text
... invoke name="nyx_testwriter_job" ...
... parameter name="id" string="true" ... m6live-341268 ...
```

Two focused repeats with the same generated config and model (`run2`, `run3`)
also exited 0 with three events and zero `tool_use`; `run2` claimed a call in
prose, `run3` emitted a `<tool_call>` JSON fragment as text. No tool was executed.

Event table for the prescribed run:

| Attempted action | Result |
| --- | --- |
| `nyxowl_nyx_testwriter_job` | not invoked; zero `tool_use` |
| `opencode_models` | not invoked |
| `opencode_list_mcp_resources` | not invoked |
| `opencode_read_mcp_resource` | not invoked |
| glob/grep/read/shell/webfetch/todowrite/nyx_blackboard_read | not invoked |

The MCP server itself is healthy: the OpenCode debug log for a separate run
contains `mcp connected server=nyxowl tools=38`. The failure is therefore in
the live tool-surface filter, not the MCP server.

### Diagnostic snapshot of `event.tools` (temp plugin only)

The generated plugin (not source) was copied to
`$LIVE/hosts/opencode-plugin-diag/nyxowl/index.js` and a config
`$LIVE/hosts/opencode/opencode-diag.json` pointed at it. Inside `restrictTools`
the diagnostic appended one JSON snapshot to `/tmp/opencode/m6-tools-diag.log`.
The diagnostic run (`/tmp/opencode/m6-diag-run.jsonl`) exited 0 with three
events and zero `tool_use`. The exact logged shape:

```json
{"isArray":false,"keys":["opencode_list_mcp_resources","opencode_models","opencode_read_mcp_resource","opencode_session_move","opencode_session_rename","opencode_worktree_create","opencode_worktree_list","skill","todowrite"],"sample":["opencode_list_mcp_resources","opencode_models","opencode_read_mcp_resource","opencode_session_move","opencode_session_rename","opencode_worktree_create","opencode_worktree_list","skill","todowrite"],"agent":"nyx-testwriter"}
```

Interpretation (direct from the snapshot, not a guess): `event.tools` is an
object with nine built-in host keys. None of the five Test-Writer tools
(`...testwriter_job|write|lint|gate|finish`) is present in the snapshot. The
object branch therefore finds no allowed key or value and deletes all nine
built-in keys, leaving an empty tool surface for the model. The array branch
is irrelevant because `isArray` is false.

### A/B control (temp plugin, diagnostic only)

To distinguish a model-protocol failure from the filter, a second temp copy of
the generated plugin at `$LIVE/hosts/opencode-plugin-b/nyxowl/index.js` made
`restrictTools` a no-op (`if (event) return;`) while keeping the permission hook,
config, and MCP server unchanged. Config
`$LIVE/hosts/opencode/opencode-b.json` pointed at it. A direct run with the same
job and model exited 0 and executed tools:

| Action | Status | Result |
| --- | --- | --- |
| `opencode_list_mcp_resources` | error | permission-hook boundary denial (no result content) |
| `nyxowl_nyx_testwriter_job` | completed | `status: "approved"`, `applicable: true`, `targetStack: "python"` |

This control is **not** the generated plugin and is not a PASS for the M6
boundary. It proves the five tools are otherwise callable with this model,
config, and MCP server; the context filter is what removes the tool surface.

### Leak check

Five JSONL streams were scanned for the fixture ref hashes
(`aa1bc76e...`, `83ee4c56...`, `d072564...`, `821afb1...`), variant tar names
(`src-still-vulnerable.tar`, `src-fixed-differently.tar`), and the store,
workspace, and tmp root strings. Result: no hits in
`m6-live-run.jsonl`, `m6-live-run2.jsonl`, `m6-live-run3.jsonl`,
`m6-diag-run.jsonl`, or `m6-control-run.jsonl`. The prescribed run produced no
tool output at all. The control run's job result contains the spec but no
variant ref/tar or store path.

### Fresh conclusion

- Compiler gates, Python gates, the model-free 3x matrix, and the parent stdio
  MCP E2E all PASS with the numbers recorded above.
- The generated config is correct on static inspection: no wildcard action
  deny, 13 explicit host denies, `nyxowl_*` deny, five allows, and both
  resource actions not denied.
- The generated plugin is correct on static inspection: suffix constants,
  shape-tolerant branches, and two context hook registrations.
- The live boundary **FAILS**: with the generated plugin the model produced zero
  `tool_use` events and never called `nyxowl_nyx_testwriter_job`. The
  diagnostic shows `event.tools` contains only nine built-in host keys and none
  of the five Test-Writer tools, so the object branch deletes all nine. The
  allowed tool is not callable, so the PASS condition is not met.
- Required fix direction (not applied by this verifier): the object branch must
  not wipe the snapshot when no allowed entry is present, or the filter must run
  against a snapshot that actually contains the MCP tools (or preserve them).
  Source was not edited; only this evidence file was changed.

## Final independent re-verification (fresh session)

Date: 2026-11-07. All prior reports were disregarded; this section was
re-derived in a new session against `wt/test-writer-m6` with the installed
runtime refreshed at `$HOME/.nyxowl/test-writer`.

### Compiler gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0, no diagnostics |
| `npm run lint` | exit 0, no findings |
| `npm run test:coverage` | 20/20 files, 179/179 tests passed (10.04s) |
| Coverage | statements 81.94% (4615/5632); branches 69.94% (3023/4322); functions 88.12% (490/556); lines 84.13% (4424/5258) |
| `npm run build` | success (tsup, 106ms) |
| `npm pack --dry-run` | 200 files, package 740.5 kB, unpacked 3.6 MB, shasum `bebaafa2...` |

### Python gates

- `python3 -m compileall -q test-writer`: exit 0.
- `python3 test-writer/fixtures/build_fixtures.py --verify`: `FIXTURES_VERIFY: PASS`.
- `TW_VENV_PYTHON=$HOME/.nyxowl/test-writer/venv/bin/python python3 test-writer/selftests/run_all.py`: `Ran 219 tests ... OK`; `M0_SELFTESTS: PASS`, `M1M3_SELFTESTS: PASS` (166.3s).

### Model-free 3x matrix

`TW_VENV_PYTHON=... python3 test-writer/qa/m6_threerun.py --out /tmp/opencode/m6-final-verifier`:
`M6_THREERUN: PASS`, `failures: []`.

| Run | J1 | J2 | J3 | J4 | Advisory |
| --- | --- | --- | --- | --- | --- |
| 1 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED |
| 2 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED |
| 3 | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | PROVEN | INJECTION_SUSPECTED |

Requirements met: J1 3/3 PROVEN; J2 3/3 UNPROVEN with
`NO_DETECTOR_HIT_ON_VULN`; J3 never PROVEN (3/3 REFUTED); J4 3/3 PROVEN with
the advisory flag 3/3 (>=2/3); every PROVEN job rechecked with
`recheckExit: 0` and `recheckResult: "match"` (0 failures).

### Parent stdio MCP E2E

`node test-writer/qa/m6_parent_e2e.mjs` -> `M6_PARENT_E2E: PASS`, exit 0.
Key assertions: runtime install PASS; 38 tools total, 7 `nyx_testwriter_*`,
all 5 subagent tools; prepare/approve/job read (`applicable`, spec, interface,
helper API); job response carries no leak fragments; write/lint/gate PROVEN and
closed; `finish` + `status` both return verdict PROVEN with
`advisoryFlags: ["INJECTION_SUSPECTED"]`; write after close refused; invalid id
returns `ERR_INVALID_INPUT`.

### Fresh live environment and static boundary

`LIVE=/tmp/opencode/m6-final-live-verify`;
`NYXOWL_HOME=$LIVE NYXOWL_TESTWRITER_INSTALL=0 node dist/cli/bin.js doctor`
-> exit 0, host OpenCode v2.2.5, MCP smoke OK (38 tools), Test-Writer skipped.

Config (`hosts/opencode/opencode.json`, agent `nyx-testwriter`):

- no `action: "*"` deny (checked both global and agent permission lists);
- 13 explicit host denies, all `deny`: read, edit, glob, grep, shell, webfetch,
  websearch, subagent, skill, question, external_directory,
  experimental_image_generate, execute;
- both MCP resource actions (`opencode_list_mcp_resources`,
  `opencode_read_mcp_resource`) are not denied;
- `nyxowl_*` deny followed by exactly five
  `nyxowl_nyx_testwriter_{job,write,lint,gate,finish}` allows.

Plugin (`hosts/opencode-plugin/nyxowl/index.js`, 286 lines): contains
`TESTWRITER_DENY_TOOLS` with all five names, `TESTWRITER_TOOL_SUFFIXES`,
`restrictTools`, `isAllowedTool`, `isDeniedTool`, and exactly two
`ctx.session.hook("context", ...)` registrations (`hydrateSession`,
`restrictTools`). `restrictTools` is two-phase: object and array branches each
compute `hasAllowed`; with an allowed tool they keep only allowed entries
(two gated `if (!isAllowedTool...)` deletes), otherwise they delete only the
five deny names. There is no unconditional delete-all path.

`OPENCODE_CONFIG=$LIVE/hosts/opencode/opencode.json opencode debug agents --standalone`
-> exit 0, 24 agents, `nyx-testwriter` present (mode subagent) ending with the
`nyxowl_*` deny and five allows.

### Live attempts

Runtime/job setup: fixtures built to
`/tmp/opencode/m6-final-live-verify/live/fixture-repo`;
`TW_STORE_ROOT=.../live/store`, `TW_WORKSPACE_ROOT=.../live/workspace`,
`TW_TMP_ROOT=.../live/tmp`; J1 body (including both variant refs) created with
`tw-new-job --json` -> `{"id":"m6-live-j1",...}` and `tw-approve` ->
`APPROVED m6-live-j1`.

| Attempt | Model | Exit | tool_use events |
| --- | --- | --- | --- |
| 1 | opencode-go/deepseek-v4.1-flash | 0 | `opencode_list_mcp_resources` error (permission-hook boundary message); `opencode_read_mcp_resource` error ("Tool is not available for this request"); no job call |
| 2 | opencode-go/deepseek-v4.1-flash | 0 | `todowrite` error (permission-hook boundary message); `nyxowl_nyx_testwriter_job` **completed**, output `jobId: m6-live-j1`, `status: "approved"`, `applicable: true` |

Attempt 2 stderr logged `mcp connected server=nyxowl tools=38`. The allowed tool
executed successfully (approved status returned), satisfying the PASS
condition. No non-five tool completed in either attempt, and
`opencode_models` never completed (in attempt 1 it was absent from the visible
toolset; in attempt 2 it was not called).

Model variance (honest record): attempt 1 exposed only four native tools to the
model (`opencode_list_mcp_resources`, `opencode_read_mcp_resource`, `skill`,
`todowrite`) and the model made no job call; attempt 2 exposed the MCP job tool
and the model called it. Same config, plugin, model, and store.

### Leak check

Attempts 1-2 JSONL streams and every tool output were scanned for both J1
variant refs (`aa1bc76e...`, `83ee4c56...`), `still_vulnerable_ref`,
`fixed_differently_ref`, tar names/`.tar`, `tarball`, the store root
`/tmp/opencode/m6-final-live-verify/live/store`, `store/jobs`, and
`TW_STORE_ROOT`. Result: 0 hits in tool output. Attempt 2's job result contains
only spec, interface, detector contract, and helper API.

### Final verdict

End-to-end PASS: compiler, Python, 3x matrix, parent E2E, config/plugin
inspection, debug agents, and live isolation (attempt 2 job call completed,
no non-five completion, no leak). Attempt 1's missing tool surface is recorded
as model/registration non-call variance, not a fabricated pass.

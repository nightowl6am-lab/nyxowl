# Test-Writer agent integration

The canonical agent definition is `agents/subagents/nyx-testwriter.md`. This
directory holds the source artifacts that predate registration; it does not
define a second prompt or a second MCP server.

## Current wiring

- `agents/subagents/nyx-testwriter.md` is the only editable prompt. The old
  standalone prompt in `SUBAGENT_PROMPT.md` is history only.
- Seven tools live in `src/mcp/engines/testwriter/`: the subagent gets
  `nyx_testwriter_job`, `nyx_testwriter_write`, `nyx_testwriter_lint`,
  `nyx_testwriter_gate`, and `nyx_testwriter_finish`; the primary gets
  `nyx_testwriter_prepare` and `nyx_testwriter_status`.
- `tools_server/tw_tools.py` from the original plan is not used. The existing
  Nyxowl MCP server brokers the fixed `/opt/test-writer/bin` wrappers.
- The Python runtime is installed under `/opt/test-writer`; the private grader
  store is `/var/lib/test-writer`. Nothing is usable until the owner installs
  the runtime.
- Host isolation (no host read/edit/write/shell/webfetch for the subagent) is
  verified in M6. Registration alone is not proof of isolation.

## Parent contract (summary)

- The primary prepares the job and dispatches the subagent with exactly
  `TW_JOB <id>`. The owner approves the spec/variants; the primary cannot.
- The primary reads the verdict from `nyx_testwriter_status`, never from the
  subagent's final message.
- The subagent may write only the staged test and may use only the five granted
  tools.
- The proof test uses the grader's `detector` fixture and is evidence for the
  `security` entry and the PR. It must not be copied into the target's normal
  test discovery; a permanent regression test is a separate adaptation.
- A missing or failed sandbox or wrapper produces a setup error, never an
  unsandboxed run.

## Status

M0 source is complete in this directory. The note that M0 did not register the
agent is historical; registration has since landed. Owner-facing install steps
are in `README_OWNER.md`, and the full contract is in `INTEGRATION.md`.

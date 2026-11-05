# Test-Writer agent prompt (historical pointer)

Canonical Nyxowl definition: `agents/subagents/nyx-testwriter.md`.

- The five tools are `nyx_testwriter_job`, `nyx_testwriter_write`,
  `nyx_testwriter_lint`, `nyx_testwriter_gate`, and `nyx_testwriter_finish`.
- The `tw-tools` stdio server in the original plan is superseded by the existing
  Nyxowl MCP server; do not add a second server.
- This standalone prompt is kept only as history; do not edit it separately.
  Change the canonical agent definition instead.

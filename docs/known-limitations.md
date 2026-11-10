# Known Limitations

- OpenCode v2.2.5 headless `opencode run --standalone` cold-start can log
  `mcp connected server=nyxowl tools=39` while the first model request sees zero
  MCP tools. This is a host bug, not a repository bug.
- The supported product path is the normal OpenCode TUI with the generated
  `opencode.json`, launched via `opencode --standalone <path>`.
- `npm run agents:live` may return `BLOCKED_HOST`; it must not be claimed as a
  live PASS.
- The deterministic CI gate is `npm run test:agents`.
- Gate receipts describe what actually ran. A GREEN verify receipt with
  `coverage: partial` or `none` means code steps passed but a browser/runtime
  surface was not exercised; the PR body renders that as `not fully verified`.
- `nyx_verify_slice` only runs a browser/e2e step when one is configured
  (`commands.e2e`/`commands.browser`, `commandsOverride`, or a package
  `test:e2e`/`e2e` script). With no configured step, browser coverage is `none`.
- The live OpenCode session keeps the MCP server process it started. Use
  `nyxowl gate-run --info` to check the running marker against the current
  worktree build, and `nyxowl gate-run --tool <name> --args '<json>'` to run a
  gate against the current build even when the host process is stale.
- `nyx_verify_slice` derives its code steps from `.github/workflows/ci.yml`
  when present (typecheck, lint, test/test:coverage, build, skills, agents), so
  it runs the same safe local commands as CI. Browser/e2e coverage remains
  separate and is reported as `none` when no step is configured.
- `nyx_model_preflight` validates against the supported non-pro roster and
  known variant sets; it never queries a provider or silently substitutes a
  model.

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
- The live OpenCode session keeps the MCP server process it started. After
  rebuilding `dist/`, restart the host session before expecting the running
  agent to use newly built tool behavior; the deterministic tests and the
  stdio smoke test exercise the rebuilt artifact directly.
- `nyx_model_preflight` validates against a static supported roster and known
  variant sets; it never queries a provider or substitutes a model.

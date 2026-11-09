# Known Limitations

- OpenCode v2.2.5 headless `opencode run --standalone` cold-start can log
  `mcp connected server=nyxowl tools=38` while the first model request sees zero
  MCP tools. This is a host bug, not a repository bug.
- The supported product path is the normal OpenCode TUI with the generated
  `opencode.json`, launched via `opencode --standalone <path>`.
- `npm run agents:live` may return `BLOCKED_HOST`; it must not be claimed as a
  live PASS.
- The deterministic CI gate is `npm run test:agents`.

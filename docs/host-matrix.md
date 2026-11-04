# Nyxowl Host Capability Matrix (`docs/host-matrix.md`)

> **Generated in Step 0 (Host Capability Verification Spike).**
> Adapters in `src/cli/adapters/` and `nyxowl doctor` reference the versions and contracts documented here.

## 1. Local Verification Environment

- **OS:** Linux x64
- **Node.js:** `v24.22.2`
- **Git:** `2.43.0`
- **Hosts detected on build machine:**
  - `agy` (Antigravity CLI): **`1.5.0`** (`/home/nightowl/.local/bin/agy`) — **Locally Verified**
  - `claude` (Claude Code): not installed on build host (adapter implements documented v1 plugin + `--settings` contract)
  - `opencode` (OpenCode): not installed on build host (adapter implements documented `OPENCODE_CONFIG` + plugin contract)
  - `codex` (Codex CLI): not installed on build host (adapter implements documented `--profile nyxowl` + TOML config contract)
  - `gemini` (Gemini CLI): not installed on build host (adapter implements documented `gemini-extension.json` contract)
  - `cursor` (Cursor IDE): not installed on build host (user-level fallback `.cursor/rules/nyxowl.mdc` + `mcp.json`)
  - `windsurf` (Windsurf IDE): not installed on build host (user-level fallback rule + `mcp_config.json`)

---

## 2. Host Matrix Summary

| Capability | Claude Code (`claude`) | OpenCode (`opencode`) | Codex CLI (`codex`) | Gemini CLI (`gemini`) | Antigravity CLI (`agy`) | Cursor (`cursor`) | Windsurf (`windsurf`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Last Verified Version** | `1.0.x` (spec) | `0.1.x` (spec) | `0.1.x` (spec) | `0.1.x` (spec) | **`1.5.0` (verified)** | `0.48.x` (spec) | `1.6.x` (spec) |
| **Delivery Mode (§8.2)** | Level 1: Session-scoped (`--plugin-dir` + `--settings`) | Level 1: Session-scoped (`OPENCODE_CONFIG`) | Level 1: Session-scoped (`--profile nyxowl`) | Level 1: Session-scoped (`-e nyxowl`) | Level 1/2: Plugin (`~/.gemini/config/plugins/nyxowl`) + `--settings` + `--agent nyxowl` | Level 2: User-level namespaced install | Level 2: User-level namespaced install |
| **Session Launch Command** | `claude --plugin-dir <pkg> --settings <pkg>/settings.json --agent nyxowl` | `OPENCODE_CONFIG=<pkg>/opencode.json opencode <path> --agent nyxowl` | `codex --profile nyxowl -C <path>` | `gemini -e nyxowl` (in `<path>`) | `agy --agent nyxowl --sandbox --mode auto --add-dir <worktreeRoot> --settings <pkg>/settings.json` | `cursor <path>` | `windsurf <path>` |
| **Primary Agent Selection** | `--agent nyxowl` (`agents/nyxowl.md`) | `agent.nyxowl` (`mode: "primary"`) | Profile instructions + skill | Extension context + `agents/nyxowl.md` | `--agent nyxowl` (`agents/nyxowl.md`) | `nyxowl.mdc` (`alwaysApply: true`) | Always-on user rule |
| **Native Subagents** | Yes (`agents/nyx-*.md`) | Yes (`agent.nyx-*`, `mode: "subagent"`) | Sequential emulation unless subagent support enabled | Yes (`agents/nyx-*.md`) | Yes (`invoke_subagent` + `agents/nyx-*.md`) | Sequential emulation | Sequential emulation |
| **Pre-Tool Hooks** | `PreToolUse` (`hooks/hooks.json`) | Plugin `tool.execute.before` | Downgraded (config-enforced unless hooks present) | `BeforeTool` (`gemini-extension.json`) | `PreToolUse` (`<plugin>/hooks.json`) | `hooks.json` (if supported, else Tier B) | None (Tier C) |
| **Session Hooks (Hydrate)** | `SessionStart`, `PreCompact` | Plugin session/compaction hook | Primary agent first-turn `nyx_context_hydrate` | `SessionStart` / primary agent first-turn | `SessionStart` + `PreInvocation` (`<plugin>/hooks.json`) | Primary agent first-turn `nyx_context_hydrate` | Primary agent first-turn `nyx_context_hydrate` |
| **OS Sandbox** | Yes (`sandbox.enabled: true`) | No (hooks + permissions) | Yes (`sandbox_mode = "workspace-write"`) | Optional (`--sandbox`) | Yes (`--sandbox`) | No | No |
| **External Worktree Pre-Auth** | `permissions.additionalDirectories` | `permission.external_directory` | `sandbox_workspace_write.writable_roots` | `includeDirectories` | `--add-dir <worktreeRoot>` | No → in-repo fallback (`.nyxowl/worktrees/`) | No → in-repo fallback (`.nyxowl/worktrees/`) |
| **MCP Registration** | `<pkg>/.mcp.json` | `mcp.nyxowl` in `opencode.json` | `[mcp_servers.nyxowl]` in profile | `mcpServers` in `gemini-extension.json` | `<plugin>/mcp_config.json` (`mcpServers.nyxowl`) | User `~/.cursor/mcp.json` | User `~/.codeium/windsurf/mcp_config.json` |
| **Confirmed Enforcement Tier** | **Tier A (+sandbox)** | **Tier A** | **Tier B (+sandbox)** | **Tier A/B** | **Tier A (+sandbox)** | **Tier B** | **Tier C** |

---

## 3. Verified Protocol Details

### 3.1 Antigravity (`agy` v1.5.0) — Locally Verified
- **Sources:**
  - `agy --help`, `agy help plugin`, `agy plugin validate --strict --json`
  - Official docs: `https://antigravity.google/docs/plugins`, `https://antigravity.google/docs/hooks`, `https://antigravity.google/docs/mcp`, `https://antigravity.google/docs/cli/reference`
- **Plugin Bundle Layout (`<plugin_dir>/`):**
  - `plugin.json`: Only allowed top-level fields: `name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, `author`, `homepage`, `repository`, `disabled`. Unknown top-level fields are silently discarded.
  - `mcp_config.json`: `{ "mcpServers": { "nyxowl": { "command": "<node>", "args": ["<cli>", "mcp"], "env": { ... } } } }`
  - `hooks.json` (must be at plugin root `<plugin_dir>/hooks.json`, not `hooks/hooks.json`):
    ```json
    {
      "nyxowl-guard": {
        "PreToolUse": [
          {
            "matcher": "*",
            "hooks": [
              {
                "type": "command",
                "command": "nyxowl hook guard",
                "timeout": 10
              }
            ]
          }
        ],
        "SessionStart": [
          {
            "type": "command",
            "command": "nyxowl hook session-start",
            "timeout": 10
          }
        ]
      }
    }
    ```
  - **Hook Stdin/Stdout Contract (protojson camelCase):**
    - `PreToolUse` stdin: `{ "toolCall": { "name": "run_command" | "read_file" | "write_file" | "edit_file" | ..., "args": { ... } }, "stepIdx": 1, "conversationId": "...", "workspacePaths": ["/path"] }`
    - `PreToolUse` stdout: `{ "decision": "allow" | "deny" | "ask" | "force_ask", "reason": "..." }`
    - `SessionStart` stdout: `{ "injectSteps": [{ "systemMessage": { "systemMessage": "<hydrate digest>" } }] }`
  - `rules/AGENTS.md`: Consolidated Markdown rules (no frontmatter, ≤ 24,000 bytes).
  - `skills/<skill>/SKILL.md`: YAML frontmatter with required `name` and `description`.
  - `agents/<agent>.md`: Agent definitions.

### 3.2 Claude Code (`claude`)
- **Sources:** `https://docs.anthropic.com/en/docs/claude-code/settings`, `https://docs.anthropic.com/en/docs/claude-code/hooks`, `https://docs.anthropic.com/en/docs/claude-code/sub-agents`
- **Precedence:** `deny` rules are evaluated before `allow` rules. Therefore `.env` variants (`.env`, `.env.local`, `.env.development`, `.env.production`, `.env.test`, `.env.staging`, `.env.*.local`) are explicitly enumerated in `permissions.deny`, while `.env.example`/`.env.sample`/`.env.template`/`.env.defaults` are allowed and further checked by `nyxowl hook guard`.
- **Hook Stdin/Stdout Contract:**
  - `PreToolUse` stdin: `{ "session_id": "...", "cwd": "...", "hook_event_name": "PreToolUse", "tool_name": "Bash" | "Read" | "Edit" | "Write", "tool_input": { ... } }`
  - `PreToolUse` stdout: `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow" | "deny" | "ask", "permissionDecisionReason": "..." } }` (or exit code `2` with stderr reason for hard block).
  - `SessionStart` / `PreCompact` stdout: `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "<hydrate digest>" } }`.

### 3.3 OpenCode (`opencode`)
- **Sources:** `https://opencode.ai/docs/config`, `https://opencode.ai/docs/permissions`, `https://opencode.ai/docs/agents`, `https://opencode.ai/docs/plugins`
- **Precedence:** Last matching rule wins. Example allows (`*.env.example`, `*.env.sample`, `*.env.template`, `*.env.defaults`) are emitted **after** `.env*` deny patterns.
- **Launch:** `OPENCODE_CONFIG=<pkg>/opencode.json opencode <path> --agent nyxowl`

### 3.4 Codex CLI (`codex`)
- **Sources:** `https://github.com/openai/codex`
- **Config:** TOML profile `[profiles.nyxowl]` with `sandbox_mode = "workspace-write"`, `sandbox_workspace_write.writable_roots = ["<worktreeRoot>"]`, `[mcp_servers.nyxowl]`.
- **Fallback instructions:** Managed `<!-- nyxowl:begin --> ... <!-- nyxowl:end -->` block (≤ 300 tokens) in `~/.codex/AGENTS.md` if profile instructions are not supported by the installed version.

### 3.5 Gemini CLI (`gemini`)
- **Sources:** `https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions.md`, `https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks.md`
- **Extension Manifest:** `gemini-extension.json` with `name`, `version`, `mcpServers`, `contextFileName`, `excludeTools`.
- **Hooks:** `BeforeTool` / `SessionStart` outputting `{ "decision": "allow" | "deny" | "ask", "reason": "..." }`.

### 3.6 Cursor & Windsurf (IDE Fallbacks)
- **Cursor:** User-level rule + `~/.cursor/mcp.json`. Uses in-repo worktree fallback (`<repo>/.nyxowl/worktrees/<slug>` excluded via `.git/info/exclude`).
- **Windsurf:** User-level rule + `~/.codeium/windsurf/mcp_config.json`. Uses in-repo worktree fallback.

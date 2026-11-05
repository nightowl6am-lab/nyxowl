# Nyxowl Host Capability Matrix (`docs/host-matrix.md`)

> **Generated in Step 0 (Host Capability Verification Spike).**
> Adapters in `src/cli/adapters/` and `nyxowl doctor` reference the versions and contracts documented here.

## 1. Local Verification Environment

- **OS:** Linux x64 (only supported OS)
- **Node.js:** `v24.22.2`
- **Git:** `2.43.0`
- **Hosts detected on build machine:**
  - `opencode` (OpenCode): **`2.2.5`** — **Locally Verified** (native v2 config + plugin directory)
  - `agy` (Antigravity CLI): **`1.5.0`** (`/home/nightowl/.local/bin/agy`) — **Locally Verified**
  - `claude` (Claude Code): not installed on build host (adapter implements documented v1 plugin + `--settings` contract)
  - `codex` (Codex CLI): not installed on build host (adapter implements documented `--profile nyxowl` + TOML config contract)
  - `cursor` (Cursor IDE): not installed on build host (user-level fallback `.cursor/rules/nyxowl.mdc` + `mcp.json`)

---

## 2. Host Matrix Summary

| Capability | OpenCode (`opencode`, default priority 1) | Claude Code (`claude`, priority 2) | Codex CLI (`codex`, priority 3) | Antigravity CLI (`agy`, priority 4) | Cursor (`cursor`, priority 5) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Last Verified Version** | **`2.2.5` (verified)** | `1.0.x` (spec) | `0.1.x` (spec) | **`1.5.0` (verified)** | `0.48.x` (spec) |
| **Delivery Mode (§8.2)** | Level 1: Session-scoped (`OPENCODE_CONFIG`) | Level 1: Session-scoped (`--plugin-dir` + `--settings`) | Level 1: Session-scoped (`--profile nyxowl`) | Level 1/2: Plugin (`~/.nyxowl/hosts/antigravity/plugin`) + `--settings` + `--agent nyxowl` | Level 2: User-level namespaced install |
| **Session Launch Command** | `OPENCODE_CONFIG=<pkg>/opencode.json opencode --standalone <path>` | `claude --plugin-dir <pkg> --settings <pkg>/settings.json --agent nyxowl` | `codex --profile nyxowl -C <path>` | `agy --agent nyxowl --sandbox --mode auto --add-dir <worktreeRoot> --settings <pkg>/settings.json` | `cursor <path>` |
| **Primary Agent Selection** | `default_agent: "nyxowl"` (`agents.nyxowl`) | `--agent nyxowl` (`agents/nyxowl.md`) | Profile instructions + skill | `--agent nyxowl` (`agents/nyxowl.md`) | `nyxowl.mdc` (`alwaysApply: true`) |
| **Native Subagents** | Yes (`agents.nyx-*`, `mode: "subagent"`) | Yes (`agents/nyx-*.md`) | Sequential emulation unless subagent support enabled | Yes (`invoke_subagent` + `agents/nyx-*.md`) | Sequential emulation |
| **Pre-Tool Hooks** | Plugin `ctx.permission.hook("evaluate")` | `PreToolUse` (`hooks/hooks.json`) | Downgraded (config-enforced unless hooks present) | `PreToolUse` (`<plugin>/hooks.json`) | `hooks.json` (if supported, else Tier B) |
| **Session Hooks (Hydrate)** | Plugin `ctx.session.hook("context")` | `SessionStart`, `PreCompact` | Primary agent first-turn `nyx_context_hydrate` | `SessionStart` + `PreInvocation` (`<plugin>/hooks.json`) | Primary agent first-turn `nyx_context_hydrate` |
| **OS Sandbox** | No (hooks + permissions) | Yes (`sandbox.enabled: true`) | Yes (`sandbox_mode = "workspace-write"`) | Yes (`--sandbox`) | No |
| **External Worktree Pre-Auth** | `permissions` `external_directory` rules | `permissions.additionalDirectories` | `sandbox_workspace_write.writable_roots` | `--add-dir <worktreeRoot>` | No → in-repo fallback (`.nyxowl/worktrees/`) |
| **MCP Registration** | `mcp.servers.nyxowl` in `opencode.json` | `<pkg>/.mcp.json` | `[mcp_servers.nyxowl]` in profile | `<plugin>/mcp_config.json` (`mcpServers.nyxowl`) | User `~/.cursor/mcp.json` |
| **Confirmed Enforcement Tier** | **Tier A** | **Tier A (+sandbox)** | **Tier B (+sandbox)** | **Tier A (+sandbox)** | **Tier B** |

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

### 3.3 OpenCode (`opencode` v2.2.5) — Locally Verified
- **Sources:** `https://opencode.ai/v2/docs/config`, `https://opencode.ai/v2/docs/permissions`, `https://opencode.ai/v2/docs/agents`, `https://opencode.ai/v2/docs/plugins`
- **Native v2 config (`opencode.json`):** `$schema`, `default_agent: "nyxowl"`, `mcp.servers.nyxowl`, ordered `permissions` array (`{action,resource,effect}`), `agents` map with inline `system` prompts, `commands` map, and `plugins: ["<hosts>/opencode-plugin/nyxowl"]`.
- **Precedence:** Last matching rule wins. Example allows (`.env.example`, `.env.sample`, `.env.template`) are emitted **after** `.env*` deny patterns.
- **Plugin:** Plain ESM directory `<hosts>/opencode-plugin/nyxowl/index.js` (a sibling of `hosts/opencode`, outside the config directory to prevent auto-discovery duplicates); registers `ctx.permission.hook("evaluate")` and `ctx.session.hook("context")`. V1 hooks (`tool.execute.before`, `experimental.session.compacting`) are not used.
- **Launch:** `OPENCODE_CONFIG=<pkg>/opencode.json opencode --standalone <path>`

### 3.4 Codex CLI (`codex`)
- **Sources:** `https://github.com/openai/codex`
- **Config:** TOML profile `[profiles.nyxowl]` with `sandbox_mode = "workspace-write"`, `sandbox_workspace_write.writable_roots = ["<worktreeRoot>"]`, `[mcp_servers.nyxowl]`.
- **Fallback instructions:** Managed `<!-- nyxowl:begin --> ... <!-- nyxowl:end -->` block (≤ 300 tokens) in `~/.codex/AGENTS.md` if profile instructions are not supported by the installed version.

### 3.5 Cursor (IDE Fallback)
- **Cursor:** User-level rule + `~/.cursor/mcp.json`. Uses in-repo worktree fallback (`<repo>/.nyxowl/worktrees/<slug>` excluded via `.git/info/exclude`).

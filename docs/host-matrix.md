# Nyxowl Host Capability Matrix (`docs/host-matrix.md`)

> **OpenCode v2.2.5 is the only supported host.**
> The adapter in `src/cli/adapters/opencode.ts` and `nyxowl doctor` reference the version and contract documented here.

## 1. Local Verification Environment

- **OS:** Linux x64 (only supported OS)
- **Node.js:** `v24.22.2`
- **Git:** `2.43.0`
- **Host detected on build machine:**
  - `opencode` (OpenCode): **`2.2.5`** — **Locally Verified** (native v2 config + plugin directory)

---

## 2. Host Matrix Summary

| Capability | OpenCode (`opencode`, v2.2.5) |
| :--- | :--- |
| **Last Verified Version** | **`2.2.5` (verified)** |
| **Delivery Mode (§8.2)** | Level 1: Session-scoped (`OPENCODE_CONFIG`) |
| **Session Launch Command** | `OPENCODE_CONFIG=<pkg>/opencode.json opencode --standalone <path>` |
| **Primary Agent Selection** | `default_agent: "nyxowl"` (`agents.nyxowl`) |
| **Native Subagents** | Yes (`agents.nyx-*`, `mode: "subagent"`) |
| **Pre-Tool Hooks** | Plugin `ctx.permission.hook("evaluate")` |
| **Session Hooks (Hydrate)** | Plugin `ctx.session.hook("context")` |
| **OS Sandbox** | No (hooks + permissions) |
| **External Worktree Pre-Auth** | `permissions` `external_directory` rules |
| **MCP Registration** | `mcp.servers.nyxowl` in `opencode.json` |
| **Confirmed Enforcement Tier** | **Tier A** |

---

## 3. Verified Protocol Details

### 3.1 OpenCode (`opencode` v2.2.5) — Locally Verified

- **Sources:** `https://opencode.ai/v2/docs/config`, `https://opencode.ai/v2/docs/permissions`, `https://opencode.ai/v2/docs/agents`, `https://opencode.ai/v2/docs/plugins`
- **Native v2 config (`opencode.json`):** `$schema`, `default_agent: "nyxowl"`, `mcp.servers.nyxowl`, ordered `permissions` array (`{action,resource,effect}`), `agents` map with inline `system` prompts, `commands` map, and `plugins: ["<hosts>/opencode-plugin/nyxowl"]`.
- **Precedence:** Last matching rule wins. Example allows (`.env.example`, `.env.sample`, `.env.template`) are emitted **after** `.env*` deny patterns.
- **Plugin:** Plain ESM directory `<hosts>/opencode-plugin/nyxowl/index.js` (a sibling of `hosts/opencode`, outside the config directory to prevent auto-discovery duplicates); registers `ctx.permission.hook("evaluate")` and `ctx.session.hook("context")`. V1 hooks (`tool.execute.before`, `experimental.session.compacting`) are not used.
- **Launch:** `OPENCODE_CONFIG=<pkg>/opencode.json opencode --standalone <path>`
- **Worktrees:** External at `~/.nyxowl/worktrees/<repo-id>/<slug>/`; the generated `external_directory` rules pre-authorize the worktree root.
- **Permissions:** Ordered read/edit/shell/webfetch/external-directory rules. Secret paths (`.env*`, keys, credentials, `~/.nyxowl/secrets/**`) deny before example-file allows, and red-line commands ask.
- **Skills:** 11 authored packages at `agents/skills/<agent-id>/`. Ten are **native**: the host reads the absolute `skills` root in `opencode.json`, advertises only the skill id/name/description, and the model loads the body on demand with the `skill` tool. `nyx-testwriter` is **inline**: its text and selected references are embedded in that agent's system prompt under `## Agent Skill`. Each agent gets per-agent `skill` permissions: deny `*`, then allow only its exact id (testwriter denies all). The generated host root is `~/.nyxowl/hosts/opencode/skills/`, and stale skill directories are pruned on every regeneration. `agents/skills.lock.json` pins provenance and `npm run skills:verify` checks it offline.
- **No other hosts:** Nyxowl does not ship adapters, templates, detection entries, or documentation for any other coding host.

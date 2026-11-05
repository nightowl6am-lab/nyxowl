# Nyxowl (`nyxowl`)

**Principal Tech Lead, 9 Specialized Subagents & 7-Engine Runtime MCP Server for Terminal and IDE Coding Hosts.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)

---

## 2-Command Quickstart

```bash
npm install -g nyxowl
nyxowl /path/to/your/project
```

That's it. On first run, `nyxowl` automatically:
1. Initializes `~/.nyxowl/` (`0700`) and generates your local HMAC-SHA256 receipt signing key (`0600`).
2. Verifies the SHA-256 integrity of all 16 bundled third-party skills (`skills-vendor/`).
3. Detects your installed coding hosts (`opencode`, `claude`, `codex`, `agy`, `cursor`) and builds session-scoped packages under `~/.nyxowl/hosts/<host>/`. **OpenCode is the first-class/default host (priority 1).** Nyxowl v1 is **Linux-only** (including WSL2).
4. Classifies `/path/to/your/project` (empty folder → Greenfield bootstrap; untracked files → Adopt mode with secret & 50 MB guard; Git repo → isolated worktree) and launches your preferred host with the `nyxowl` Principal Tech Lead agent preselected.

**Zero project footprint:** Nyxowl never writes `.claude/`, `.cursor/`, `AGENTS.md`, or SQLite files into your repository unless you explicitly run `nyxowl init --project`.

---

## Host Support & Security Tiers

OpenCode is the first-class/default host (priority 1). Nyxowl v1 runs on **Linux only** (including WSL2).

| Host | Binary | Security Tier | Delivery Mode | Worktree Root |
| :--- | :--- | :---: | :--- | :--- |
| **OpenCode** (default, priority 1) | `opencode` | **Tier A** | Session-scoped (`OPENCODE_CONFIG`, native v2 config + plugin directory) | External (`~/.nyxowl/worktrees/<repo-id>/`) |
| **Claude Code** (priority 2) | `claude` | **Tier A** | Session-scoped (`--plugin-dir`, `--settings`, `--agent nyxowl`) | External (`~/.nyxowl/worktrees/<repo-id>/`) |
| **OpenAI Codex CLI** (priority 3) | `codex` | **Tier B** | Session-scoped (`CODEX_HOME`, `--profile nyxowl`) | External (`~/.nyxowl/worktrees/<repo-id>/`) |
| **Google Antigravity** (priority 4) | `agy` | **Tier A** | Session-scoped (`--agent nyxowl`, `--add-dir`, `--sandbox`) | External (`~/.nyxowl/worktrees/<repo-id>/`) |
| **Cursor** (priority 5) | `cursor` | **Tier C** | User-level namespaced (`~/.cursor/rules/nyxowl.mdc`) | In-repo fallback (`.nyxowl/worktrees/`) |

See [`docs/host-matrix.md`](./docs/host-matrix.md) for the full capability verification matrix.

---

## The 10-Role Product & Engineering Team

1. **`nyxowl`** (`primary`) — **Principal Tech Lead & Orchestrator:** Manages isolated worktrees, promotes Blackboard contracts, dispatches vertical slices, and gates PRs on cryptographic receipts.
2. **`nyx-product`** (`subagent`, tainted) — **Product & Market Intelligence Strategist:** Side-effect-free web research (`nyx_web_fetch` + `nyx_docs_ground`) publishing cited `untrusted` Blackboard PRDs.
3. **`nyx-architect`** (`subagent`, read-only) — **Polyglot System & Domain Architect:** AST navigation (`nyx_symbol_skeleton`, `nyx_trace_symbol`), seam contracts, and Strike-3 circuit-breaker recovery.
4. **`nyx-designer`** (`subagent`) — **Product UI/UX Designer & Design Systems:** WCAG AA tokens, layouts, and component primitives.
5. **`nyx-db`** (`subagent`) — **Database, Migration, RLS & Seed Engineer:** Zero-downtime migrations, ORM models, and Postgres RLS policies.
6. **`nyx-api`** (`subagent`) — **Polyglot Backend & Distributed Systems:** API routes, validation, authz, rate limiting, and backend tests.
7. **`nyx-ui`** (`subagent`) — **Frontend Implementation & State Engineer:** Client views, state management, and typed API hooks.
8. **`nyx-sec`** (`subagent`) — **Offensive Red-Team Exploit Prober & AppSec:** Live loopback exploit probing (`nyx_exploit_probe`) and dependency/secret audits.
9. **`nyx-probe`** (`subagent`) — **Surgical Debugger, Runtime Prober & QA:** Stack trace isolation (`nyx_debug_isolate`), process management (`nyx_proc`), and `nyx_verify_slice`.
10. **`nyx-devops`** (`subagent`) — **Worktree PRs, Docker, CI/CD & Infra:** Worktree sync, `.env.example` drift alignment, and container/CI hygiene.

---

## The 7 Heavy Runtime MCP Engines (31 Tools)

- **Engine 1 (`shield/`):** `nyx_env_inspect`, `nyx_web_fetch`, `nyx_sanitize_untrusted`, `nyx_dep_guard` + Exact-Value & Entropy Output Redactor.
- **Engine 2 (`bootstrap-navigator/`):** `nyx_env_doctor`, `nyx_project_bootstrap`, `nyx_dna_extract`, `nyx_dna_get`, `nyx_symbol_skeleton`, `nyx_trace_symbol`.
- **Engine 3 (`seam/`):** `nyx_seam_check`, `nyx_pkg_verify`, `nyx_docs_ground`.
- **Engine 4 (`worktree-slice/`):** `nyx_worktree_start`, `nyx_worktree_manage`, `nyx_slice_checkpoint`, `nyx_slice_rewind`, `nyx_worktree_pr`.
- **Engine 5 (`blackboard/`):** `nyx_blackboard_publish`, `nyx_blackboard_read`, `nyx_lock_acquire`, `nyx_lock_release`, `nyx_task_dispatch`.
- **Engine 6 (`probe-exploit/`):** `nyx_debug_isolate`, `nyx_proc`, `nyx_slop_check`, `nyx_verify_slice`, `nyx_exploit_probe`.
- **Engine 7 (`context/`):** `nyx_context_hydrate`, `nyx_task_handoff`, `nyx_artifact_read`.

---

## CLI Reference

```bash
nyxowl [path] [--host <id>] [--include-dirty]   # Setup (if first run) and launch host session
nyxowl doctor                                   # Verify runtimes, hosts, skills, and MCP server
nyxowl status [path]                            # Show worktrees, slices, strikes, locks, receipts
nyxowl handoff [path]                           # Print latest task handoff & hydrate digest
nyxowl worktree list|prune|remove [<slug>]      # Manage isolated Nyxowl worktrees
nyxowl receipts verify [<id>]                   # Verify receipt HMACs and working-tree bindings
nyxowl github connect                           # Configure optional Mode A GitHub App credentials
nyxowl init --project [--target <host>]         # Write optional committable project config
nyxowl relink <old-path> <new-path>             # Migrate state after moving a repository
nyxowl uninstall [--purge]                      # Restore user configs and remove Nyxowl files
```

---

## Updating Nyxowl

Upgrade with `npm install -g nyxowl@latest`, then run `nyxowl doctor` to verify runtimes, hosts, skills, and MCP tool registration. State in `~/.nyxowl/` persists across upgrades, and host packages regenerate automatically. See [`docs/updating.md`](./docs/updating.md) for upgrade, verification, rollback, and state guidance.

---

## License

Apache-2.0 — see [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

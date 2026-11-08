# Nyxowl (`nyxowl`)

**OpenCode-only: Principal Tech Lead, 10 Specialized Subagents & 8-Engine Runtime MCP Server.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)

---

## 2-Command Quickstart

Requires OpenCode v2.2.5 on PATH (`npm install -g opencode-ai`).

```bash
npm install -g nyxowl
nyxowl /path/to/your/project
```

That's it. On first run, `nyxowl` automatically:
1. Initializes `~/.nyxowl/` (`0700`) and generates your local HMAC-SHA256 receipt signing key (`0600`).
2. Ships 11 per-agent skill slots at `agents/skills/<agent-id>/SKILL.md` (empty until the owner authors them) and reports the filled/empty count.
3. Detects your installed OpenCode host (`opencode`) and builds its session-scoped package under `~/.nyxowl/hosts/opencode/`. **OpenCode v2.2.5 is the only supported host.** Nyxowl v1 is **Linux-only** (including WSL2).
4. Classifies `/path/to/your/project` (empty folder → Greenfield bootstrap; untracked files → Adopt mode with secret & 50 MB guard; Git repo → isolated worktree) and launches OpenCode with the `nyxowl` Principal Tech Lead agent preselected.
5. Installs the rootless Test-Writer runtime under `~/.nyxowl/test-writer` (or `$NYXOWL_HOME/test-writer`) using Python 3 with venv/pip. No extra commands or root are required; if Python is unavailable, the rest of Nyxowl still launches and the Test-Writer tools stay fail-closed.

**Zero project footprint:** Nyxowl never writes `AGENTS.md` or SQLite files into your repository unless you explicitly run `nyxowl init --project`.

---

## Host Support & Security Tiers

OpenCode v2.2.5 is the only supported host. Nyxowl v1 runs on **Linux only** (including WSL2).

| Host | Binary | Security Tier | Delivery Mode | Worktree Root |
| :--- | :--- | :---: | :--- | :--- |
| **OpenCode** (v2.2.5) | `opencode` | **Tier A** | Session-scoped (`OPENCODE_CONFIG`, native v2 config + plugin directory) | External (`~/.nyxowl/worktrees/<repo-id>/`) |

See [`docs/host-matrix.md`](./docs/host-matrix.md) for the full capability details.

---

## The 11-Role Product & Engineering Team

1. **`nyxowl`** (`primary`) — **Principal Tech Lead & Orchestrator:** Manages isolated worktrees, promotes Blackboard contracts, dispatches vertical slices, and gates PRs on cryptographic receipts.
2. **`nyx-product`** (`subagent`, tainted) — **Product & Market Intelligence Strategist:** Side-effect-free web research (`nyx_web_fetch` + `nyx_docs_ground`) publishing cited `untrusted` Blackboard PRDs.
3. **`nyx-architect`** (`subagent`, read-only) — **Polyglot System & Domain Architect:** AST navigation (`nyx_symbol_skeleton`, `nyx_trace_symbol`), seam contracts, and Strike-3 circuit-breaker recovery.
4. **`nyx-designer`** (`subagent`) — **Product UI/UX Designer & Design Systems:** WCAG AA tokens, layouts, and component primitives.
5. **`nyx-db`** (`subagent`) — **Database, Migration, RLS & Seed Engineer:** Zero-downtime migrations, ORM models, and Postgres RLS policies.
6. **`nyx-api`** (`subagent`) — **Polyglot Backend & Distributed Systems:** API routes, validation, authz, rate limiting, and backend tests.
7. **`nyx-ui`** (`subagent`) — **Frontend Implementation & State Engineer:** Client views, state management, and typed API hooks.
8. **`nyx-sec`** (`subagent`) — **Offensive Red-Team Exploit Prober & AppSec:** Live loopback exploit probing (`nyx_exploit_probe`) and dependency/secret audits.
9. **`nyx-testwriter`** (`subagent`) — **Security Fix Test-Writer & Proof Engineer:** Writes one pytest proof test for an owner-approved job and submits it to the fail-closed `tw-gate` grader; the proof is grader evidence, not a repo regression test. Python-only v1, non-Python jobs return `NA`.
10. **`nyx-probe`** (`subagent`) — **Surgical Debugger, Runtime Prober & QA:** Stack trace isolation (`nyx_debug_isolate`), process management (`nyx_proc`), and `nyx_verify_slice`.
11. **`nyx-devops`** (`subagent`) — **Worktree PRs, Docker, CI/CD & Infra:** Worktree sync, `.env.example` drift alignment, and container/CI hygiene.

---

## The 8 Heavy Runtime MCP Engines (38 Tools)

- **Engine 1 (`shield/`):** `nyx_env_inspect`, `nyx_web_fetch`, `nyx_sanitize_untrusted`, `nyx_dep_guard` + Exact-Value & Entropy Output Redactor.
- **Engine 2 (`bootstrap-navigator/`):** `nyx_env_doctor`, `nyx_project_bootstrap`, `nyx_dna_extract`, `nyx_dna_get`, `nyx_symbol_skeleton`, `nyx_trace_symbol`.
- **Engine 3 (`seam/`):** `nyx_seam_check`, `nyx_pkg_verify`, `nyx_docs_ground`.
- **Engine 4 (`worktree-slice/`):** `nyx_worktree_start`, `nyx_worktree_manage`, `nyx_slice_checkpoint`, `nyx_slice_rewind`, `nyx_worktree_pr`.
- **Engine 5 (`blackboard/`):** `nyx_blackboard_publish`, `nyx_blackboard_read`, `nyx_lock_acquire`, `nyx_lock_release`, `nyx_task_dispatch`.
- **Engine 6 (`probe-exploit/`):** `nyx_debug_isolate`, `nyx_proc`, `nyx_slop_check`, `nyx_verify_slice`, `nyx_exploit_probe`.
- **Engine 7 (`context/`):** `nyx_context_hydrate`, `nyx_task_handoff`, `nyx_artifact_read`.
- **Engine 8 (`testwriter/`):** `nyx_testwriter_job`, `nyx_testwriter_write`, `nyx_testwriter_lint`, `nyx_testwriter_gate`, `nyx_testwriter_finish` for `nyx-testwriter`, plus owner-only `nyx_testwriter_prepare` and `nyx_testwriter_status`. Brokers to `~/.nyxowl/test-writer` over fixed wrappers, fails closed when the runtime is absent, and stages tests outside the repository at `~/tw-jobs/<id>/tests/test_<id>.py`.

---

## CLI Reference

```bash
nyxowl [path] [--host <id>] [--include-dirty]   # Setup (if first run) and launch OpenCode
nyxowl doctor                                   # Verify runtimes, OpenCode status, skill slots, and MCP server
nyxowl status [path]                            # Show worktrees, slices, strikes, locks, receipts
nyxowl handoff [path]                           # Print latest task handoff & hydrate digest
nyxowl worktree list|prune|remove [<slug>]      # Manage isolated Nyxowl worktrees
nyxowl receipts verify [<id>]                   # Verify receipt HMACs and working-tree bindings
nyxowl testwriter install|status                # Install or inspect the rootless Test-Writer runtime
nyxowl github connect                           # Configure optional Mode A GitHub App credentials
nyxowl init --project                           # Write optional committable project config
nyxowl relink <old-path> <new-path>             # Migrate state after moving a repository
nyxowl uninstall [--purge]                      # Restore user configs and remove Nyxowl files
```

---

## Updating Nyxowl

Upgrade with `npm install -g nyxowl@latest`, then run `nyxowl doctor` to verify runtimes, OpenCode status, skill slots, Test-Writer status, and a live MCP `ListTools` round-trip. State in `~/.nyxowl/` persists across upgrades, and the OpenCode package regenerates automatically. If the Test-Writer runtime is missing after an upgrade, run `nyxowl testwriter install`. See [`docs/updating.md`](./docs/updating.md) for upgrade, verification, rollback, and state guidance.

The committed master specification is [`PLAN.md`](./PLAN.md); release steps are in [`docs/release.md`](./docs/release.md).

---

## License

Apache-2.0 — see [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

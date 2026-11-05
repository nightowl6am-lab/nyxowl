# Changelog

All notable changes to `nyxowl` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- Removed **Gemini CLI** and **Windsurf** host adapters, templates, detection entries, configuration values, and documentation. Claude Code, OpenCode, Codex CLI, Antigravity (`agy`), and Cursor remain supported.
- Nyxowl is now **Linux-only** (including WSL2). macOS is no longer supported; `package.json`, CI, and preflight checks reject non-Linux platforms.

### Changed
- **OpenCode is now the first-class/default host (priority 1)**, followed by Claude Code, Codex, Antigravity, and Cursor.
- Migrated the OpenCode adapter and plugin to the installed **OpenCode v2.2.5** contract: native `opencode.json` (`default_agent`, ordered `permissions`, `agents` with inline `system`, `commands`, `mcp.servers.nyxowl`, and a `plugins` directory), plus an ESM plugin using `ctx.permission.hook("evaluate")` and `ctx.session.hook("context")`. Launch is now `opencode --standalone <path>`.
- First-run setup now always generates the OpenCode package and only generates Claude, Codex, Antigravity, and Cursor packages when those hosts are detected.

### Added
- **Test-Writer subagent:** Added `nyx-testwriter` and seven brokered tools (`nyx_testwriter_job`, `nyx_testwriter_write`, `nyx_testwriter_lint`, `nyx_testwriter_gate`, `nyx_testwriter_finish`, `nyx_testwriter_prepare`, `nyx_testwriter_status`) with per-role tool scoping, Python-only v1 jobs, and a fail-closed `/opt/test-writer` broker that never receives the canary, variants, mutants, or raw target output.
- **Docs:** Added `docs/updating.md` (upgrade, verification, rollback, and state-preservation guide), an "Updating Nyxowl" section in the README, and `CHANGELOG.md` to the published package files. Added docs link-integrity and package-manifest tests.
- **Grammar integrity:** Added `data/grammars/manifest.json` pinning the byte length and SHA-256 of the vendored Python, Go, and Rust tree-sitter grammars. Grammars are verified from the same directory as the `.wasm`, and only verified bytes are passed to the loader.
- **Bounded scanning:** `nyx_symbol_skeleton` now enforces a 2 MiB file cap and a 50,000-line cap, rejecting oversized files with `ERR_FILE_TOO_LARGE`. A 2,000,000-character parse cap, a maximum AST depth of 200, and a 50,000-node traversal budget make parsing fall back to the legacy regex outline when exceeded.

### Changed
- **Engine 2 AST accuracy:** `nyx_symbol_skeleton` now parses Python, Go, and Rust with vendored tree-sitter WebAssembly grammars (offline, no runtime network) instead of regex-only outlines, preserving the legacy outline as a fallback when a grammar is unavailable. Added language-aware symbol classification to `nyx_trace_symbol` (definitions, imports, and call sites for Python/Go/Rust, with symbol-aware import detection for TS/JS). Vendored `tree-sitter-wasms@0.1.13` grammars for Python, Go, and Rust under `data/grammars/`.
- **Cache bounds:** Grammar languages are cached per path plus verified digest (FIFO, max 32), and skeleton results are cached FIFO with a maximum of 256 entries.
- **Version single-source:** The MCP server version, bootstrap commit trailers, and PR footer now derive from `NYXOWL_VERSION` instead of hardcoded `1.0.0` literals.

## [1.0.0] - 2026-11-04

### Added
- **Universal CLI & Zero-Footprint Launcher (`src/cli/`):**
  - First-run setup (`~/.nyxowl/` `0700`, `receipt.key` `0600`, bundled skill SHA-256 verification, host detection).
  - Automatic folder classification (`empty` greenfield, `adopt-no-git`, `git-repo` with dirty-tree isolation).
  - Session-scoped host adapters for **Claude Code**, **OpenCode**, **OpenAI Codex CLI**, **Gemini CLI**, **Google Antigravity (`agy`)**, **Cursor**, and **Windsurf**.
  - Self-scoping, fail-safe host hooks (`guard`, `edit-guard`, `session-start`, `pre-compact`) with `< 150ms` p95 latency.
- **7 Heavy Runtime MCP Engines (31 `nyx_*` tools in `src/mcp/engines/`):**
  - **Engine 1 (`shield/`):** `nyx_env_inspect`, `nyx_web_fetch` (SSRF & DNS-rebinding firewall), `nyx_sanitize_untrusted`, `nyx_dep_guard` (Levenshtein typosquatting + OSV + fail-closed offline), and Exact-Value + Entropy Output Redactor.
  - **Engine 2 (`bootstrap-navigator/`):** `nyx_env_doctor`, `nyx_project_bootstrap` (Greenfield + Adopt mode with secret & 50 MB guard), `nyx_dna_extract`, `nyx_dna_get`, `nyx_symbol_skeleton` (≥80% token reduction), and `nyx_trace_symbol`.
  - **Engine 3 (`seam/`):** `nyx_seam_check` (DB ↔ ORM ↔ API ↔ UI ↔ Env graph diff), `nyx_pkg_verify`, and `nyx_docs_ground`.
  - **Engine 4 (`worktree-slice/`):** `nyx_worktree_start`, `nyx_worktree_manage`, `nyx_slice_checkpoint` (shadow refs via `GIT_INDEX_FILE`), `nyx_slice_rewind`, and `nyx_worktree_pr` (HMAC receipt gate + diff secret scan).
  - **Engine 5 (`blackboard/`):** `nyx_blackboard_publish`, `nyx_blackboard_read`, `nyx_lock_acquire`, `nyx_lock_release`, and `nyx_task_dispatch`.
  - **Engine 6 (`probe-exploit/`):** `nyx_debug_isolate`, `nyx_proc`, `nyx_slop_check`, `nyx_verify_slice` (3-strike circuit breaker + auto-rewind), and `nyx_exploit_probe` (loopback-only AppSec vectors).
  - **Engine 7 (`context/`):** `nyx_context_hydrate`, `nyx_task_handoff` (≤400 tokens), and `nyx_artifact_read`.
- **10 Canonical Agents, 6 Slash Commands & 16 Vendored Skills (`agents/`, `skills-vendor/`):**
  - Principal Tech Lead (`nyxowl`) + 9 specialized subagents (`nyx-product`, `nyx-architect`, `nyx-designer`, `nyx-db`, `nyx-api`, `nyx-ui`, `nyx-sec`, `nyx-probe`, `nyx-devops`) with strict per-role MCP tool scoping and ≤1,200-token prompt budgets.
  - Verified all 10 §13 Acceptance Scenarios in automated E2E and unit test suites.

### Fixed
- CI type-stripping for TypeScript tests on Node.js 22.13.
- Version reporting now derives from `package.json` instead of hardcoded literals.
- Unsupported Node.js versions now get an actionable preflight upgrade message instead of a `node:sqlite` import crash.

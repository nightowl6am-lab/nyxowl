# Changelog

All notable changes to `nyxowl` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Engine 2 AST accuracy:** `nyx_symbol_skeleton` now parses Python, Go, and Rust with vendored tree-sitter WebAssembly grammars (offline, no runtime network) instead of regex-only outlines, preserving the legacy outline as a fallback when a grammar is unavailable. Added language-aware symbol classification to `nyx_trace_symbol` (definitions, imports, and call sites for Python/Go/Rust, with symbol-aware import detection for TS/JS). Vendored `tree-sitter-wasms@0.1.13` grammars for Python, Go, and Rust under `data/grammars/`.

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

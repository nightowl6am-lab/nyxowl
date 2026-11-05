# Nyxowl Readiness Tracker (internal)

> **Internal maintainer document.** It is not shipped in the npm package. User-facing update guide: [`docs/updating.md`](../docs/updating.md).

> **Last updated:** 2026-11-05 · `main` @ `3d1a452`

This document is the single source of truth for the remaining path to real use. The maintainer or orchestrator updates it after each merged slice with a PR/commit citation.

## Foundation

Completed separately, before this tracker:

- **PR #2** — Green Node.js 22.13 CI plus v1 correctness upgrades.
- **PR #3** — Engine 2 Python/Go/Rust tree-sitter AST parsing and language-aware symbol tracing.
- **90 tests green** at `3d1a452`.

A slice is one merged, verified PR-sized increment.

## Snapshot

**`0/8 complete · 0/6 P0 complete`**

- **Ready for real use:** P0 slices 1–6 are merged with green CI and dogfood evidence.
- **Release-ready:** all 8 slices are complete.

## Slices

| # | Priority | Slice | Status | Exit criteria |
| :-: | :---: | :--- | :--- | :--- |
| 1 | P0 | Host reality | Not started | Live-verify launch, hooks, and config for Claude Code, OpenCode, Antigravity, Codex, Gemini, Cursor, and Windsurf; fix adapters; update `docs/host-matrix.md`. |
| 2 | P0 | Language coverage | Not started | Add tree-sitter AST mappings and trace rules for Java, Ruby, PHP, and C# with per-language fixtures; Kotlin/Swift optional. |
| 3 | P0 | Quality | Not started | Add the spec §9 fixtures corpus and raise coverage to spec §12 (core+engines >=85% lines/branches; CLI >=75%). |
| 4 | P0 | Correctness | Not started | Audit and fix seam/exploit/slop accuracy (route groups, base URLs, relative paths, grouped SQL/ORM, exploit vectors) with fixtures. |
| 5 | P0 | Dogfood | Not started | Run two real repositories through worktree → slices → verify → seam → slop → exploit → receipts → PR gate → `dep_guard` with no manual workarounds. |
| 6 | P0 | Production hardening | Not started | Add runtime wasm hash pinning, line/recursion/cache bounds, version single-source, and security tests. |
| 7 | P1 | Lifecycle | Not started | Verify fresh-`HOME` install, `doctor`, `init`, `uninstall`, and `relink`; document the Windows/WSL stance. |
| 8 | P1 | Release | Not started | Commit `PLAN.md`/master spec, update README/CHANGELOG, verify the fresh-install matrix, and add release CI. |

## Update rule

- Only update a row after the slice's PR is merged and CI is green.
- Record the PR/commit and date in the row or immediately below the table.
- Do not mark a slice complete based on local-only runs.
- When all P0 rows are complete, update the snapshot and state **`READY_FOR_REAL_USE`**.

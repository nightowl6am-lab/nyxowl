# Nyxowl Master Plan

This document is the committed master specification for Nyxowl v1. It records
the product contract, the runtime boundaries, the state model, and the gates a
change must satisfy. It is descriptive of the shipped code and does not claim
work that has not landed.

## 1. Purpose

Nyxowl is an OpenCode-only product and engineering team runtime. It installs a
Principal Tech Lead plus ten specialized subagents, and it exposes a
security-hardened, token-efficient MCP server so those agents can inspect,
build, verify, and ship code inside isolated Git worktrees.

The product goal is zero-slop delivery with cryptographic evidence: every
slice is developed outside the user's main checkout, verified by deterministic
gates, and promoted only when signed receipts bind the exact tree that was
verified.

## 2. Product Surface

- **Host:** OpenCode **v2.2.5** only. There are no adapters, detection entries,
  templates, or documentation for any other host.
- **Operating system:** Linux, including WSL2. Native Windows and macOS are
  not supported.
- **Agents:** exactly **1 primary + 10 subagents** (11 agent contracts):
  `nyxowl` (primary), `nyx-product`, `nyx-architect`, `nyx-designer`, `nyx-db`,
  `nyx-api`, `nyx-ui`, `nyx-sec`, `nyx-testwriter`, `nyx-probe`, `nyx-devops`.
- **Skills:** exactly 11 authored skill packages under
  `agents/skills/<agent-id>/` — 10 **native** packages registered through the
  host `skills` root and loaded on demand with the `skill` tool, plus
  **nyx-testwriter** in **inline** mode with its text embedded in that agent's
  system prompt. Every package has a `SKILL.md`, at least one `LICENSE`, and a
  read-only `references/` set. `agents/skills.lock.json` pins each file's
  upstream repo/commit/path, SPDX license, and local/upstream SHA-256;
  `npm run skills:verify` checks provenance, hashes, links, licenses, and
  dangerous patterns offline.
- **Commands:** six canonical slash commands compiled into the OpenCode package.
- **Launch contract:** `OPENCODE_CONFIG=<package>/opencode.json opencode --standalone <path>`
  with `default_agent: "nyxowl"`.

## 3. Runtime: 8 Engines, 39 Tools

The MCP server (`nyxowl mcp`, `src/mcp/server.ts`) registers exactly **39
`nyx_*` tools** across **8 engines**:

| Engine | Directory | Tools |
| --- | --- | --- |
| 1 — Shield | `src/mcp/engines/shield/` | `nyx_env_inspect`, `nyx_web_fetch`, `nyx_sanitize_untrusted`, `nyx_dep_guard` |
| 2 — Bootstrap & Navigator | `src/mcp/engines/bootstrap-navigator/` | `nyx_env_doctor`, `nyx_project_bootstrap`, `nyx_dna_extract`, `nyx_dna_get`, `nyx_symbol_skeleton`, `nyx_trace_symbol` |
| 3 — Seam | `src/mcp/engines/seam/` | `nyx_seam_check`, `nyx_pkg_verify`, `nyx_docs_ground` |
| 4 — Worktree & Slice | `src/mcp/engines/worktree-slice/` | `nyx_worktree_start`, `nyx_worktree_manage`, `nyx_slice_checkpoint`, `nyx_slice_rewind`, `nyx_worktree_pr` |
| 5 — Blackboard | `src/mcp/engines/blackboard/` | `nyx_blackboard_publish`, `nyx_blackboard_read`, `nyx_lock_acquire`, `nyx_lock_release`, `nyx_task_dispatch` |
| 6 — Probe & Exploit | `src/mcp/engines/probe-exploit/` | `nyx_debug_isolate`, `nyx_proc`, `nyx_slop_check`, `nyx_verify_slice`, `nyx_exploit_probe` |
| 7 — Context | `src/mcp/engines/context/` | `nyx_context_hydrate`, `nyx_task_handoff`, `nyx_artifact_read` |
| 8 — Test-Writer | `src/mcp/engines/testwriter/` | `nyx_testwriter_job`, `nyx_testwriter_write`, `nyx_testwriter_lint`, `nyx_testwriter_gate`, `nyx_testwriter_finish`, `nyx_testwriter_prepare`, `nyx_testwriter_status` |

The 39th tool, `nyx_model_preflight` (runtime core,
`src/core/model-preflight.ts`), is registered ahead of the engine tools by
`src/mcp/server.ts`.

All tools use strict Zod input/output schemas and MCP annotations. Responses
pass through the Exact-Value + Entropy Output Redactor, and token budgets
truncate into overflow artifacts.

## 4. Pinned Grammars

Seven tree-sitter WebAssembly grammars are vendored under `data/grammars/`:

`python`, `go`, `rust`, `java`, `ruby`, `php`, and `c_sharp`
(`tree-sitter-{python,go,rust,java,ruby,php,c_sharp}.wasm`).

`data/grammars/manifest.json` pins the byte length and SHA-256 of every
`.wasm`. The manifest is read from the same directory as the grammar, so a
`NYXOWL_GRAMMARS_DIR` override must ship matching pins. A missing or invalid
manifest, a missing entry, or a size/hash mismatch fails closed to the legacy
regex outline; unverified bytes are never loaded.

## 5. State Layout (`~/.nyxowl`)

All state lives outside the user's repository. `NYXOWL_HOME` overrides the
home directory.

- `~/.nyxowl/` — mode **0700**.
- `~/.nyxowl/secrets/` — mode 0700.
- `~/.nyxowl/secrets/receipt.key` — mode **0600**; 32 random bytes used for
  HMAC-SHA256 receipt signing.
- `~/.nyxowl/config.json` — global configuration (mode 0600 when created).
- `~/.nyxowl/install-manifest.json` — tracked-file manifest (mode 0600 when
  written).
- `~/.nyxowl/hosts/opencode/` and `~/.nyxowl/hosts/opencode-plugin/` —
  regenerated session-scoped OpenCode package and plugin.
- `~/.nyxowl/projects/<repo-id>/` — per-repository SQLite state (`state.db`,
  artifacts, PR records, handoff).
- `~/.nyxowl/worktrees/<repo-id>/<slug>/` — external isolated worktrees.
- `~/.nyxowl/test-writer/` — rootless Test-Writer runtime, with a `0700`
  `store/` and a `venv/`.

`<repo-id>` is `<basename>-<sha256(realpath(git-common-dir))[:8]>`, so a
repository and all of its worktrees share one project state database.

## 6. Isolated Worktrees and Slices

Code changes never occur in the user's main checkout. `nyx_worktree_start`
creates worktrees under `~/.nyxowl/worktrees/<repo-id>/<slug>/` and the
OpenCode adapter pre-authorizes that root via ordered `external_directory`
rules. The main checkout remains protected by permissions, the `guard` and
`edit-guard` hooks, and the edit boundary.

A slice is snapshotted with `nyx_slice_checkpoint`, which builds a tree through
a temporary `GIT_INDEX_FILE` (including untracked non-ignored files) and stores
it at `refs/nyxowl/slices/<slug>/<seq>`. It never moves `HEAD`, the real index,
or commit history.

## 7. Shadow Checkpoints and the 3-Strike Rewind

`nyx_verify_slice` normalizes compiler/test failure output and hashes the
signature into the `strikes` table:

- Strikes 1–2 return reduced failure output to the writer.
- **Strike 3** automatically rewinds the worktree to the latest shadow slice
  via `nyx_slice_rewind` (`read-tree` + `checkout-index -a -f` +
  `git clean -fd`, preserving `.env` symlinks and `node_modules`) and requires
  escalation to `nyx-architect`.
- Two failed escalations raise `ERR_DOOM_LOOP_ESCALATION` and halt the run.

## 8. Receipts and the Receipt-Gated PR

Every `verify`, `seam`, `slop`, and `exploit` gate writes a `SignedReceipt`
signed with `HMAC-SHA256(receipt.key, canonicalJSON(payload))`.

- Each receipt is bound to the full working-tree Git hash and to
  `HEAD^{tree}`. Changing any tracked or untracked non-ignored file changes the
  tree hash and invalidates stale receipts.
- `nyx_worktree_pr` recomputes the tree hash, verifies every HMAC, requires a
  clean working tree, scans the diff for secrets, and requires GREEN
  `verify`, `seam`, `slop`, and `exploit` receipts before it opens or records a
  PR.
- `nyxowl receipts verify` re-checks HMACs and tree bindings from the CLI.

## 9. Test-Writer Status

The Test-Writer is a rootless, owner-run subsystem. It uses a `0700` store at
`<install>/store`, a workspace at `~/tw-jobs`, and a venv at
`<install>/venv`; there is no separate OS user, privileged wrapper, or
root-owned install.

Status:

- **M0–M6: complete.**
- **M6 live host-isolation:** passed on attempt 2 per
  [`test-writer/qa/EVIDENCE-M6.md`](./test-writer/qa/EVIDENCE-M6.md).
- **M7-lite: complete** (PR #15). The model-free eval matrix and real stdio
  MCP dogfood are recorded in
  [`test-writer/qa/EVIDENCE-M7.md`](./test-writer/qa/EVIDENCE-M7.md), with
  zero false `PROVEN` verdicts.
- **Full M7: complete** (PR D). The 23-case matrix (10 positives, 5 negatives,
  8 red-team proofs), the three-run worst-of-3 matrix, and the real-repository
  `real-estate-os` dogfood passed. Measured: recall 1.0, false_reject 0,
  false_proven 0, negatives 15/15 exact, red-team 24/24 non-`PROVEN`,
  `model_tokens` 0. Evidence:
  [`test-writer/qa/EVIDENCE-M7.md`](./test-writer/qa/EVIDENCE-M7.md).

Key evidence paths:

- `test-writer/qa/EVIDENCE-M6.md` — advisory finish, three-run matrix, parent
  E2E, and the attempt-2 live isolation result.
- `test-writer/qa/EVIDENCE-M7.md` — M7-lite matrix and dogfood; full-M7
  23-case matrix, red-team proofs, three-run metrics, and real-repository
  dogfood.
- `test-writer/qa/m6_threerun.py`, `test-writer/qa/m6_parent_e2e.mjs` — M6
  model-free matrices.
- `test-writer/qa/m7_lite_eval.py`, `test-writer/qa/m7_dogfood.mjs` — M7-lite
  matrix and dogfood.
- `test-writer/qa/m7_full_eval.py`, `test-writer/qa/m7_cases_full/`,
  `test-writer/qa/m7_redteam/`, `test-writer/qa/m7_real_dogfood.mjs` — full-M7
  matrix, red-team corpus, and real-repository dogfood.
- `test-writer/selftests/run_all.py` — rootless M0–M6 self-tests.
- `test-writer/PLAN_STATUS.md` — milestone tracker.

The subagent sees only the approved spec, detector, interface, helper API, and
budget. It never sees target implementation bodies, variants, mutants, raw
grader output, or the canary. Proof tests are grader evidence, not repository
regression tests.

## 10. Definition of Ready

A change is ready to review when:

1. The scope is a single coherent slice and unrelated refactors are excluded.
2. TypeScript strict typecheck passes with no suppressions.
3. Lint passes with no new disables unless the repository already uses that
   pattern.
4. New behavior has unit or property tests covering boundaries and failure
   modes, and existing tests are not weakened.
5. Authentication, tenant isolation, RLS, validation, and secret handling are
   unchanged or strengthened.
6. The full Vitest coverage gate passes, including the `src/cli/**` 75%
   lines/branches gate.
7. Python artifacts compile, fixtures verify, and the rootless self-tests pass
   when Test-Writer files are touched.
8. The change is committed on a worktree branch; `@gitops` owns Git operations.

## 11. Release Gates

A release is publishable when:

1. `npm run typecheck`, `npm run lint`, `npm run test:coverage`, and
   `npm run build` pass.
2. `npm pack --dry-run` succeeds and the packed file list contains the
   intended runtime, docs, and Test-Writer assets.
3. A packed-artifact install smoke runs `nyxowl --version` and `nyxowl doctor`
   with a temporary `NYXOWL_HOME`.
4. The fresh-HOME lifecycle matrix passes: doctor, `init --project`,
   copy + `relink`, `uninstall --yes`, and `uninstall --purge --yes`.
5. The release tag is `vX.Y.Z` and exactly equals the `package.json` version.
6. The package is published with npm provenance.
7. The rollback and deprecation path in
   [`docs/release.md`](./docs/release.md) is current.

## 12. Non-Goals

- Other coding hosts, host adapters, or host-specific templates.
- Native Windows or macOS support.
- A root or privileged Test-Writer install; `/opt`, `/var/lib`, sudo, and a
  separate grader OS user are out of scope.
- Network calls at runtime that are not explicitly bounded, loopback-only, or
  opt-in (for example `nyx_web_fetch`, OSV lookups, and loopback probes).
- New MCP engines, new `nyx_*` tool names, or new dependencies outside the
  reviewed supply chain.
- A runtime skill registry, remote skill fetch, or execution of third-party
  skill code. Vendored skills are pinned, adapted, locked, and verified offline;
  they are reference data, not executable plugins.
- Changing engine, gate, or grader behavior as part of documentation and
  lifecycle work.

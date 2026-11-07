# M7-lite evidence (PR A)

Date: 2026-11-07. Worktree: `wt/pr-a-dogfood-m7lite`.
All commands were run from this worktree. No network, remote service, secret, or
production root was used. `node_modules` was not installed; the existing main
checkout `node_modules` was symlinked in the ignored worktree path.

## What was run

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0, no diagnostics |
| `npm run lint` | exit 0, no findings |
| `npm run test:coverage` | 20/20 files, 179/179 tests passed; statements 81.96% (4616/5632), branches 69.94% (3023/4322), functions 88.3% (491/556), lines 84.15% (4425/5258) |
| `npm run build` | success (tsup) |
| `npm pack --dry-run` | 242 files, package 757.0 kB, unpacked 3.7 MB (independent verifier) |
| `python3 -m compileall -q test-writer` | exit 0 |
| `python3 test-writer/fixtures/build_fixtures.py --verify` | `FIXTURES_VERIFY: PASS` |
| `TW_VENV_PYTHON=$HOME/.nyxowl/test-writer/venv/bin/python python3 test-writer/selftests/run_all.py` | `Ran 228 tests ... OK`; `M0_SELFTESTS: PASS`, `M1M3_SELFTESTS: PASS` |
| `... python3 test-writer/qa/m7_lite_eval.py --rounds 3` | `M7_LITE_EVAL: PASS` |
| `node test-writer/qa/m7_dogfood.mjs` | `PR_A_DOGFOOD: PASS` (final coder run and independent verifier run both PASS; one earlier trial failed only on an over-strict `summaryOutput` assertion, see friction) |

The 228 Python self-tests are the `test-writer/selftests` suite; the separate
Vitest suite is 179/179.

## M7-lite eval matrix

Seven cases under `test-writer/qa/m7_cases/`. Refs are resolved by state name
from `build_fixtures.py --print-refs`; no new hash is hardcoded. The existing
`a`-`e`/`sv`/`fd` refs were unchanged (`test_m7_cases` asserts the frozen refs).

| Case | Alias | Refs | Expected |
| --- | --- | --- | --- |
| c1 | naive-join | `m7v1 -> m7p1` | PROVEN |
| c2 | literal-block-then-decode | `d -> b` | PROVEN |
| c3 | string-prefix-check | `m7v3 -> m7p3` | PROVEN |
| c4 | double-percent-decode | `m7v4 -> m7p4` | PROVEN |
| c5 | backslash-normalise | `m7v5 -> m7p5` | PROVEN |
| n1 | safe-to-safe-control | `c -> b` | UNPROVEN/`NO_DETECTOR_HIT_ON_VULN` |
| n2 | patched-still-leaks-control | `a -> d` | REFUTED/`PATCHED_STILL_LEAKS` |

Evidence run (`--rounds 3`):

```
run | c1 | c2 | c3 | c4 | c5 | n1 | n2 | falsePROVEN | expectedPROVENmisses
1 | PROVEN | PROVEN | PROVEN | PROVEN | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | 0 | 0
2 | PROVEN | PROVEN | PROVEN | PROVEN | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | 0 | 0
3 | PROVEN | PROVEN | PROVEN | PROVEN | PROVEN | UNPROVEN/NO_DETECTOR_HIT_ON_VULN | REFUTED/PATCHED_STILL_LEAKS | 0 | 0
M7_LITE_EVAL: PASS
```

- False `PROVEN`: 0 across all rounds.
- Expected-`PROVEN` misses: 0 across all rounds.
- Every `PROVEN` job passed `tw-recheck` with exit 0 and `result: "match"`.
- `n1` did not hit the detector on the vulnerable snapshot (both refs safe).
- `n2` was never `PROVEN`; the patched ref still leaked the encoded payload.
- Each expected-`PROVEN` proof includes a payload that leaks on the hidden `sv`
  state: literal `../secret.txt` in c1/c2/c4/c5 and the sibling path
  `../app2/secret.txt` in c3. `sv` rejects absolute and backslash names but
  allows parent traversal. c4 additionally requires the double-percent payload
  `%252e%252e/secret.txt` that `m7v4` decodes twice.

## Real-use dogfood

`test-writer/qa/m7_dogfood.mjs` starts the real `node dist/cli/bin.js mcp` over
stdio with a temporary `NYXOWL_HOME`. It creates a temp Git repo with
`package.json` (`scripts.test = "node --test"`), a buggy `src/mathutil.js`, a
failing `test/mathutil.test.js`, and `.nyxowl/config.json`
(`provision.install=off`, `github.mode=local`, `deps.allow=["left-pad"]`).

Final run:

```
step | status | detail
temp-git-repo | PASS | /tmp/pr-a-dogfood-VOlKls/repo
mcp-connect | PASS | 38 tools
nyx_dna_extract | PASS | javascript-node; test=npm run test
nyx_worktree_start | PASS | external; install=skipped
worktree-fix-and-commit | PASS | src/mathutil.js + regression test
nyx_verify_slice | PASS | receipt 01M6W0M2; real npm run test
nyx_seam_check | PASS | coverage=none
nyx_slop_check | PASS | blocking=0
nyx_exploit_probe | PASS | 6 vectors GREEN
nyx_worktree_pr | PASS | mode=local; verify:GREEN, seam:GREEN, slop:GREEN, exploit:GREEN
nyx_dep_guard | PASS | left-pad allowlisted offline
PR_A_DOGFOOD: PASS
```

Key assertions:

- 38 tools registered; all eight dogfood tools present.
- DNA reports `javascript-node`, `commands.test = "npm run test"`, and
  `httpSurface = false`.
- Worktree is external, branches from `main`, provisioning is `skipped`.
- The worktree real fix changes `add()` to sum; a regression test is added and
  committed.
- `nyx_verify_slice` runs the real `npm run test` from `package.json` (no
  `commandsOverride`, no fake `true`); its evidence artifact contains
  `npm run test` and `pass 2`.
- Seam and slop return GREEN receipts. Slop is diff-scoped.
- A loopback Node server returns plain-text 404. All six exploit vectors return
  GREEN with no vulnerable finding.
- The local PR fallback verifies exactly four receipts (`verify`, `seam`,
  `slop`, `exploit`), all GREEN, and writes the local PR file.
- `nyx_dep_guard` approves allowlisted `left-pad` without network access.

## Friction recorded

1. The worktree had no `node_modules`; `npm run build` failed with
   `sh: 1: tsup: not found` until the existing main-checkout `node_modules` was
   symlinked into the ignored worktree path. No install was run.
2. `nyx_verify_slice` returns a one-line `summaryOutput` ("All 1 verification
   step(s) passed (test)."), not the command log. The dogfood now reads the
   `evidenceArtifactId` artifact to assert `npm run test` and `pass 2`.
   Repro: call `nyx_verify_slice` on a temp repo and inspect `summaryOutput`.
3. The first `n1` draft used `fd` as the patched ref. `tw-new-job` refused with
   `JOB_INVALID` because a hidden variant ref must differ from both approved
   refs. The safe-safe control now uses `c -> b`.
4. A dogfood trial failed only because it asserted `npm run test` in
   `summaryOutput`; the tool call itself was GREEN. Replaced with the artifact
   assertion above.

No product-code paper cut was revealed by the dogfood run, so none was changed.

## What was not run

- Full M7 is not implemented or claimed; this is M7-lite only.
- The live OpenCode host-isolation transcript was not re-run here. Its final
  verdict (end-to-end PASS on attempt 2) is recorded in `qa/EVIDENCE-M6.md` and
  is treated as the M6 acceptance result.
- No network registry call was made. `left-pad` was approved from the config
  allowlist before any registry fetch.
- No `npm install`/`npm ci`, `pip install`, sudo, root, `/opt`, `/var/lib`, or
  `tw-grader` was used.

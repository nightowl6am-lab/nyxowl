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

- That M7-lite run did not include full M7; the full-M7 matrix, red-team
  proofs, and real-repository dogfood are recorded in the PR D section below.
- The live OpenCode host-isolation transcript was not re-run here. Its final
  verdict (end-to-end PASS on attempt 2) is recorded in `qa/EVIDENCE-M6.md` and
  is treated as the M6 acceptance result.
- No network registry call was made. `left-pad` was approved from the config
  allowlist before any registry fetch.
- No `npm install`/`npm ci`, `pip install`, sudo, root, `/opt`, `/var/lib`, or
  `tw-grader` was used.

---

# Full M7 (PR D)

Date: 2026-11-08. Worktree: `wt/pr-d-full-m7`. The full-M7 harness is model-free:
every verdict comes from the deterministic fixture corpus, the six-gate
pipeline, and `tw-recheck`; `model_tokens` is a hard constant of zero. No
network, remote service, secret, production root, or `tw-grader` is used.

## What was run

| Command | Result |
| --- | --- |
| `TW_VENV_PYTHON=$HOME/.nyxowl/test-writer/venv/bin/python python3 test-writer/qa/m7_full_eval.py --rounds 3 --out /tmp/opencode/m7-full-eval-r3` | `M7_FULL_EVAL: PASS` |
| `TW_VENV_PYTHON=$HOME/.nyxowl/test-writer/venv/bin/python python3 test-writer/qa/m7_full_eval.py --rounds 1 --out /tmp/opencode/m7-full-eval-metricfix-r1b` | `M7_FULL_EVAL: PASS` after the metric fix |
| `TW_VENV_PYTHON=$HOME/.nyxowl/test-writer/venv/bin/python node test-writer/qa/m7_real_dogfood.mjs` | `SLICE5_DOGFOOD: PASS (target=private-production-repo; test=pnpm run test)` |
| `python3 -m compileall -q test-writer` | exit 0 |
| `python3 test-writer/fixtures/build_fixtures.py --verify` | `FIXTURES_VERIFY: PASS` |
| `TW_VENV_PYTHON=$HOME/.nyxowl/test-writer/venv/bin/python python3 test-writer/selftests/run_all.py` | 239 tests, `M0_SELFTESTS: PASS`, `M1M3_SELFTESTS: PASS` |

The runner builds the deterministic fixture repository once, installs the
worktree runtime once into a temporary install root, and runs every case
through `tw-new-job` -> `tw-approve` -> `tw-gate`; every `PROVEN` job is
rechecked with `tw-recheck`.

## Case matrix (23 cases)

Ten positives (expected `PROVEN`):

| Case | Alias | Refs |
| --- | --- | --- |
| c1 | naive-join | `m7v1 -> m7p1` |
| c2 | literal-block-then-decode | `d -> b` |
| c3 | string-prefix-check | `m7v3 -> m7p3` |
| c4 | double-percent-decode | `m7v4 -> m7p4` |
| c5 | backslash-normalise | `m7v5 -> m7p5` |
| p6 | normpath-join | `m7v6 -> m7p6` |
| p7 | realpath-prefix-check | `m7v7 -> m7p7` |
| p8 | nfkc-dotdot | `m7v8 -> m7p8` |
| p9 | symlink-follow | `m7v9 -> m7p9` |
| p10 | absolute-path-bypass | `m7v10 -> m7p10` |

Five negatives (expected verdict/reason is required exactly):

| Case | Alias | Expected |
| --- | --- | --- |
| n1 | safe-to-safe-control | `UNPROVEN` / `NO_DETECTOR_HIT_ON_VULN` |
| n2 | patched-still-leaks-control | `REFUTED` / `PATCHED_STILL_LEAKS` |
| n3 | swapped-refs-control | `UNPROVEN` / `NO_DETECTOR_HIT_ON_VULN` |
| n4 | unrelated-patch-control | `REFUTED` / `PATCHED_STILL_LEAKS` |
| n5 | incomplete-backslash-fix-control | `REFUTED` / `PATCHED_STILL_LEAKS` |

Eight red-team proofs (expected non-`PROVEN`):

| Case | Alias |
| --- | --- |
| rt1 | redteam-import-typo |
| rt2 | redteam-wrong-exception |
| rt3 | redteam-os-exit |
| rt4 | redteam-runtime-skip |
| rt5 | redteam-canary-read |
| rt6 | redteam-audit-write |
| rt7 | redteam-forged-report-no-mac |
| rt8 | redteam-forged-detector-booleans |

## Three-run worst-of-3 summary

```
worst_of_3:
c1-c5, p6-p10 = PROVEN
n1 = UNPROVEN   n2 = REFUTED   n3 = UNPROVEN   n4 = REFUTED   n5 = REFUTED
rt1 = UNPROVEN  rt2 = REFUTED  rt3 = NO_VERDICT  rt4 = NO_VERDICT
rt5 = UNPROVEN  rt6 = UNPROVEN  rt7 = UNPROVEN  rt8 = REFUTED
falsePROVEN = 0 (all rounds)   falseReject = 0 (all rounds)
```

`rt3` (`redteam-os-exit`) and `rt4` (`redteam-runtime-skip`) are refused by the
defense-in-depth lint gate before execution (`LINT:NO_ORACLE`) and are
non-`PROVEN`. The corrected `worst_of_3` rendering maps those absent verdicts to
`NO_VERDICT` rather than `null`.

## Measured metrics

- recall: **1.0** (10/10 positives PROVEN in every round)
- false_reject: **0**
- false_proven: **0**
- negatives: **15/15** non-`PROVEN`, and **15/15** with the exact expected
  `(verdict, reason)` pair
- red-team: **24/24** non-`PROVEN`
- gate_runs: **69**
- recheck_runs: **30**
- model_tokens: **0**
- prompt_chars: **59187**
- wall: **8.377 min** (rounds 2.879 / 2.75 / 2.748)

### Refuted-correctness metric fix

The earlier denominator included all negative runs, so `n1`/`n3`
(`UNPROVEN`/`NO_DETECTOR_HIT_ON_VULN`) were wrongly counted as missed
refutations. The runner now requires the exact expected `(verdict, reason)` for
every negative, counts any mismatch as a failure, and computes
`refuted_correct` only over expected-`REFUTED` negatives (`n2`, `n4`, `n5`):
**9/9 = 1.0** across three rounds. That three-round value is recomputed from the
stored per-round verdicts in `/tmp/opencode/m7-full-eval-r3/` (all `n2`/`n4`/`n5`
runs are `REFUTED`/`PATCHED_STILL_LEAKS`); the fixed runner was then exercised
with a one-round recheck that reports `3/3 = 1.0`, `negative_mismatches: 0`, and
`negatives_exact_matched: 5`.

## Real-repository dogfood (PR D)

`test-writer/qa/m7_real_dogfood.mjs` clones a tracked-only real repository
(`git clone --local --no-hardlinks`), proves no `.env` is present or tracked,
writes a dogfood-only `.nyxowl/config.json`
(`provision.linkEnv=false`, `provision.install=off`, `github.mode=local`,
`deps.allow=["zod"]`), and drives the real stdio MCP server. It creates an
external worktree, commits a real Vitest smoke regression test, runs the
target's real DNA test command, verifies, checks seam/slop/exploit, opens the
four-receipt local PR, checks the allowlisted dependency, and removes the
worktree. The primary target is `private-production-repo`; `nyxowl-self` is the fallback.

Final run:

```
## target=private-production-repo
step | status | detail
source-check | PASS | /abs/dogfood/repo
clone | PASS | tracked-only local clone
no-env | PASS | no .env file and no tracked .env/.env.* secret path
config | PASS | linkEnv=false, install=off, github=local
mcp-connect | PASS | 38 tools; eight dogfood tools present
nyx_dna_extract | PASS | real test command: pnpm run test
nyx_worktree_start | PASS | external; branch=nyx/slice5-dogfood-639954; install=skipped
slice-write | PASS | apps/web/tests/unit/slice5-dogfood.test.ts committed
nyx_verify_slice | PASS | receipt 01M6WPPY; ran pnpm run test
seam-prep | PASS | worktree config budget set; generated build output cleaned
nyx_seam_check | PASS | status=GREEN; coverage=partial
nyx_slop_check | PASS | status=GREEN; blocking=0
nyx_exploit_probe | PASS | status=GREEN; 6 vectors
nyx_worktree_pr | PASS | mode=local; verify:GREEN, seam:GREEN, slop:GREEN, exploit:GREEN
nyx_dep_guard | PASS | zod allowlisted offline
nyx_worktree_manage | PASS | removed
SLICE5_DOGFOOD: PASS (target=private-production-repo; test=pnpm run test)
```

The `nyxowl-self` fallback reached verify GREEN but stopped at seam with a real
RED seam graph (22 source-level db/API mismatches), so the primary target is
reported. The dogfood never reads `.env`, never installs, never uses
`commandsOverride`, and never fakes a gate. Its dependency trees are
hardlink-cloned from the already-installed source checkout so Turbopack can
resolve workspace `node_modules` without a network install.

## What was not changed

Gates, grader behavior, corpus verdicts, and the M7 acceptance bar are
unchanged. No dependency, receipt kind, or TypeScript surface changed for PR D.

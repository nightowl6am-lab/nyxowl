# Plan status

Last updated: 2026-11-07.

| Milestone | Status |
| --- | --- |
| M0 — sandbox foundation, owner artifacts, source definition | complete; root-owned install gate is historical only, rootless user gate replaces it |
| M0.5 — Nyxowl agent + broker integration | source complete; runtime M1-M5 complete; M6 isolation verification pending |
| M1 | complete |
| M2 | complete |
| M3 | complete |
| M4 | complete |
| M5 | complete |
| M6 | not started; agent registered in M0.5, host-isolation verification still pending |
| M7 | not started |

## Rootless install gate

The prior root-owned install gate (separate service account, system install
tree, system store, and privileged wrappers) ran on 2026-11-06. It is retained
only as historical evidence and is no longer the acceptance gate. That install
model and its scripts have been superseded.

The current gate is a rootless user install:

- [ ] `bash bootstrap/install-user.sh` prints `USER_INSTALL: PASS` and installs
  under `$HOME/.nyxowl/test-writer` with a `0700` store.
- [ ] `bash bootstrap/build-user-venv.sh` prints `USER_VENV: PASS` and installs
  the hashed lock into `<install>/venv`.
- [ ] `python3 selftests/run_all.py` prints `M0_SELFTESTS: PASS` and
  `M1M3_SELFTESTS: PASS` with 217 tests.
- [ ] `python3 fixtures/build_fixtures.py --verify` prints
  `FIXTURES_VERIFY: PASS`.
- [ ] The M0 probes run as the current user with `TW_INSTALL_ROOT` and
  `TW_PROBE_ROOT`, and report `store_exists: false`, no network, and the
  expected CPU/memory/process/file-size/output limits.

The source checks below are complete. The unchecked items are owner-run steps in
`README_OWNER.md`; they are not claimed as executed here.

## Source checks already run

These are rootless checks and do not replace the owner acceptance above.

| Check | Result |
| --- | --- |
| `python3 -m compileall -q test-writer` | PASS |
| `TW_VENV_PYTHON=<runtime venv> python3 test-writer/selftests/run_all.py` | PASS — 217 tests, `M0_SELFTESTS: PASS`, `M1M3_SELFTESTS: PASS` |
| `python3 test-writer/fixtures/build_fixtures.py --verify` | PASS (`FIXTURES_VERIFY: PASS`) |

## M1-M5 acceptance summary

- Fixture J1: `PROVEN`, with flake/variants/mutation passing and mutation score
  at least `0.8`.
- Fixture J2: `UNPROVEN` with `NO_DETECTOR_HIT_ON_VULN`.
- Fixture J3: `REFUTED` (never `PROVEN`).
- Fixture J4: `PROVEN`, with flake/variants/mutation passing and mutation score
  at least `0.8`.
- M4 quality routing: a hash-seed-dependent proof is `UNPROVEN`/`FLAKY`; a job
  without both hidden variants is `UNPROVEN`/`VARIANT_MISSING`; an
  absolute-path-only test is `UNPROVEN`/`VARIANT_TOO_WEAK`; a test that catches
  only `ValueError` while the fixed-differently variant raises
  `PermissionError` is `UNPROVEN`/`VARIANT_OVERFIT`. `--gate 7` is refused with
  `GATE_UNAVAILABLE`. A direct `mutate.score(1, 2) = 0.5` unit test covers the
  `MUTATION_SCORE_LOW` threshold path.
- M5 proof and recheck: every terminal gate run writes `test.py`, a canonical
  `proof.json` with self-verifying runtime/frozen hashes, a hash-linked
  append-only `chain.log`, and an owner-facing `REPORT.md`. `tw-recheck <id>`
  replays the gate pipeline read-only, compares verdict/reason/flags/gates, the
  vulnerable/patched/violation count blocks, mutation
  score/counts/survivors, variant statuses, and flake runs, and exits
  `0` only on a recomputed match. Tampering with `proof.json`, `meta.json`,
  `manifest.json`, a source tar, `test.py`, a runtime file, or `chain.log`
  fails closed with `HASH_MISMATCH`/`CHAIN_BROKEN`; open, missing, or
  no-frozen-test jobs return `JOB_NOT_CLOSED`, `PROOF_MISSING`, or
  `NO_FROZEN_TEST`. `REPORT.md` and recheck JSON contain no target or test
  source fragments.
- Behaviour-based verdict: gates 2/4/5 accept a real `AssertionError` or pytest
  `Failed` on the vulnerable/still-vulnerable snapshot and require the
  patched/fixed-differently snapshot to pass; detector attribution is evidence
  only. A plain `assert False` differential with no detector is accepted and,
  when the hidden variants and mutation also pass, reaches `PROVEN`. A target
  exception is still `SETUP_ERROR_VULN:wrong_exception:<Type>`.
- Red-team cases do not reach `PROVEN` for the wrong reason: import typo, wrong
  exception, `os._exit`, runtime skip, canary read, and audit-hook write
  violation fail closed or return a safety/quality refusal. A forged signed
  report with `detector_seen`/`detector_attributed` set does not survive a
  failing patched run.
- Wrapper, lint-only, finish, closed-job, busy-job, unavailable-gate, and
  attempt-budget refusals all behave as specified with `ok: false`.
- Security regression: `request`/`pytestconfig`/`MonkeyPatch`/plugin-manager/
  dunder lint cases, forbidden-fixture setup failure, `sensitive_read` source
  blocking, and detector-marker binding all fail closed. A lint-clean test that
  writes a forged `/work/out/report.json`, makes the directory read-only, and
  fails is rejected because the report has no valid MAC and its exit status
  disagrees; the gate records `SETUP_ERROR_VULN:no_report`. A forged report with
  detector booleans set does not rescue a test whose patched run fails.
  `pytest.exit` and `SystemExit`/`KeyboardInterrupt`/`GeneratorExit` are also
  lint-blocked. Defense-in-depth lint hardening additionally rejects `os`,
  `inspect`, `_settings`, `_sys`, `currentframe`, `getframe`, traceback/frame
  attributes, `gi_frame`/`cr_frame`, and `co_consts` attribute access as
  `DYNAMIC_ESCAPE`, while `pytest.raises`/`exc.value`, target calls, and
  `tmp_path` I/O stay clean. The four fixture verdicts are unchanged (J1/J4
  PROVEN, J2 UNPROVEN/`NO_DETECTOR_HIT_ON_VULN`, J3 REFUTED).
- M1-M5 security hardening: report MAC plus exit-status agreement, forbidden
  fixtures, `sensitive_read` blocking of `/work/src` during the test phase, and
  detector-marker binding to the target's observed return. Detector attribution
  is retained only as evidence; the verdict is behavioural. Variant refs/tars
  and mutant source are never exposed to the subagent. M5 adds canonical proof
  hashes, a tamper-evident chain, and a read-only recheck. The selftest count is
  217.
- Residual risk: a `PROVEN` verdict is a quality/behavioural claim, not a
  hostile-test or hostile-target security claim. The proof test runs as
  untrusted code inside bwrap; the target snapshot is owner-supplied; both share
  one interpreter, so a malicious test or snapshot can forge harness state or
  introspect the plugin. That is outside the verdict trust model. The owner
  reviews the test/spec and both approved refs for plugin-state access,
  out-of-snapshot writes at import/collection, and `os._exit`/`os.abort`, then
  records the ref hashes with the job. A separate-process judge is future work
  (M6/out of scope) and is not claimed here.

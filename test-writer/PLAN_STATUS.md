# Plan status

Last updated: 2026-11-06.

| Milestone | Status |
| --- | --- |
| M0 — sandbox foundation, owner artifacts, source definition | complete (owner gate PASSED 2026-11-06) |
| M0.5 — Nyxowl agent + broker integration | source complete; runtime M1-M3 complete; M6 isolation verification pending |
| M1 | complete |
| M2 | complete |
| M3 | complete |
| M4 | not started |
| M5 | not started |
| M6 | not started; agent registered in M0.5, host-isolation verification still pending |
| M7 | not started |

## M0 acceptance checklist

All items were run by the owner on 2026-11-06.

- [x] COMPLETE (2026-11-06) — `sudo bash bootstrap/install-root.sh` created
  `tw-grader`, `/opt/test-writer`, and `/var/lib/test-writer` and printed
  `ROOT_INSTALL: PASS`.
- [x] COMPLETE (2026-11-06) — `bootstrap/sudoers.test-writer.draft` was reviewed
  with the owner account filled in and installed with
  `sudo visudo -f /etc/sudoers.d/test-writer`; `visudo` parsed it successfully.
- [x] COMPLETE (2026-11-06) — `sudo bash bootstrap/build-runtime-venv.sh` created
  `/opt/test-writer/requirements.lock`, created `/opt/test-writer/venv`, and
  printed `RUNTIME_VENV: PASS`.
- [x] COMPLETE (2026-11-06) — `python3 selftests/run_all.py` printed
  `M0_SELFTESTS: PASS`.
- [x] COMPLETE (2026-11-06) — the `tw-grader` environment probe showed no host
  environment, no `/home`, no `/var/lib/test-writer`, a read-only `/work/src`,
  and only loopback networking.
- [x] COMPLETE (2026-11-06) — the `tw-grader` CPU, memory, process, file-size,
  and output probes reported `cpu`, `memory`, `pids`, `file_size`, and `output`
  respectively.
- [x] COMPLETE (2026-11-06) — the acceptance runs used the production defaults
  (`/opt/test-writer`, `/var/lib/test-writer`) without any `TW_*` override.

## Source checks already run

These are rootless checks and do not replace the owner acceptance above.

| Check | Result |
| --- | --- |
| `python3 -m compileall -q test-writer` | PASS |
| `python3 test-writer/selftests/run_all.py` | PASS — 152 tests, `M0_SELFTESTS: PASS`, `M1M3_SELFTESTS: PASS` |
| `python3 test-writer/fixtures/build_fixtures.py --verify` | PASS (`FIXTURES_VERIFY: PASS`) |

## M1-M3 acceptance summary

- Fixture J1: `PROVEN`.
- Fixture J2: `UNPROVEN` with `NO_DETECTOR_HIT_ON_VULN`.
- Fixture J3: `REFUTED`.
- Fixture J4: `PROVEN`.
- Red-team cases do not reach `PROVEN`: conditional cheat, import typo, wrong
  exception, `os._exit`, runtime skip, canary read, and audit-hook write
  violation all fail closed or return a safety/quality refusal.
- Wrapper, lint-only, finish, closed-job, busy-job, unavailable-gate, and
  attempt-budget refusals all behave as specified with `ok: false`.
- Security regression: `request`/`pytestconfig`/`MonkeyPatch`/plugin-manager/
  dunder lint cases, forbidden-fixture setup failure, `sensitive_read` source
  blocking, and detector-marker binding all fail closed. A lint-clean test that
  writes a forged `/work/out/report.json`, makes the directory read-only, and
  fails is rejected because the report has no valid MAC and its exit status
  disagrees; the gate records `SETUP_ERROR_VULN:no_report`. `pytest.exit` and
  `SystemExit`/`KeyboardInterrupt`/`GeneratorExit` are also lint-blocked. The
  four fixture verdicts are unchanged (J1/J4 PROVEN, J2
  UNPROVEN/`NO_DETECTOR_HIT_ON_VULN`, J3 REFUTED).
- M1-M3 security hardening: report MAC plus exit-status agreement, forbidden
  fixtures, `sensitive_read` blocking of `/work/src` during the test phase, and
  detector-marker binding to the target's observed return. The selftest count is
  152.
- Residual risk: a `PROVEN` verdict is not a hostile-target claim. The target
  snapshot is owner-supplied, and harness/target share one interpreter, so a
  malicious snapshot can forge harness state (target collusion). The owner
  reviews both approved refs for plugin-state access, out-of-snapshot writes at
  import/collection, and `os._exit`/`os.abort`, then records the ref hashes with
  the job. A separate-process judge is an M6/out-of-scope item and is not
  claimed here.

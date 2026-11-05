# Plan status

Last updated: 2026-11-05.

| Milestone | Status |
| --- | --- |
| M0 — sandbox foundation, owner artifacts, source definition | source complete; root acceptance pending |
| M0.5 — Nyxowl agent + broker integration | source complete; runtime M1-M3 pending; M6 isolation verification pending |
| M1 | not started |
| M2 | not started |
| M3 | not started |
| M4 | not started |
| M5 | not started |
| M6 | not started; agent registered in M0.5, host-isolation verification still pending |
| M7 | not started |

## M0 acceptance checklist

These items are owner-run and root-dependent. They remain **PENDING** until the
owner performs them; this file does not claim them.

- [ ] PENDING — `sudo bash bootstrap/install-root.sh` creates `tw-grader`,
  `/opt/test-writer`, and `/var/lib/test-writer` and prints `ROOT_INSTALL: PASS`.
- [ ] PENDING — `bootstrap/sudoers.test-writer.draft` is reviewed with `<owner>`
  filled in and installed with `sudo visudo -f /etc/sudoers.d/test-writer`.
- [ ] PENDING — `sudo bash bootstrap/build-runtime-venv.sh` creates
  `/opt/test-writer/requirements.lock`, creates `/opt/test-writer/venv`, and
  prints `RUNTIME_VENV: PASS`.
- [ ] PENDING — the owner runs `python3 selftests/run_all.py` and sees
  `M0_SELFTESTS: PASS`.
- [ ] PENDING — as `tw-grader`, the environment probe shows no host environment,
  no `/home`, no `/var/lib/test-writer`, a read-only `/work/src`, and only
  loopback networking.
- [ ] PENDING — as `tw-grader`, the CPU, memory, process, file-size, and output
  probes report `cpu`, `memory`, `pids`, `file_size`, and `output` respectively.
- [ ] PENDING — production defaults (`/opt/test-writer`, `/var/lib/test-writer`)
  are used without any `TW_*` override.

## Source checks already run

These are not root acceptance and do not replace the checklist above.

| Check | Result |
| --- | --- |
| `python3 -m compileall -q test-writer` | PASS |
| `python3 test-writer/selftests/run_all.py` | PASS (`M0_SELFTESTS: PASS`, 20 tests) |

# Sandbox facts and limits (M0-M4)

This document describes what the sandbox actually does on the owner's machine,
what it does not isolate, and why one implementation choice differs from a
conventional `prlimit` wrapper. M0 covers the probe runner; M3 adds the
pytest proof-test mode described below; M4 reuses that mode for flake,
variant, and mutation runs.

## Verified on this machine

| Fact | Value |
| --- | --- |
| Kernel | Linux 7.0.0-42-generic x86_64 |
| bubblewrap | `bubblewrap 0.9.0` at `/usr/bin/bwrap` |
| bubblewrap mode | root-owned `0755`, not setuid |
| Python | `Python 3.12.3` at `/usr/bin/python3` |
| Unprivileged user namespaces | `/proc/sys/kernel/unprivileged_userns_clone = 1` |
| Host processes for the invoking account at test time | about 25 |

The self-tests and production jobs run as the invoking owner. The default
install root is `$HOME/.nyxowl/test-writer`, the store is
`$HOME/.nyxowl/test-writer/store` (`0700`), and the venv is
`$HOME/.nyxowl/test-writer/venv`. There is no separate grader account.

## Isolation and limits

| Surface | Mechanism | M0 evidence |
| --- | --- | --- |
| Network | `--unshare-all` creates a network namespace with only loopback | `network_probe.py` prints `NETWORK_FAIL 101` |
| Host environment | `--clearenv` plus five fixed `--setenv` values | `env_probe.py` sees `FAKE_SECRET` as null |
| Host filesystem | only selected read-only binds; no host home or store | `env_probe.py` reports `home_exists: false`, `store_exists: false` |
| Probe source | `<work>/src` is a read-only bind | `env_probe.py` write result is an `OSError` |
| Test area | `<work>/tests` is a read-only bind | not writable from the probe |
| Scratch | `--tmpfs /tmp` and an empty `--tmpfs /canary` | `file_probe.py` can only fill the tmpfs |
| Process namespace | `--unshare-all` creates a new PID namespace | `fork_probe.py` |
| CPU | `RLIMIT_CPU` soft = `cpu_seconds`, hard = `cpu_seconds + 1` | `limit_hit: cpu` |
| Memory | `RLIMIT_AS` = `memory_mb` MiB | `limit_hit: memory` |
| Processes | `RLIMIT_NPROC` = `nproc_effective` | `fork_probe.py` prints `FORK_FAIL ... EAGAIN`, `limit_hit: pids` |
| File size | `RLIMIT_FSIZE` = `max_file_mb` MiB | `limit_hit: file_size` |
| Core dumps | `RLIMIT_CORE` = 0 | no core files |
| Session | `--new-session`, `--die-with-parent` | no terminal injection; sandbox dies with the launcher |
| Output | parent reader retains at most `max_output_kb` KiB per stream | `stdout_truncated: true`, `limit_hit: output` |

Default limits:

| Limit | Default |
| --- | --- |
| Wall clock | 30 s |
| CPU | 20 s |
| Address space | 512 MiB |
| Processes | 64 (`nproc_effective` may be higher) |
| File size | 16 MiB |
| Captured output | 1024 KiB per stream |

`nproc_effective` is `max(max_pids, current_process_count_for_uid + 16)` when
`ps` succeeds, and `max_pids` when it does not. Without the headroom, an account
that already owns many processes cannot start the sandbox at all.

## Test mode (M3)

The proof-test runner uses the same bubblewrap boundary with a fixed layout:

| Path | Access | Contents |
| --- | --- | --- |
| `/work/src` | read-only | the frozen snapshot extracted from the commit tar |
| `/work/tests` | read-only | the single submitted `test.py` |
| `/work/harness` | read-only | `pytest.ini`, `plugin.py`, and `limits.py` |
| `/work/out` | writable bind | the only writable directory; holds `report.json` |
| `/canary/value` | read-only file under a read-only `/canary` | canary text used for read detection |
| `/tmp`, `/tmp/hypothesis` | tmpfs | scratch only |

The venv interpreter (`<install>/venv/bin/python`, or `TW_VENV_PYTHON`) is the
only executable path: it runs `/work/harness/limits.py`, which sets the resource
limits and then execs pytest with the harness plugin loaded before the test
module.

`report.json` uses schema `tw-test-report/v1` and contains only reduced facts:
`outcome` (`passed`, `failed`, or `error`), `error`, `tests_collected`,
`tests_run`, `failures` as `{type, phase}` pairs, `detector_seen`,
`detector_attributed`, `detector_calls`, `canary_read`, `violations`,
`target_called`, `module_imported`, and `pytest_exit`. It never contains target
source, a traceback body, test detail, or the canary value.

## M4 quality runs

Every M4 run uses the same bubblewrap command, mounts, interpreter, limits, and
report MAC as gates 2 and 3. The grader only swaps the snapshot directory and
the fixed `PYTHONHASHSEED`:

- gate 2/3: vulnerable/patched with seed `0`;
- gate 4: vulnerable/patched with seeds `1` and `2`;
- gate 5: the hidden still-vulnerable and fixed-differently snapshots with seed
  `0`;
- gate 6: a copy of the patched snapshot with one AST mutant written in, seed
  `0`, repeated for at most 8 mutants.

The canary is fresh for every run. Variant and mutant snapshots are extracted
into private temporary directories owned by the grader; the subagent never sees
them. Mutation generation parses source with `ast` in the grader process and
never imports, executes, or evaluates the target outside the sandbox. Mutant
source is never written to a report; reports contain only killed/ran counts,
the score, and survivor IDs.

The harness installs a Python audit hook at plugin import time, before the test
module is imported. It records and blocks:

- `socket.*`;
- `subprocess.*`, `os.system`, `os.posix_spawn`, and `os.spawn*`;
- `exec` from dynamic test/target code;
- `os.fork` and `os.forkpty`;
- `ctypes`/`_ctypes` imports and `ctypes.*`;
- writes outside `/tmp` and `/work/out` (with `/dev/null` allowed).

Reads or listings under `/canary` are recorded as `canary_read` but are not
blocked, so a read attempt is attributed and fails the safety check rather than
silently changing the run. The hook is a Python-level defense: it cannot see
native code that bypasses the interpreter, and it is not a seccomp boundary.

## The `_limits.py` deviation

`prlimit --nproc` applied *before* bwrap makes bwrap fail on this machine with
`Creating new namespace failed: Resource temporarily unavailable`. The launcher
therefore starts bwrap first, then executes `/work/src/_limits.py` inside the
sandbox. That helper sets `RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_NPROC`,
`RLIMIT_FSIZE`, and `RLIMIT_CORE`, then calls `os.execv` on the real probe. The
probe cannot run without the limits because the only path to it is through the
helper.

## Fail-closed behaviour

- Missing or broken bwrap, bad JSON, a missing probe, or an unusable temp
  directory returns `ok: false` with a `setup_error`.
- There is no unsandboxed execution path and no fallback command.
- The probe is copied to `<work>/src/probe.py`; only that copy is executed, and
  only through bwrap.
- Host `TW_INSTALL_ROOT` and `TW_STORE_ROOT` only select mount sources and the
  temp parent. They cannot disable the sandbox.
- `run_probe(..., extra_env=...)` accepts the argument for API stability and
  ignores it; the sandbox environment is fixed.

## What is NOT isolated

- **Shared kernel.** bubblewrap uses kernel namespaces and mounts, not a virtual
  machine. Kernel bugs are in scope for the host.
- **Timing side channels.** A sandboxed probe can observe how long operations
  take and can infer some host activity.
- **Native code and audit hooks.** M3 adds a Python audit hook for sockets,
  subprocesses, exec, fork, ctypes, and writes outside `/tmp` and `/work/out`.
  That hook is a Python-level defense only: native code can bypass it entirely,
  and there is still no seccomp filter. The protection boundary remains
  bubblewrap plus resource limits.
- **Dependence on unprivileged user namespaces.** If the host disables them, the
  sandbox cannot start. It fails closed instead of running the probe directly.
- **Host resource contention.** `RLIMIT_AS` and `RLIMIT_CPU` are per-process
  limits, not cgroup isolation. Other host load can still affect wall-clock
  timing.
- **Output content.** Output is length-capped, not content-sanitised. Treat every
  captured byte as untrusted data.

## Signal reporting note

bubblewrap reports a payload killed by a signal as exit code `128 + signal`
instead of dying by that signal. The launcher recovers the signal for limit
classification, so a CPU kill appears as `exit_code: 152`, `signal: 24`, and
`limit_hit: cpu`. This keeps the result usable without changing the real exit
status.

## Limit classification is advisory

`limit_hit` is best-effort. It is derived from signals, exit codes, and fixed
probe tokens, and it is **not** a verdict input. The M3 gate must classify from
`report.json` and the process exit status; signal and exit-code evidence wins
over `limit_hit` whenever the two disagree.

## Probe source roots

The runner copies probes only from the installed package, the configured store
root (`TW_STORE_ROOT`, default `<install>/store`), or an explicitly configured
`TW_PROBE_ROOT`. An absolute probe path outside those roots is rejected with
`setup_error: missing_probe` before bubblewrap runs. Relative probe paths stay
anchored at the package root.

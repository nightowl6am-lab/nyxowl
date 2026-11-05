# Sandbox facts and limits (M0)

This document describes what the M0 sandbox actually does on the owner's
machine, what it does not isolate, and why one implementation choice differs
from a conventional `prlimit` wrapper.

## Verified on this machine

| Fact | Value |
| --- | --- |
| Kernel | Linux 7.0.0-42-generic x86_64 |
| bubblewrap | `bubblewrap 0.9.0` at `/usr/bin/bwrap` |
| bubblewrap mode | root-owned `0755`, not setuid |
| Python | `Python 3.12.3` at `/usr/bin/python3` |
| Unprivileged user namespaces | `/proc/sys/kernel/unprivileged_userns_clone = 1` |
| Host processes for the invoking account at test time | about 25 |

The rootless self-tests run as the invoking owner. Production jobs are intended
to run as `tw-grader`, with `/opt/test-writer` and `/var/lib/test-writer` as the
default roots.

## Isolation and limits

| Surface | Mechanism | M0 evidence |
| --- | --- | --- |
| Network | `--unshare-all` creates a network namespace with only loopback | `network_probe.py` prints `NETWORK_FAIL 101` |
| Host environment | `--clearenv` plus five fixed `--setenv` values | `env_probe.py` sees `FAKE_SECRET` as null |
| Host filesystem | only selected read-only binds; no `/home`, no `/var/lib` | `env_probe.py` reports `home_exists: false`, `store_exists: false` |
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
- **Native code and audit hooks.** M0 does not install a Python audit hook. Native
  code can bypass Python-level checks entirely. There is also no seccomp filter
  in M0; the protection boundary is bubblewrap plus resource limits.
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
root (`TW_STORE_ROOT`, default `/var/lib/test-writer`), or an explicitly
configured `TW_PROBE_ROOT`. An absolute probe path outside those roots is
rejected with `setup_error: missing_probe` before bubblewrap runs. Relative
probe paths stay anchored at the package root.

"""Fail-closed bubblewrap launcher for one probe process (M0).

The launcher never executes repository code in the parent.  It copies exactly one
probe into a throw-away work directory, binds that directory read-only into a
bubblewrap sandbox, and starts it through a tiny helper that applies resource
limits from *inside* the sandbox.  Any setup problem returns ``ok: false``; there
is deliberately no unsandboxed fallback path.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

DEFAULT_LIMITS = {
    "wall_seconds": 30,
    "cpu_seconds": 20,
    "memory_mb": 512,
    "max_pids": 64,
    "max_file_mb": 16,
    "max_output_kb": 1024,
}

# Caller-supplied limits are untrusted input.  These ceilings keep a bad or
# hostile request from pinning the host (or allocating absurd buffers) while
# still allowing generous legitimate probes.
LIMIT_MAX = {
    "wall_seconds": 1800,
    "cpu_seconds": 1800,
    "memory_mb": 4096,
    "max_pids": 4096,
    "max_file_mb": 256,
    "max_output_kb": 4096,
}

BWRAP = "/usr/bin/bwrap"
PYTHON = "/usr/bin/python3"
PACKAGE_ROOT = Path(__file__).resolve().parent.parent

try:
    from .ids import safe_join
except ImportError:  # CLI execution: ``python3 grader/sandbox_run.py``
    from ids import safe_join

# Resource limits can only be applied inside the sandbox on this machine: a
# pre-bwrap RLIMIT_NPROC inherited by bwrap makes the kernel refuse to create the
# namespace ("Resource temporarily unavailable").  This helper therefore applies
# every limit and then replaces itself with the real interpreter.
_LIMITS_HELPER = """\
import os
import resource
import sys

cpu = int(sys.argv[1])
address_space = int(sys.argv[2])
nproc = int(sys.argv[3])
file_size = int(sys.argv[4])
program = sys.argv[5]
arguments = sys.argv[6:]

resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
resource.setrlimit(resource.RLIMIT_AS, (address_space, address_space))
resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))
resource.setrlimit(resource.RLIMIT_FSIZE, (file_size, file_size))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
os.execv(program, [program] + arguments)
"""


class SetupError(Exception):
    """A failure that must prevent the probe from running at all."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


class _Capture(threading.Thread):
    """Drain a pipe completely while retaining only a bounded prefix."""

    def __init__(self, stream: Any, limit: int) -> None:
        super().__init__(daemon=True)
        self.stream = stream
        self.limit = limit
        self.data = b""
        self.truncated = False

    def run(self) -> None:
        retained = bytearray()
        try:
            while True:
                chunk = self.stream.read(65536)
                if not chunk:
                    break
                room = self.limit - len(retained)
                if room > 0:
                    retained.extend(chunk[:room])
                    if len(chunk) > room:
                        self.truncated = True
                else:
                    self.truncated = True
        finally:
            # WHY: the parent owns the pipe; closing it at EOF frees the fd, avoiding ResourceWarning.
            try:
                self.stream.close()
            except OSError:
                pass
        self.data = bytes(retained)


def _setup_error(kind: str, message: str) -> dict[str, Any]:
    return {"ok": False, "setup_error": kind, "message": message}


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise SetupError("bad_request", f"{name} must be a positive integer")
    return value


def _normalise_limits(raw: Any) -> tuple[dict[str, int], bool]:
    """Return ``(limits, clamped)`` with every value capped at ``LIMIT_MAX``."""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise SetupError("bad_request", "limits must be an object")
    merged = dict(DEFAULT_LIMITS)
    clamped = False
    for key in DEFAULT_LIMITS:
        if key in raw:
            value = _positive_int(raw[key], key)
            ceiling = LIMIT_MAX[key]
            if value > ceiling:
                value = ceiling
                clamped = True
            merged[key] = value
    return merged, clamped


def _bwrap_version() -> str:
    if not Path(BWRAP).is_file():
        raise SetupError("bwrap_missing", f"{BWRAP} was not found")
    try:
        completed = subprocess.run(
            [BWRAP, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            shell=False,
        )
    except OSError as exc:
        raise SetupError("bwrap_missing", f"could not start {BWRAP}: {exc}") from exc
    if completed.returncode != 0:
        raise SetupError("bwrap_missing", f"{BWRAP} --version failed")
    version = completed.stdout.strip()
    if not version:
        raise SetupError("bwrap_missing", f"{BWRAP} --version returned no text")
    return version


def _process_count_for_uid(uid: int) -> int | None:
    ps = shutil.which("ps")
    if ps is None:
        return None
    try:
        completed = subprocess.run(
            [ps, "-u", str(uid), "--no-headers"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
            shell=False,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    return sum(1 for line in completed.stdout.splitlines() if line.strip())


def _resolve_tmp_root(store_root: Path) -> Path:
    override = os.environ.get("TW_TMP_ROOT")
    if override:
        candidate = Path(override)
        try:
            candidate.mkdir(parents=True, exist_ok=True)
        except OSError:
            candidate = None
        if candidate is not None and os.access(candidate, os.W_OK):
            return candidate
        return Path(tempfile.mkdtemp(prefix="tw-"))

    candidate = store_root / "tmp"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    if os.access(candidate, os.W_OK):
        return candidate
    return Path(tempfile.mkdtemp(prefix="tw-"))


def _is_within(child: Path, parent: Path) -> bool:
    """Return True only when ``child`` resolves inside ``parent``."""
    try:
        child_real = os.path.realpath(os.fspath(child))
        parent_real = os.path.realpath(os.fspath(parent))
        return os.path.commonpath([child_real, parent_real]) == parent_real
    except ValueError:
        # Different drives/roots on some platforms: never treat that as inside.
        return False


def _resolve_probe(probe: str, store_root: Path) -> Path:
    if not isinstance(probe, str) or not probe:
        raise SetupError("bad_request", "probe must be a non-empty string")
    if len(probe) > 4096 or "\x00" in probe:
        raise SetupError("bad_request", "probe path is not valid")
    raw = Path(probe)
    if raw.is_absolute():
        # WHY: this runner is the last trusted component before bwrap.  A caller
        # must not be able to point it at an arbitrary host file and have that
        # file copied into the sandbox and executed as the probe.  Absolute
        # probes are therefore restricted to the package, the store, or an
        # explicitly configured probe root.
        resolved = raw.resolve()
        allowed_roots = [PACKAGE_ROOT, store_root]
        probe_root = os.environ.get("TW_PROBE_ROOT")
        if probe_root:
            allowed_roots.append(Path(probe_root))
        if not any(_is_within(resolved, root) for root in allowed_roots):
            raise SetupError("missing_probe", "absolute probe path is outside the allowed roots")
    else:
        # Relative probes are anchored at the installed package root, not at the
        # caller's working directory, so invocation location cannot alter meaning.
        try:
            resolved = Path(safe_join(str(PACKAGE_ROOT), probe))
        except ValueError as exc:
            raise SetupError("missing_probe", str(exc)) from exc
    if not resolved.is_file():
        raise SetupError("missing_probe", "probe file was not found")
    return resolved


def _build_command(
    work: Path,
    install_root: Path,
    cpu_seconds: int,
    address_space: int,
    nproc_effective: int,
    file_size: int,
    seed: int,
    args: list[str],
) -> list[str]:
    command = [
        BWRAP,
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "HOME",
        "/nonexistent",
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "PYTHONDONTWRITEBYTECODE",
        "1",
        "--setenv",
        "PYTHONHASHSEED",
        str(seed),
    ]

    for path in ("/usr", "/lib", "/lib64"):
        if Path(path).exists():
            command.extend(["--ro-bind", path, path])
    for path in ("/etc/ld.so.cache", "/etc/alternatives"):
        if Path(path).exists():
            command.extend(["--ro-bind", path, path])
    if install_root.exists():
        command.extend(["--ro-bind", str(install_root), "/opt/test-writer"])

    command.extend(
        [
            "--dir",
            "/work",
            "--ro-bind",
            str(work / "src"),
            "/work/src",
            "--ro-bind",
            str(work / "tests"),
            "/work/tests",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            "/canary",
            "--chdir",
            "/work",
            "--",
            PYTHON,
            "/work/src/_limits.py",
            str(cpu_seconds),
            str(address_space),
            str(nproc_effective),
            str(file_size),
            PYTHON,
            "/work/src/probe.py",
            *args,
        ]
    )
    return command


def _classify_limit(
    timed_out: bool,
    exit_signal: int | None,
    combined_output: str,
    stdout_truncated: bool,
    stderr_truncated: bool,
) -> str | None:
    if timed_out:
        return "wall"
    if exit_signal == signal.SIGXCPU:
        return "cpu"
    if exit_signal == signal.SIGXFSZ:
        return "file_size"
    if "EFBIG" in combined_output or "File too large" in combined_output:
        return "file_size"
    if "MEMORYERROR" in combined_output or "MemoryError" in combined_output:
        return "memory"
    if "FORK_FAIL" in combined_output or "EAGAIN" in combined_output:
        return "pids"
    if stdout_truncated or stderr_truncated:
        return "output"
    return None


def _execute(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise SetupError("bad_request", "request must be a JSON object")
    if request.get("mode", "probe") != "probe":
        raise SetupError("bad_request", "only probe mode is supported in M0")

    limits, limits_clamped = _normalise_limits(request.get("limits"))
    seed = request.get("seed", 0)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0xFFFFFFFF:
        raise SetupError("bad_request", "seed must be an integer in [0, 2**32-1]")

    raw_args = request.get("args", [])
    if raw_args is None:
        raw_args = []
    if not isinstance(raw_args, list):
        raise SetupError("bad_request", "args must be a list")
    args: list[str] = []
    for item in raw_args:
        if not isinstance(item, str) or "\x00" in item:
            raise SetupError("bad_request", "every arg must be a NUL-free string")
        args.append(item)

    store_root = Path(os.environ.get("TW_STORE_ROOT", "/var/lib/test-writer"))
    probe = _resolve_probe(request.get("probe", ""), store_root)
    version = _bwrap_version()

    wall_seconds = limits["wall_seconds"]
    cpu_seconds = limits["cpu_seconds"]
    memory_mb = limits["memory_mb"]
    max_pids = limits["max_pids"]
    max_file_mb = limits["max_file_mb"]
    max_output_kb = limits["max_output_kb"]

    address_space = memory_mb * 1024 * 1024
    file_size = max_file_mb * 1024 * 1024
    output_limit = max_output_kb * 1024

    host_processes = _process_count_for_uid(os.getuid())
    if host_processes is None:
        nproc_effective = max_pids
    else:
        # The host account already owns processes; lifting the sandbox ceiling
        # above that count lets the namespace start while still bounding growth.
        nproc_effective = max(max_pids, host_processes + 16)

    try:
        tmp_root = _resolve_tmp_root(store_root)
        work = Path(tempfile.mkdtemp(prefix="tw-work-", dir=str(tmp_root)))
        (work / "src").mkdir()
        (work / "tests").mkdir()
        (work / "src" / "_limits.py").write_text(_LIMITS_HELPER, encoding="utf-8")
        shutil.copyfile(probe, work / "src" / "probe.py")
    except OSError as exc:
        raise SetupError("temp_dir", f"could not create the sandbox work directory: {exc}") from exc

    command = _build_command(
        work,
        Path(os.environ.get("TW_INSTALL_ROOT", "/opt/test-writer")),
        cpu_seconds,
        address_space,
        nproc_effective,
        file_size,
        seed,
        args,
    )

    started = time.monotonic()
    timed_out = False
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin"},
            start_new_session=True,
            shell=False,
        )
        out_reader = _Capture(process.stdout, output_limit)
        err_reader = _Capture(process.stderr, output_limit)
        out_reader.start()
        err_reader.start()

        try:
            process.wait(timeout=wall_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

        out_reader.join(timeout=5)
        err_reader.join(timeout=5)
        duration = time.monotonic() - started

        stdout = out_reader.data.decode("utf-8", errors="replace")
        stderr = err_reader.data.decode("utf-8", errors="replace")
        returncode = process.returncode
        exit_signal = -returncode if returncode is not None and returncode < 0 else None
        exit_code = returncode if returncode is not None and returncode >= 0 else None
        # bwrap reports a payload killed by a signal as 128+signal instead of
        # dying by that signal itself.  Recover it so limit classification and
        # callers see the same value they would from a direct child.
        if exit_signal is None and exit_code is not None and 128 < exit_code <= 128 + 64:
            exit_signal = exit_code - 128
        # WHY: `limit_hit` is advisory only.  It is inferred best-effort from
        # signals, exit codes, and fixed probe tokens.  It must never be the
        # sole basis for a verdict; signal/exit-code evidence wins and the M3
        # gate must classify from the harness report.
        limit_hit = _classify_limit(
            timed_out,
            exit_signal,
            stdout + "\n" + stderr,
            out_reader.truncated,
            err_reader.truncated,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)

    return {
        "ok": True,
        "probe": request.get("probe", ""),
        "exit_code": exit_code,
        "signal": exit_signal,
        "timed_out": timed_out,
        "duration_s": duration,
        "limit_hit": limit_hit,
        "limits_clamped": limits_clamped,
        "stdout": stdout,
        "stderr": stderr,
        "stdout_truncated": out_reader.truncated,
        "stderr_truncated": err_reader.truncated,
        "limits": limits,
        "effective_limits": {
            "wall_seconds": wall_seconds,
            "cpu_seconds": cpu_seconds,
            "memory_mb": memory_mb,
            "address_space_bytes": address_space,
            "max_pids": max_pids,
            "nproc_effective": nproc_effective,
            "max_file_mb": max_file_mb,
            "file_size_bytes": file_size,
            "max_output_kb": max_output_kb,
            "max_output_bytes": output_limit,
        },
        "bwrap_version": version,
    }


def run_request(request: dict[str, Any]) -> dict[str, Any]:
    """Execute one request, converting every failure into a setup error."""
    try:
        return _execute(request)
    except SetupError as exc:
        return _setup_error(exc.kind, exc.message)
    except Exception as exc:  # fail closed: never fall through to an unsandboxed run
        return _setup_error("internal", f"{type(exc).__name__}: {exc}")


def run_probe(
    probe_path: str | os.PathLike[str],
    limits: dict[str, int] | None = None,
    seed: int = 0,
    args: list[str] | None = None,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run one probe through the sandbox; ``extra_env`` is accepted but ignored.

    The environment inside the sandbox is fixed by ``_build_command``.  Keeping
    the argument in the signature prevents callers from believing they can
    inject variables, while the implementation guarantees they cannot.
    """
    del extra_env
    return run_request(
        {
            "mode": "probe",
            "probe": os.fspath(probe_path),
            "limits": limits or {},
            "seed": seed,
            "args": list(args or []),
        }
    )


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        print(json.dumps(_setup_error("bad_json", "stdin must contain one JSON object")))
        return 0
    print(json.dumps(run_request(request), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

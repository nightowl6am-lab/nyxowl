"""Fail-closed bubblewrap launcher for one probe process (M0).

The launcher never executes repository code in the parent.  It copies exactly one
probe into a throw-away work directory, binds that directory read-only into a
bubblewrap sandbox, and starts it through a tiny helper that applies resource
limits from *inside* the sandbox.  Any setup problem returns ``ok: false``; there
is deliberately no unsandboxed fallback path.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
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
VENV_PYTHON = "/opt/test-writer/venv/bin/python"
REPORT_SCHEMA = "tw-test-report/v1"
PACKAGE_ROOT = Path(__file__).resolve().parent.parent

_MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
_FUNCTION_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

try:
    from .ids import safe_join, validate_rel_path
except ImportError:  # CLI execution: ``python3 grader/sandbox_run.py``
    from ids import safe_join, validate_rel_path

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


def _import_path(python_path: list[str]) -> str:
    """Map job ``python_path`` entries to read-only sandbox roots."""
    paths = ["/work/src", "/work/harness"]
    for entry in python_path:
        mapped = "/work/src" if entry == "." else f"/work/src/{entry}"
        if mapped not in paths:
            paths.append(mapped)
    return ":".join(paths)


def _build_test_command(
    work: Path,
    install_root: Path,
    venv_python: Path,
    cpu_seconds: int,
    address_space: int,
    nproc_effective: int,
    file_size: int,
    seed: int,
    module: str,
    function: str,
    python_path: list[str],
    unsafe_return: str = "",
    report_key: str = "",
) -> list[str]:
    """Build the bwrap argv for one pytest proof run.

    The layout is fixed: ``/work/src``, ``/work/tests`` and ``/work/harness``
    are read-only; only ``/work/out`` is writable; ``/canary/value`` is a
    read-only file.  The limits helper is the only path to the venv python.
    """
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
        "--setenv",
        "HYPOTHESIS_STORAGE_DIRECTORY",
        "/tmp/hypothesis",
        "--setenv",
        "PYTHONPATH",
        _import_path(python_path),
        "--setenv",
        "TWP_REPORT",
        "/work/out/report.json",
        "--setenv",
        "TWP_TARGET_MODULE",
        module,
        "--setenv",
        "TWP_TARGET_FUNCTION",
        function,
        "--setenv",
        "TWP_CANARY",
        "/canary/value",
        "--setenv",
        "TWP_UNSAFE_RETURN",
        unsafe_return,
        # The report MAC key is a per-run secret.  It is delivered only through
        # the sandbox environment; the parent keeps its own copy and never puts
        # it in the result or in any log.
        "--setenv",
        "TWP_REPORT_KEY",
        report_key,
    ]

    for path in ("/usr", "/lib", "/lib64"):
        if Path(path).exists():
            command.extend(["--ro-bind", path, path])
    for path in ("/etc/ld.so.cache", "/etc/alternatives"):
        if Path(path).exists():
            command.extend(["--ro-bind", path, path])
    if install_root.exists():
        command.extend(["--ro-bind", str(install_root), str(install_root)])
    venv_root = venv_python.parent.parent
    if venv_root.exists() and not _is_within(venv_python, install_root):
        command.extend(["--ro-bind", str(venv_root), str(venv_root)])

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
            "--ro-bind",
            str(work / "harness"),
            "/work/harness",
            "--bind",
            str(work / "out"),
            "/work/out",
            "--dir",
            "/canary",
            "--ro-bind",
            str(work / "canary" / "value"),
            "/canary/value",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--chdir",
            "/work",
            "--",
            str(venv_python),
            "/work/harness/limits.py",
            str(cpu_seconds),
            str(address_space),
            str(nproc_effective),
            str(file_size),
            str(venv_python),
            "-m",
            "pytest",
            "-c",
            "/work/harness/pytest.ini",
            # The harness only needs failure types.  Disabling tracebacks also
            # stops pytest from reading sensitive source frames to render
            # them, which the audit hook would block.
            "--tb=no",
            "-p",
            "plugin",
            "-p",
            "no:cacheprovider",
            "/work/tests/test.py",
        ]
    )
    return command


_REPORT_BOOL_FIELDS = (
    "detector_seen",
    "detector_attributed",
    "canary_read",
    "target_called",
    "module_imported",
)
_REPORT_INT_FIELDS = ("tests_collected", "tests_run", "detector_calls", "pytest_exit")
_REPORT_ERRORS = {
    None,
    "collection",
    "import",
    "no_tests",
    "skipped",
    "crash",
    "forbidden_fixture",
}
_REPORT_OUTCOMES = {"passed", "failed", "error"}
_REPORT_KEYS = frozenset(
    {
        "schema",
        "outcome",
        "tests_collected",
        "tests_run",
        "failures",
        "detector_seen",
        "detector_attributed",
        "detector_calls",
        "canary_read",
        "violations",
        "target_called",
        "module_imported",
        "error",
        "pytest_exit",
        "mac",
    }
)
_FAILURE_KEYS = frozenset({"type", "phase"})
_HEX_DIGITS = frozenset("0123456789abcdef")


def _valid_report(data: Any) -> bool:
    """Schema-check the untrusted ``report.json`` produced inside bwrap."""
    if not isinstance(data, dict) or data.get("schema") != REPORT_SCHEMA:
        return False
    # The report is a signed, closed record.  An unknown or extra key means the
    # document was not produced by this harness (or was tampered with), so it is
    # invalid rather than being silently ignored.
    if set(data) != _REPORT_KEYS:
        return False
    outcome = data.get("outcome")
    if not isinstance(outcome, str) or outcome not in _REPORT_OUTCOMES:
        return False
    error = data.get("error")
    if error is not None and not isinstance(error, str):
        return False
    if error not in _REPORT_ERRORS:
        return False
    for field in _REPORT_BOOL_FIELDS:
        if not isinstance(data.get(field), bool):
            return False
    for field in _REPORT_INT_FIELDS:
        value = data.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return False
    failures = data.get("failures")
    if not isinstance(failures, list):
        return False
    for failure in failures:
        if not isinstance(failure, dict) or set(failure) != _FAILURE_KEYS:
            return False
        if not isinstance(failure.get("type"), str):
            return False
        phase = failure.get("phase")
        if not isinstance(phase, str) or phase not in {"setup", "call", "teardown"}:
            return False
    violations = data.get("violations")
    if not isinstance(violations, list) or not all(
        isinstance(item, str) for item in violations
    ):
        return False
    return True


def _canonical_report(report: dict[str, Any]) -> bytes:
    """Return the exact bytes the harness MACs.

    The harness and plugin must agree byte-for-byte: UTF-8, sorted keys, compact
    separators, and ASCII-escaped strings (the same options used by the plugin's
    ``json.dump``).
    """
    return json.dumps(
        report,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _valid_report_mac(data: dict[str, Any], key: str) -> bool:
    """Verify the HMAC-SHA256 signature over the report without ``mac``."""
    mac = data.get("mac")
    if (
        not isinstance(mac, str)
        or len(mac) != 64
        or any(character not in _HEX_DIGITS for character in mac)
    ):
        return False
    unsigned = {name: value for name, value in data.items() if name != "mac"}
    try:
        message = _canonical_report(unsigned)
        expected = hmac.new(
            key.encode("utf-8"), message, hashlib.sha256
        ).hexdigest()
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(mac, expected)


def _exit_consistent(
    data: dict[str, Any],
    exit_code: int | None,
    exit_signal: int | None,
) -> bool:
    """Cross-check the report's outcome against the real bwrap process status.

    A report is only trustworthy when the harness exited normally, its recorded
    ``pytest_exit`` matches the process exit code, and the outcome/error shape is
    compatible with that code.  This prevents a leftover or forged ``passed``
    report from being accepted after a failing pytest run.
    """
    if exit_signal is not None or not isinstance(exit_code, int):
        return False
    if data.get("pytest_exit") != exit_code:
        return False

    outcome = data.get("outcome")
    error = data.get("error")
    failures = data.get("failures") or []

    if outcome == "passed":
        return exit_code == 0 and error is None and failures == []
    if outcome == "failed":
        return exit_code != 0 and error is None and bool(failures)
    if outcome == "error":
        if not isinstance(error, str):
            return False
        if error in {"no_tests", "skipped"}:
            # pytest uses 5 for "no tests collected" and 0 for an all-skipped
            # session; both are legitimate for these setup outcomes.
            return exit_code in {0, 5}
        # collection/import/crash/forbidden_fixture must have failed the run.
        return exit_code != 0
    return False


def _read_report(
    work: Path,
    key: str,
    exit_code: int | None,
    exit_signal: int | None,
) -> tuple[dict[str, Any] | None, str | None]:
    path = work / "out" / "report.json"
    try:
        if not path.is_file():
            return None, "missing"
        if path.stat().st_size > 1024 * 1024:
            return None, "invalid"
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, "invalid"
    if not _valid_report(data):
        return None, "invalid"
    if not _valid_report_mac(data, key):
        return None, "invalid"
    if not _exit_consistent(data, exit_code, exit_signal):
        return None, "invalid"
    return data, None


def _normalise_python_path(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str) or not isinstance(raw, (list, tuple)):
        raise SetupError("bad_request", "python_path must be a list of relative paths")
    if len(raw) > 16:
        raise SetupError("bad_request", "python_path has too many entries")
    result: list[str] = []
    for entry in raw:
        if not isinstance(entry, str) or "\x00" in entry or len(entry) > 512:
            raise SetupError("bad_request", "python_path entries must be short strings")
        try:
            validate_rel_path(entry)
        except ValueError as exc:
            raise SetupError("bad_request", f"bad python_path entry: {exc}") from exc
        result.append(entry)
    return result


def _require_dir(value: Any, kind: str, label: str) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise SetupError(kind, f"{label} must be a path")
    path = Path(value)
    if not path.is_dir():
        raise SetupError(kind, f"{label} directory was not found")
    return path


def _require_file(value: Any, kind: str, label: str) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise SetupError(kind, f"{label} must be a path")
    path = Path(value)
    if not path.is_file():
        raise SetupError(kind, f"{label} file was not found")
    return path


def _run_test(
    snapshot_dir: str | os.PathLike[str],
    test_file: str | os.PathLike[str],
    harness_dir: str | os.PathLike[str],
    module: str,
    function: str,
    limits: dict[str, int] | None = None,
    seed: int = 0,
    canary: str | None = None,
    python_path: list[str] | tuple[str, ...] | None = None,
    unsafe_return: str | None = None,
) -> dict[str, Any]:
    if not isinstance(module, str) or _MODULE_RE.fullmatch(module) is None:
        raise SetupError("bad_request", "target module is not a dotted identifier")
    if not isinstance(function, str) or _FUNCTION_RE.fullmatch(function) is None:
        raise SetupError("bad_request", "target function is not an identifier")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0xFFFFFFFF:
        raise SetupError("bad_request", "seed must be an integer in [0, 2**32-1]")
    if canary is not None:
        if not isinstance(canary, str) or "\x00" in canary or len(canary) > 4096:
            raise SetupError("bad_request", "canary must be a short NUL-free string")
    if unsafe_return is not None:
        if not isinstance(unsafe_return, str) or "\x00" in unsafe_return:
            raise SetupError("bad_request", "unsafe_return must be a NUL-free string")
        try:
            encoded_unsafe = unsafe_return.encode("utf-8", "surrogatepass")
        except Exception as exc:
            raise SetupError("bad_request", "unsafe_return is not valid text") from exc
        if len(encoded_unsafe) > 512:
            raise SetupError("bad_request", "unsafe_return must be at most 512 bytes")
    resolved_python_path = _normalise_python_path(python_path)
    limits, limits_clamped = _normalise_limits(limits)
    version = _bwrap_version()
    # Per-run secret used to authenticate the harness report.  It only ever
    # travels through the sandbox environment and stays in this frame otherwise.
    report_key = secrets.token_hex(32)

    venv_python = Path(VENV_PYTHON)
    if not venv_python.is_file() or not os.access(venv_python, os.X_OK):
        raise SetupError("venv_missing", f"{VENV_PYTHON} was not found")

    snapshot = _require_dir(snapshot_dir, "missing_snapshot", "snapshot")
    test_source = _require_file(test_file, "missing_test", "test")
    harness = _require_dir(harness_dir, "missing_harness", "harness")
    if not (harness / "plugin.py").is_file() or not (harness / "pytest.ini").is_file():
        raise SetupError(
            "missing_harness", "harness must contain plugin.py and pytest.ini"
        )

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
    nproc_effective = (
        max_pids if host_processes is None else max(max_pids, host_processes + 16)
    )

    store_root = Path(os.environ.get("TW_STORE_ROOT", "/var/lib/test-writer"))
    try:
        tmp_root = _resolve_tmp_root(store_root)
        work = Path(tempfile.mkdtemp(prefix="tw-test-work-", dir=str(tmp_root)))
    except OSError as exc:
        raise SetupError("temp_dir", f"could not create the sandbox work directory: {exc}") from exc

    report: dict[str, Any] | None = None
    report_error: str | None = "missing"
    started = time.monotonic()
    timed_out = False
    try:
        try:
            (work / "tests").mkdir()
            (work / "out").mkdir()
            (work / "canary").mkdir()
            shutil.copytree(snapshot, work / "src")
            shutil.copyfile(test_source, work / "tests" / "test.py")
            shutil.copytree(harness, work / "harness")
            (work / "harness" / "limits.py").write_text(_LIMITS_HELPER, encoding="utf-8")
            (work / "canary" / "value").write_text(canary or "", encoding="utf-8")
            os.chmod(work / "canary" / "value", 0o600)
        except OSError as exc:
            raise SetupError("temp_dir", f"could not stage the sandbox: {exc}") from exc

        command = _build_test_command(
            work,
            Path(os.environ.get("TW_INSTALL_ROOT", "/opt/test-writer")),
            venv_python,
            cpu_seconds,
            address_space,
            nproc_effective,
            file_size,
            seed,
            module,
            function,
            resolved_python_path,
            unsafe_return or "",
            report_key,
        )

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
        except OSError as exc:
            raise SetupError("bwrap_missing", f"could not start {BWRAP}: {exc}") from exc

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
        if exit_signal is None and exit_code is not None and 128 < exit_code <= 128 + 64:
            exit_signal = exit_code - 128
        limit_hit = _classify_limit(
            timed_out,
            exit_signal,
            stdout + "\n" + stderr,
            out_reader.truncated,
            err_reader.truncated,
        )
        report, report_error = _read_report(
            work, report_key, exit_code, exit_signal
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)

    return {
        "ok": True,
        "report": report,
        "report_error": report_error,
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


def _execute_test(request: dict[str, Any]) -> dict[str, Any]:
    return _run_test(
        snapshot_dir=request.get("snapshot", request.get("snapshot_dir")),
        test_file=request.get("test_file", request.get("test")),
        harness_dir=request.get("harness", request.get("harness_dir")),
        module=request.get("target_module", request.get("module")),
        function=request.get("target_function", request.get("function")),
        limits=request.get("limits"),
        seed=request.get("seed", 0),
        canary=request.get("canary"),
        python_path=request.get("python_path"),
        unsafe_return=request.get("unsafe_return"),
    )


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
    mode = request.get("mode", "probe")
    if mode == "test":
        return _execute_test(request)
    if mode != "probe":
        raise SetupError("bad_request", "mode must be 'probe' or 'test'")

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


def run_test(
    snapshot_dir: str | os.PathLike[str] | None = None,
    test_file: str | os.PathLike[str] | None = None,
    harness_dir: str | os.PathLike[str] | None = None,
    module: str | None = None,
    function: str | None = None,
    limits: dict[str, int] | None = None,
    seed: int = 0,
    canary: str | None = None,
    python_path: list[str] | tuple[str, ...] | None = None,
    unsafe_return: str | None = None,
    *,
    snapshot: str | os.PathLike[str] | None = None,
    test: str | os.PathLike[str] | None = None,
    harness: str | os.PathLike[str] | None = None,
    target_module: str | None = None,
    target_function: str | None = None,
) -> dict[str, Any]:
    """Run one proof test inside bwrap and return its schema-checked report.

    Every failure to set up the sandbox is returned as ``ok: False`` with a
    stable ``setup_error``.  A missing or invalid ``report.json`` is reported as
    ``report: null`` with ``report_error: missing|invalid``; it is not a setup
    crash.  There is no unsandboxed fallback.  The keyword aliases mirror the
    JSON request field names used by ``run_request``.
    """
    snapshot_dir = snapshot_dir if snapshot_dir is not None else snapshot
    test_file = test_file if test_file is not None else test
    harness_dir = harness_dir if harness_dir is not None else harness
    module = module if module is not None else target_module
    function = function if function is not None else target_function
    try:
        return _run_test(
            snapshot_dir=snapshot_dir,
            test_file=test_file,
            harness_dir=harness_dir,
            module=module,
            function=function,
            limits=limits,
            seed=seed,
            canary=canary,
            python_path=python_path,
            unsafe_return=unsafe_return,
        )
    except SetupError as exc:
        return _setup_error(exc.kind, exc.message)
    except Exception as exc:  # fail closed: never fall through to an unsandboxed run
        return _setup_error("internal", f"{type(exc).__name__}: {exc}")


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

"""Pytest plugin that runs a proof test inside the bubblewrap sandbox.

The plugin is loaded before pytest imports the test module.  It installs a
Python audit hook, imports the target module named by the fixed ``TWP_*``
environment, wraps the entry function so calls can be attributed, provides the
``detector`` fixture, and writes one atomic ``report.json`` when the session
finishes.

Design invariants
-----------------
* The audit hook is installed before any test module is imported.
* The hook records a stable violation kind and raises ``RuntimeError``.  It
  canonicalises paths with ``realpath`` but never opens a file.  Reads under
  ``/canary`` are recorded but allowed; test-initiated reads of the target,
  harness, or grader are blocked as ``sensitive_read``.
* During a test (setup through teardown) the target is no longer a trusted
  reader of its own snapshot.  Only import machinery may read ``/work/src``;
  the pytest/plugin runtime may still read the harness and grader it owns.
  This closes the "target reads its own source, test branches on the source"
  bypass, while collection-time target reads remain available for import.
* Only the report path (``/work/out/report.json``) is written; the parent
  sandbox owns that writable mount.
* The report contains no target source, traceback body, canary value, or test
  detail.  Failures are reduced to ``{type, phase}``.
* A missing or broken report is handled by the parent as ``report: null``; this
  plugin never falls back to an unsandboxed path.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import os
import sys
import tempfile
import threading
from typing import Any

import pytest

SCHEMA = "tw-test-report/v1"

REPORT_PATH_ENV = "TWP_REPORT"
REPORT_KEY_ENV = "TWP_REPORT_KEY"
TARGET_MODULE_ENV = "TWP_TARGET_MODULE"
TARGET_FUNCTION_ENV = "TWP_TARGET_FUNCTION"
CANARY_ENV = "TWP_CANARY"
UNSAFE_RETURN_ENV = "TWP_UNSAFE_RETURN"

# Capture the per-run key at import time and then remove it from the
# environment.  The test module and the target import happen later, so neither
# can read the key back out of ``os.environ``.
_report_key = os.environ.pop(REPORT_KEY_ENV, "")

WRITE_ROOTS = ("/tmp", "/work/out")
WRITE_FILES = ("/dev/null",)
CANARY_ROOT = "/canary"
_canary_path = os.environ.get(CANARY_ENV, CANARY_ROOT + "/value")
_unsafe_return_marker = os.environ.get(UNSAFE_RETURN_ENV, "")

# Test code may not read the target snapshot or the harness.  Import machinery
# is trusted for every root; the pytest/plugin runtime is trusted for the roots
# it owns.  Target code is trusted for its own snapshot only outside a test
# (collection/import time).  The rootless runtime is not mounted under a fixed
# system path, so no host install path is part of this in-sandbox boundary.
TARGET_ROOT = "/work/src"
SENSITIVE_ROOTS = (
    TARGET_ROOT,
    "/work/harness",
)
PROC_SENSITIVE = (
    "/proc/self/mem",
    "/proc/self/maps",
    "/proc/self/fd",
    "/proc/self/environ",
)
_FORBIDDEN_FIXTURES = frozenset(
    {"request", "pytestconfig", "monkeypatch", "mocker"}
)

# Mutable state deliberately lives at module scope: one pytest process runs one
# proof test file, and pytest hooks are module functions.
_violations: set[str] = set()
_canary_read = False
_target_called = False
_target_called_current = False
_target_calls = 0
_target_last_return: Any = None
_detector_seen = False
_detector_attributed = False
_detector_calls = 0
_forbidden_fixture = False
_failures: list[dict[str, str]] = []
_tests_run = 0
_skipped = 0
_collection_failed = False
_module_imported = False
_import_failed = False
_test_phase = False
_target_module: Any = None
_target_function_name = ""
_audit_state = threading.local()


def _real(path: Any) -> str:
    """Return a canonical path, or an empty string for unusable values."""
    if isinstance(path, int):
        return ""
    try:
        return os.path.realpath(os.fsdecode(os.fspath(path)))
    except (TypeError, ValueError, OSError):
        return ""


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + os.sep)


def _write_allowed(path: Any) -> bool:
    resolved = _real(path)
    if not resolved:
        return False
    if resolved in WRITE_FILES:
        return True
    return any(_under(resolved, root) for root in WRITE_ROOTS)


def _is_canary(path: Any) -> bool:
    resolved = _real(path)
    if not resolved:
        return False
    return _under(resolved, CANARY_ROOT) or resolved == _real(_canary_path)


def _is_sensitive(path: Any) -> bool:
    resolved = _real(path)
    if not resolved:
        return False
    return any(_under(resolved, root) for root in SENSITIVE_ROOTS)


def _is_proc_sensitive(path: Any) -> bool:
    resolved = _real(path)
    if not resolved:
        return False
    for root in PROC_SENSITIVE:
        if _under(resolved, root):
            return True
    return False


def _frame_kind(filename: str) -> str | None:
    """Classify one frame as test, target, import, runtime, or unknown."""
    if filename.startswith("<frozen") or "/importlib/" in filename:
        return "import"
    if filename.startswith("<"):
        return None
    resolved = _real(filename)
    if not resolved:
        return None
    if resolved == _PLUGIN_FILE:
        return "runtime"
    if _under(resolved, "/work/tests"):
        return "test"
    if _under(resolved, TARGET_ROOT):
        return "target"
    if any(_under(resolved, root) for root in _RUNTIME_DIRS):
        return "runtime"
    return None


def _read_allowed(path: Any) -> bool:
    """True when the nearest relevant frame may read sensitive ``path``.

    Import machinery is always trusted.  Test code never is.  Target code may
    read its own snapshot only outside a test phase; while a test runs the
    target is just another untrusted caller.  Pytest/plugin runtime frames are
    trusted for the roots they own, but they are only accepted after the whole
    stack has been scanned so a test (or target) frame further out still wins.
    Unknown callers fail closed.
    """
    resolved = _real(path)
    if not resolved:
        return False
    runtime = False
    for depth in range(1, 60):
        try:
            frame = sys._getframe(depth)
        except ValueError:
            break
        kind = _frame_kind(frame.f_code.co_filename)
        if kind == "test":
            return False
        if kind == "import":
            return True
        if kind == "target":
            if not _test_phase and _under(resolved, TARGET_ROOT):
                return True
            return False
        if kind == "runtime":
            # The pytest runtime owns the harness/grader roots, but it is not
            # import machinery: it may never read the target snapshot.  A
            # runtime frame is only tentative so a test/target frame further
            # out still wins.
            if not _under(resolved, TARGET_ROOT):
                runtime = True
    return runtime


def _record_violation(kind: str) -> None:
    _violations.add(kind)


def _block(kind: str) -> None:
    _record_violation(kind)
    raise RuntimeError(f"audit violation: {kind}")


def _event_kind(event: str) -> str | None:
    if event.startswith("socket."):
        return "socket"
    if (
        event.startswith("subprocess.")
        or event == "os.system"
        or event == "os.posix_spawn"
        or event == "os.spawn"
        or event.startswith("os.spawn")
    ):
        return "subprocess"
    if event == "os.exec" or event.startswith("os.exec"):
        return "exec"
    if event in {"os.fork", "os.forkpty"}:
        return "fork"
    if event.startswith("ctypes."):
        return "ctypes"
    return None


_PLUGIN_FILE = os.path.realpath(__file__)


def _runtime_dirs() -> tuple[str, ...]:
    """Return the dirs that belong to the pytest runtime itself."""
    roots: list[str] = []
    for name in ("pytest", "_pytest"):
        module = sys.modules.get(name)
        filename = getattr(module, "__file__", None)
        if isinstance(filename, str) and filename:
            root = os.path.realpath(os.path.dirname(filename))
            if root not in roots:
                roots.append(root)
    return tuple(roots)


_RUNTIME_DIRS = _runtime_dirs()


def _caller_path() -> str:
    """Return the first non-plugin, non-importlib caller file, if any."""
    for depth in range(3, 10):
        try:
            frame = sys._getframe(depth)
        except ValueError:
            return ""
        filename = os.path.realpath(frame.f_code.co_filename)
        if filename == _PLUGIN_FILE or filename.startswith("<frozen"):
            continue
        return filename
    return ""


def _dynamic_exec(code: Any) -> bool:
    """True for builtin exec/eval that originates in test or target code.

    The import machinery also emits the ``exec`` event, but it executes code
    objects whose ``co_filename`` is the module path.  Those are allowed.  A
    dynamic ``exec("...")`` compiles to ``<string>``; it is blocked when the
    caller is the test file or target snapshot, and allowed when it comes from
    a trusted library helper such as ``collections.namedtuple``.
    """
    filename = getattr(code, "co_filename", None)
    if isinstance(filename, str) and filename not in {
        "<string>",
        "<stdin>",
        "<unknown>",
        "",
    }:
        return False
    if not isinstance(filename, str):
        return True
    caller = _caller_path()
    if not caller:
        return True
    return _under(caller, "/work/tests") or _under(caller, "/work/src")


def _is_write_mode(mode: Any) -> bool:
    return isinstance(mode, str) and any(flag in mode for flag in "wax+")


def _audit(event: str, args: tuple[Any, ...]) -> None:
    """Audit hook entry point with a re-entrancy guard.

    The sensitive-path checks call ``realpath``, which itself emits
    ``os.lstat``/``os.readlink`` audit events.  Those nested events are
    plugin-internal I/O and must not recurse into the same checks.
    """
    if getattr(_audit_state, "active", False):
        return
    _audit_state.active = True
    try:
        _audit_inner(event, args)
    finally:
        _audit_state.active = False


def _audit_inner(event: str, args: tuple[Any, ...]) -> None:
    """Record canary reads, block dangerous actions, and block test reads."""
    global _canary_read

    # Import machinery opens source through ``io.open_code``.  It must stay
    # usable for imports, but it is still a read path: a lint bypass (or target
    # code) can call ``io.open_code`` directly.  Apply the same frame-aware
    # decision as ``open`` so only import machinery (and, outside a test, the
    # target's own snapshot) may read a sensitive root.
    if event == "open_code":
        path = args[0] if args else None
        if isinstance(path, int):
            # ``open_code`` always takes a path, but keep parity with ``open``
            # if a future implementation hands back a descriptor.
            return
        if _is_proc_sensitive(path) or (
            _is_sensitive(path) and not _read_allowed(path)
        ):
            _block("sensitive_read")
        return

    if event == "exec":
        code = args[0] if args else None
        if _dynamic_exec(code):
            _block("exec")
        return

    if event == "import" and args and args[0] in {"ctypes", "_ctypes"}:
        _block("ctypes")

    kind = _event_kind(event)
    if kind is not None:
        _block(kind)

    if event == "open":
        path = args[0] if args else None
        mode = args[1] if len(args) > 1 else None
        if isinstance(path, int):
            # ``os.fdopen``/``io.open`` on an existing descriptor.  The
            # descriptor was already vetted when it was opened by path.
            return
        if _is_write_mode(mode):
            if not _write_allowed(path):
                _block("write_outside_tmp")
        elif _is_canary(path):
            _canary_read = True
        elif _is_proc_sensitive(path) or (
            _is_sensitive(path) and not _read_allowed(path)
        ):
            _block("sensitive_read")
        return

    if event in {"os.listdir", "os.scandir", "os.stat", "os.lstat"}:
        path = args[0] if args else None
        if _is_canary(path):
            _canary_read = True
        elif _is_proc_sensitive(path) or (
            _is_sensitive(path) and not _read_allowed(path)
        ):
            _block("sensitive_read")
        return

    write_paths: tuple[Any, ...] = ()
    if event in {"os.remove", "os.unlink", "os.rmdir", "os.mkdir", "os.chmod",
                 "os.chown", "os.truncate", "os.utime"}:
        write_paths = (args[0] if args else None,)
    elif event in {"os.rename", "os.replace"}:
        write_paths = (args[0] if args else None, args[1] if len(args) > 1 else None)
    elif event in {"os.link", "os.symlink"}:
        # The source names a sensitive root; the destination is the new name.
        source = args[0] if args else None
        if _is_sensitive(source) or _is_proc_sensitive(source):
            _block("sensitive_read")
        write_paths = (args[1] if len(args) > 1 else None,)

    if write_paths:
        for path in write_paths:
            if not _write_allowed(path):
                _block("write_outside_tmp")


# WHY: this must happen at plugin import time, before pytest imports the test
# module or a conftest.
sys.addaudithook(_audit)


def _return_contains(value: Any, marker: str) -> bool:
    """True when a target return value contains ``marker``.

    Only strings and bytes are considered.  Byte values are decoded with
    replacement so a malformed byte sequence cannot raise from the oracle.
    """
    if isinstance(value, bytes):
        text = value.decode("utf-8", "replace")
    elif isinstance(value, str):
        text = value
    else:
        return False
    return marker in text


class _Detector:
    """Small oracle helper handed to the proof test as ``detector``."""

    def check(self, condition: Any, *, detail: str = "") -> None:
        global _detector_seen, _detector_attributed, _detector_calls

        _detector_calls += 1
        if not condition:
            return None

        if _unsafe_return_marker:
            # The condition alone is not trusted: the target must have run in
            # this test and its last return value must contain the job's
            # marker.  A truthy check without that evidence still fails the
            # test, but it must never become an attributed hit.
            if not (
                _target_called_current
                and _return_contains(_target_last_return, _unsafe_return_marker)
            ):
                raise AssertionError(
                    str(detail) if detail else "detector condition was true"
                )
            _detector_seen = True
            _detector_attributed = True
        else:
            _detector_seen = True
            if _target_called_current:
                _detector_attributed = True

        # Never include target source, canary data, or target output here.
        raise AssertionError(str(detail) if detail else "detector condition was true")


@pytest.fixture
def detector() -> _Detector:
    return _Detector()


def _wrap_target(module: Any, name: str) -> None:
    global _target_function_name

    original = getattr(module, name)
    if not callable(original):
        raise TypeError("target entry is not callable")

    def wrapped(*args: Any, **kwargs: Any) -> Any:
        global _target_called, _target_called_current, _target_calls
        global _target_last_return

        _target_called = True
        _target_called_current = True
        _target_calls += 1
        result = original(*args, **kwargs)
        _target_last_return = result
        return result

    try:
        wrapped.__name__ = getattr(original, "__name__", name)
        wrapped.__doc__ = getattr(original, "__doc__", None)
    except (AttributeError, TypeError):
        pass
    setattr(module, name, wrapped)
    _target_function_name = name


def pytest_configure(config: pytest.Config) -> None:
    """Import the target and wrap its entry point before collection."""
    global _target_module, _module_imported, _import_failed

    del config
    name = os.environ.get(TARGET_MODULE_ENV, "")
    function = os.environ.get(TARGET_FUNCTION_ENV, "")
    if not name or not function:
        _import_failed = True
        return
    try:
        module = importlib.import_module(name)
        _wrap_target(module, function)
        _target_module = module
        _module_imported = True
    except BaseException:
        # WHY: the parent needs a stable answer, not a traceback body.  The
        # exception type is intentionally not propagated into the report.
        _import_failed = True


def _forbidden_fixture_names(item: pytest.Item) -> set[str]:
    """Return directly requested forbidden fixtures for one test item.

    ``item.fixturenames`` includes transitive dependencies.  pytest's builtin
    ``tmp_path`` legitimately depends on ``request``, so only a fixture the
    test itself declares (or names in ``usefixtures``) is fatal.  The test
    never receives a transitive ``request`` object and cannot use it.
    """
    info = getattr(item, "_fixtureinfo", None)
    direct = set(getattr(info, "argnames", ()) or ())
    for marker in item.iter_markers("usefixtures"):
        direct.update(name for name in marker.args if isinstance(name, str))
    fixturenames = set(getattr(item, "fixturenames", ()) or ())
    return (direct & fixturenames) & _FORBIDDEN_FIXTURES


def pytest_runtest_setup(item: pytest.Item) -> None:
    """Reset per-test state and reject forbidden pytest fixtures."""
    global _target_called_current, _target_last_return
    global _detector_seen, _detector_attributed, _detector_calls, _forbidden_fixture
    global _test_phase

    # From here until teardown finishes, target frames are untrusted readers.
    _test_phase = True
    _target_called_current = False
    _target_last_return = None
    _detector_seen = False
    _detector_attributed = False
    _detector_calls = 0

    if _forbidden_fixture_names(item):
        _forbidden_fixture = True
        raise pytest.fail("forbidden fixture", pytrace=False)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(
    item: pytest.Item, nextitem: pytest.Item | None
):
    """Keep the test phase active until every teardown hook has finished."""
    del item, nextitem
    global _test_phase

    try:
        yield
    finally:
        # WHY: setup failures still get a teardown pass; resetting in ``finally``
        # guarantees the next test (or session end) never inherits the flag.
        _test_phase = False


def pytest_collectreport(report: pytest.CollectReport) -> None:
    global _collection_failed

    if report.failed:
        _collection_failed = True


def _exception_type(call: pytest.CallInfo[Any]) -> str:
    excinfo = getattr(call, "excinfo", None)
    if excinfo is not None:
        try:
            return str(excinfo.type.__name__)
        except (AttributeError, TypeError):
            pass
    return "Exception"


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[Any]):
    del item
    global _tests_run, _skipped, _failures

    outcome = yield
    report = outcome.get_result()
    if report.when == "setup":
        if report.skipped:
            _skipped += 1
        if report.failed:
            _tests_run += 1
            _failures.append({"type": _exception_type(call), "phase": "setup"})
    elif report.when == "call":
        _tests_run += 1
        if report.skipped:
            _skipped += 1
        if report.failed:
            _failures.append({"type": _exception_type(call), "phase": "call"})
    elif report.when == "teardown" and report.failed:
        _failures.append({"type": _exception_type(call), "phase": "teardown"})


def _atomic_json(path: str, payload: dict[str, Any]) -> None:
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".tw-report-", dir=parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass


def _sign_report(report: dict[str, Any], key: str) -> str:
    """Return HMAC-SHA256 over the canonical report object (without ``mac``)."""
    message = json.dumps(
        report,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hmac.new(key.encode("utf-8"), message, hashlib.sha256).hexdigest()


def _build_report(exitstatus: int, collected: int) -> dict[str, Any]:
    if _forbidden_fixture:
        error: str | None = "forbidden_fixture"
    elif _import_failed:
        error = "import"
    elif _collection_failed:
        error = "collection"
    elif collected == 0:
        error = "no_tests"
    elif _skipped:
        error = "skipped"
    elif _failures:
        error = None
    elif int(exitstatus) in {2, 3, 4} or int(exitstatus) > 1:
        error = "crash"
    else:
        error = None

    if _forbidden_fixture:
        outcome = "error"
    elif _import_failed:
        outcome = "error"
    elif _collection_failed:
        outcome = "error"
    elif collected == 0:
        outcome = "error"
    elif _skipped:
        outcome = "error"
    elif _failures:
        outcome = "failed"
    elif error is not None:
        outcome = "error"
    else:
        outcome = "passed"

    detector_calls = int(_detector_calls)
    target_calls = int(_target_calls)
    # A report may only carry attribution when both the detector and the target
    # wrapper actually ran.  A forged boolean, or a detector call with no target
    # call, is not evidence and is reported as a non-hit.
    attribution_ready = detector_calls > 0 and target_calls > 0
    detector_seen = bool(_detector_seen) and attribution_ready
    detector_attributed = bool(_detector_attributed) and detector_seen

    return {
        "schema": SCHEMA,
        "outcome": outcome,
        "tests_collected": int(collected),
        "tests_run": int(_tests_run),
        "failures": list(_failures),
        "detector_seen": detector_seen,
        "detector_attributed": detector_attributed,
        "detector_calls": detector_calls,
        "canary_read": bool(_canary_read),
        "violations": sorted(_violations),
        "target_called": bool(_target_called) and target_calls > 0,
        "module_imported": bool(_module_imported),
        "error": error,
        "pytest_exit": int(exitstatus),
    }


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    collected = len(getattr(session, "items", []) or [])
    report = _build_report(int(exitstatus), collected)
    target = os.environ.get(REPORT_PATH_ENV, "")
    if not target:
        return
    # The parent rejects any report without a valid MAC.  If the per-run key is
    # unexpectedly absent we still write the report, but it is unsigned and the
    # parent will treat it as invalid (fail closed).
    if _report_key:
        report["mac"] = _sign_report(report, _report_key)
    _atomic_json(target, report)

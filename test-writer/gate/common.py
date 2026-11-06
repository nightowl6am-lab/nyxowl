"""Shared helpers for the Test-Writer M3 gate modules.

Everything here is stdlib-only and deliberately small: deterministic JSON,
bounded stdin readers, install/workspace path resolution, timestamp helpers,
stable refusal tokens, and marker-free subagent feedback.

The broker sanitizer drops any feedback value containing ``canary``,
``variant``, ``mutant``, ``stdout`` or ``stderr``.  The owner-facing report and
the private job state keep the real reason code; only the subagent-facing
feedback is aliased.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    from grader.ids import validate_job_id, validate_ref, validate_rel_path, safe_join
    from grader import reasons
except ImportError:  # pragma: no cover - installed layout always has grader
    from ids import validate_job_id, validate_ref, validate_rel_path, safe_join  # type: ignore
    import reasons  # type: ignore

MAX_TEST_BYTES = 51_200
MAX_PREPARE_BYTES = 262_144
MAX_FINISH_BYTES = 8_192
MAX_BUNDLE_BYTES = 256 * 1024 * 1024

DEFAULT_INSTALL_ROOT = "/opt/test-writer"
DEFAULT_STORE_ROOT = "/var/lib/test-writer"
DEFAULT_WORKSPACE_ROOT = "~/tw-jobs"

META_FILE = "meta.json"
MANIFEST_FILE = "manifest.json"
VULNERABLE_TAR = "src-vulnerable.tar"
PATCHED_TAR = "src-patched.tar"
BUNDLE_FILES = (META_FILE, MANIFEST_FILE, VULNERABLE_TAR, PATCHED_TAR)

DEFAULT_BUDGET = {
    "wall_seconds": 60,
    "cpu_seconds": 10,
    "memory_mb": 512,
    "max_pids": 32,
    "max_attempts": 3,
}
DEFAULT_DETECTOR = {
    "fixture": "detector",
    "truthy_means": "the target exhibited the unsafe behavior",
    "contract": "test-writer/HELPER_API.md",
}
DEFAULT_HELPER_API = "test-writer/HELPER_API.md"

JOB_EXISTS = "JOB_EXISTS"
JOB_INVALID = "JOB_INVALID"
JOB_CLOSED = "JOB_CLOSED"
JOB_NOT_OPEN = "JOB_NOT_OPEN"
BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
GATE_UNAVAILABLE = "GATE_UNAVAILABLE"
BUSY = "BUSY"
RUNTIME_UNAVAILABLE = "RUNTIME_UNAVAILABLE"
BAD_REQUEST = "BAD_REQUEST"

FORBIDDEN_MARKERS = ("canary", "/canary", "variant", "mutant", "stdout", "stderr")

_SAFE_HINTS = {
    "SAFETY_FAILURE": "The run was stopped by a safety check.",
    "QUALITY_ISSUE": "The test did not meet the quality bar.",
    "GRADER_REFUSED": "The grader refused the request.",
    JOB_EXISTS: "A job with that identifier already exists.",
    JOB_INVALID: "The job metadata is missing or invalid.",
    JOB_CLOSED: "The job is closed.",
    JOB_NOT_OPEN: "The job is not open for a gate run.",
    BUDGET_EXHAUSTED: "The job has used every attempt.",
    GATE_UNAVAILABLE: "That gate is not available in this runtime.",
    BUSY: "Another gate run is already using this job.",
    RUNTIME_UNAVAILABLE: "The Test-Writer runtime is not installed.",
    BAD_REQUEST: "The request could not be read.",
}

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent


class Refusal(Exception):
    """A typed, owner-visible refusal that is safe to print as JSON."""

    def __init__(
        self,
        token: str,
        message: str = "",
        *,
        exit_code: int = 0,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self.token = token
        self.message = message or _SAFE_HINTS.get(token, "")
        self.exit_code = exit_code
        self.extra = extra or {}
        super().__init__(self.message)


class ProtocolError(Refusal):
    """A malformed request or invocation; exits non-zero by contract."""

    def __init__(self, message: str) -> None:
        super().__init__(BAD_REQUEST, message, exit_code=2)


def install_root() -> Path:
    return Path(os.environ.get("TW_INSTALL_ROOT", DEFAULT_INSTALL_ROOT))


def store_root() -> Path:
    return Path(os.environ.get("TW_STORE_ROOT", DEFAULT_STORE_ROOT))


def workspace_root() -> Path:
    return Path(os.environ.get("TW_WORKSPACE_ROOT", DEFAULT_WORKSPACE_ROOT)).expanduser()


def tmp_root() -> Path:
    raw = os.environ.get("TW_TMP_ROOT")
    if raw:
        return Path(raw)
    return store_root() / "tmp"


def ensure_tmp_root() -> Path:
    """Create and return the configured scratch root with private mode."""
    path = tmp_root()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


def package_root() -> Path:
    """Return the directory that contains ``grader/`` and ``gate/``."""
    return _PACKAGE_ROOT


def harness_dir() -> Path:
    """Return the installed harness, falling back to the repository package."""
    installed = install_root() / "grader" / "harness"
    if (installed / "plugin.py").is_file() and (installed / "pytest.ini").is_file():
        return installed
    fallback = package_root() / "grader" / "harness"
    if (fallback / "plugin.py").is_file() and (fallback / "pytest.ini").is_file():
        return fallback
    raise Refusal(JOB_INVALID, "The grader harness is not installed.")


def helper_api_text() -> str:
    """Resolve ``HELPER_API.md`` for the job input response."""
    candidates = (
        install_root() / "HELPER_API.md",
        package_root() / "HELPER_API.md",
    )
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate.read_text(encoding="utf-8")
        except OSError:
            continue
    raise Refusal(JOB_INVALID, "HELPER_API.md could not be resolved.")


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def emit_json(payload: Any) -> None:
    """Write one deterministic, ASCII JSON document to stdout."""
    sys.stdout.write(
        json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        + "\n"
    )
    sys.stdout.flush()


def refusal_payload(refusal: Refusal) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": False,
        "reason": refusal.token,
        "message": refusal.message,
        "verdict": None,
        "flags": [],
        "closed": refusal.token == JOB_CLOSED,
    }
    payload.update(refusal.extra)
    return payload


def read_stdin_bytes(limit: int) -> bytes:
    """Read at most ``limit`` bytes and refuse a larger payload."""
    data = sys.stdin.buffer.read(limit + 1)
    if len(data) > limit:
        raise ProtocolError("The request body exceeded its byte limit.")
    return data


def read_stdin_text(limit: int) -> str:
    data = read_stdin_bytes(limit)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ProtocolError("The request body was not valid UTF-8.") from exc


def read_stdin_json(limit: int) -> Any:
    raw = read_stdin_text(limit)
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ProtocolError("The request body was not valid JSON.") from exc


def copy_stdin_to_file(destination: str | os.PathLike[str], limit: int) -> int:
    """Stream stdin to ``destination`` with a hard byte cap."""
    total = 0
    source = sys.stdin.buffer
    with open(destination, "wb") as output:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ProtocolError("The request body exceeded its byte limit.")
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    return total


def read_json_file(path: str | os.PathLike[str]) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _job_directory(job_id: str) -> Path:
    return store_root() / "jobs" / job_id


def read_state_readonly(job_id: str) -> dict[str, Any] | None:
    """Read state without creating any store directory."""
    path = _job_directory(job_id) / "state.json"
    if not path.is_file():
        return None
    try:
        data = read_json_file(path)
    except (OSError, ValueError) as exc:
        raise Refusal(JOB_INVALID, "The job state could not be read.") from exc
    if not isinstance(data, dict):
        raise Refusal(JOB_INVALID, "The job state is not an object.")
    return data


def read_meta_readonly(job_id: str) -> dict[str, Any] | None:
    """Read metadata without creating any store directory."""
    path = _job_directory(job_id) / "meta.json"
    if not path.is_file():
        return None
    try:
        data = read_json_file(path)
    except (OSError, ValueError) as exc:
        raise Refusal(JOB_INVALID, "The job metadata could not be read.") from exc
    if not isinstance(data, dict):
        raise Refusal(JOB_INVALID, "The job metadata is not an object.")
    return data


def write_json_atomic(path: str | os.PathLike[str], payload: Any, mode: int = 0o600) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent, text=True
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass


def write_text_atomic(path: str | os.PathLike[str], text: str, mode: int = 0o600) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent, text=True
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass


def _contains_marker(value: Any) -> bool:
    try:
        serialized = json.dumps(value, ensure_ascii=True, sort_keys=True)
    except (TypeError, ValueError):
        return True
    lowered = serialized.lower()
    return any(marker in lowered for marker in FORBIDDEN_MARKERS)


def alias_reason(reason: str | None) -> str | None:
    """Map a real reason code to a marker-free subagent alias."""
    if reason is None:
        return None
    if reason == "CHEAT_CANARY_READ" or reason.startswith("SANDBOX_VIOLATION:"):
        return "SAFETY_FAILURE"
    if reason.startswith("VARIANT_") or reason.startswith("MUTATION_"):
        return "QUALITY_ISSUE"
    if _contains_marker(reason):
        return "GRADER_REFUSED"
    return reason


def hint_for_alias(alias: str | None) -> str:
    if not alias:
        return ""
    if alias in _SAFE_HINTS:
        return _SAFE_HINTS[alias]
    hint = reasons.hint_for(alias)
    if _contains_marker(hint):
        return _SAFE_HINTS["GRADER_REFUSED"]
    return hint


def _safe_violations(violations: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    if not isinstance(violations, list):
        return result
    for violation in violations:
        if not isinstance(violation, dict):
            continue
        rule = violation.get("rule")
        hint = violation.get("hint")
        if not isinstance(rule, str) or not isinstance(hint, str):
            continue
        if _contains_marker(rule):
            result.append(
                {
                    "rule": "SAFETY_RULE",
                    "hint": "The test used a construct that is not allowed.",
                }
            )
        elif _contains_marker(hint):
            result.append({"rule": rule, "hint": "The test failed a static rule."})
        else:
            result.append({"rule": rule, "hint": hint})
    return result


def feedback(
    *,
    ok: bool,
    verdict: str | None,
    reason: str | None,
    flags: Iterable[str],
    attempt: int,
    closed: bool,
    counts: dict[str, Any] | None,
    budget: dict[str, Any],
    hint: str | None = None,
    violations: Any = None,
) -> dict[str, Any]:
    """Build the marker-free feedback object the broker forwards."""
    alias = alias_reason(reason)
    safe_flags = sorted({flag for flag in flags if not _contains_marker(flag)})
    safe_counts = counts if counts is not None and not _contains_marker(counts) else {}
    safe_budget = budget if not _contains_marker(budget) else {}
    payload = {
        "ok": bool(ok),
        "verdict": verdict if verdict and not _contains_marker(verdict) else None,
        "reason": alias,
        "flags": safe_flags,
        "attempt": int(attempt),
        "closed": bool(closed),
        "hint": hint if hint is not None else hint_for_alias(alias),
        "counts": safe_counts,
        "budget": safe_budget,
    }
    if violations is not None:
        payload["violations"] = _safe_violations(violations)
    if _contains_marker(payload):
        # Fail closed: never let an accidental marker reach the broker.
        return {
            "ok": bool(ok),
            "verdict": payload["verdict"],
            "reason": "GRADER_REFUSED",
            "flags": safe_flags,
            "attempt": int(attempt),
            "closed": bool(closed),
            "hint": _SAFE_HINTS["GRADER_REFUSED"],
            "counts": {},
            "budget": safe_budget,
            **({"violations": []} if violations is not None else {}),
        }
    return payload


def budget_feedback(state: dict[str, Any]) -> dict[str, int]:
    return {
        "used": int(state.get("attempts", 0)),
        "max": int(state.get("max_attempts", 0)),
    }


def validate_id(value: Any) -> str:
    try:
        return validate_job_id(value)
    except ValueError as exc:
        raise Refusal(JOB_INVALID, "The job identifier is not valid.") from exc


def validate_ref_value(value: Any) -> str:
    try:
        return validate_ref(value)
    except ValueError as exc:
        raise Refusal(JOB_INVALID, "The commit reference is not a 40-hex id.") from exc


def validate_relative_path(value: Any) -> str:
    try:
        return validate_rel_path(value)
    except ValueError as exc:
        raise Refusal(JOB_INVALID, "A relative path is not safe.") from exc

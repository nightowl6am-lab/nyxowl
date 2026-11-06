"""Validation for job metadata that crosses the broker boundary.

``validate_meta`` returns stable error tokens so the M3 gate can emit
``JOB_INVALID`` with a small, non-leaking reason set.  The function is pure: it
never writes, imports target code, or echoes untrusted values.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from .ids import validate_job_id, validate_ref, validate_rel_path
except ImportError:  # CLI/module execution from ``grader/``
    from ids import validate_job_id, validate_ref, validate_rel_path

BAD_ID = "BAD_ID"
BAD_REF = "BAD_REF"
SAME_REF = "SAME_REF"
BAD_MODULE = "BAD_MODULE"
BAD_FUNCTION = "BAD_FUNCTION"
BAD_PATH = "BAD_PATH"
BAD_SPEC = "BAD_SPEC"
BAD_FIX_ORIGIN = "BAD_FIX_ORIGIN"
BAD_BUDGET = "BAD_BUDGET"

ORDERED_TOKENS = (
    BAD_ID,
    BAD_REF,
    SAME_REF,
    BAD_MODULE,
    BAD_FUNCTION,
    BAD_PATH,
    BAD_SPEC,
    BAD_FIX_ORIGIN,
    BAD_BUDGET,
)

REQUIRED_HEADINGS = (
    "## Claim",
    "## Intended behavior",
    "## Rejection behavior",
    "## Entry point",
    "## Benign example",
    "## Detector",
)
BENIGN_PREFIX = "BENIGN:"

MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
FUNCTION_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

MAX_SPEC_CHARS = 20_000
MAX_SHORT_FIELD = 512
MAX_INTERFACE_CHARS = 4_000
MAX_PYTHON_PATH_ENTRIES = 16
MAX_ALLOWED_MODULES = 64
BENIGN_MAX_CHARS = 1_000
MAX_UNSAFE_RETURN_BYTES = 512

BUDGET_LIMITS = {
    "wall_seconds": (1, 1_800),
    "cpu_seconds": (1, 1_800),
    "memory_mb": (1, 4_096),
    "max_pids": (1, 4_096),
    "max_attempts": (1, 10),
}

ALLOWED_KEYS = {
    "id",
    "from_state",
    "to_state",
    "vulnerable_ref",
    "patched_ref",
    "module",
    "function",
    "fix_origin",
    "python_path",
    "allowed_modules",
    "interface",
    "helper_api",
    "detector",
    "budget",
    "expected_verdict",
    "expected_reason",
    "spec_markdown",
}


class JobMetaError(ValueError):
    """Raised by :func:`assert_valid_meta` with the stable token list."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("invalid job metadata: " + ", ".join(errors))


def _bounded_string(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum


def _add(errors: list[str], token: str) -> None:
    if token not in errors:
        errors.append(token)


def _valid_budget(budget: Any) -> bool:
    if not isinstance(budget, dict) or set(budget) != set(BUDGET_LIMITS):
        return False
    for key, (low, high) in BUDGET_LIMITS.items():
        value = budget.get(key)
        if isinstance(value, bool) or not isinstance(value, int):
            return False
        if not low <= value <= high:
            return False
    return True


def _validate_spec(spec: Any) -> bool:
    if not _bounded_string(spec, MAX_SPEC_CHARS):
        return False
    lines = [line.strip() for line in spec.splitlines()]
    for heading in REQUIRED_HEADINGS:
        if lines.count(heading) != 1:
            return False
    benign = [line for line in lines if line.startswith(BENIGN_PREFIX)]
    if len(benign) != 1:
        return False
    return len(benign[0]) <= BENIGN_MAX_CHARS


def validate_meta(meta: Any) -> list[str]:
    """Return stable error tokens for one job metadata object."""
    errors: list[str] = []
    if not isinstance(meta, dict):
        return [BAD_SPEC]

    if set(meta) - ALLOWED_KEYS:
        _add(errors, BAD_SPEC)

    try:
        validate_job_id(meta.get("id"))
    except ValueError:
        _add(errors, BAD_ID)

    vulnerable = meta.get("vulnerable_ref")
    patched = meta.get("patched_ref")
    try:
        validate_ref(vulnerable)
        validate_ref(patched)
    except ValueError:
        _add(errors, BAD_REF)
    else:
        if vulnerable == patched:
            _add(errors, SAME_REF)

    module = meta.get("module")
    if not isinstance(module, str) or MODULE_RE.fullmatch(module) is None:
        _add(errors, BAD_MODULE)

    function = meta.get("function")
    if not isinstance(function, str) or FUNCTION_RE.fullmatch(function) is None:
        _add(errors, BAD_FUNCTION)

    python_path = meta.get("python_path")
    if (
        not isinstance(python_path, list)
        or len(python_path) > MAX_PYTHON_PATH_ENTRIES
    ):
        _add(errors, BAD_PATH)
    else:
        for entry in python_path:
            try:
                validate_rel_path(entry)
            except ValueError:
                _add(errors, BAD_PATH)
                break
            if len(entry) > MAX_SHORT_FIELD:
                _add(errors, BAD_PATH)
                break

    if not _validate_spec(meta.get("spec_markdown")):
        _add(errors, BAD_SPEC)

    if meta.get("fix_origin") not in {"upstream", "reference"}:
        _add(errors, BAD_FIX_ORIGIN)

    if not _valid_budget(meta.get("budget")):
        _add(errors, BAD_BUDGET)

    allowed_modules = meta.get("allowed_modules")
    if allowed_modules is not None:
        if (
            not isinstance(allowed_modules, list)
            or not allowed_modules
            or len(allowed_modules) > MAX_ALLOWED_MODULES
            or not all(
                isinstance(item, str) and MODULE_RE.fullmatch(item) is not None
                for item in allowed_modules
            )
        ):
            _add(errors, BAD_MODULE)

    helper_api = meta.get("helper_api")
    if helper_api is not None:
        try:
            validate_rel_path(helper_api)
        except ValueError:
            _add(errors, BAD_PATH)
        else:
            if len(helper_api) > MAX_SHORT_FIELD:
                _add(errors, BAD_PATH)

    interface = meta.get("interface")
    if interface is not None and not _bounded_string(interface, MAX_INTERFACE_CHARS):
        _add(errors, BAD_SPEC)

    detector = meta.get("detector")
    if detector is not None:
        if (
            not isinstance(detector, dict)
            or not isinstance(detector.get("fixture"), str)
            or detector.get("fixture") != "detector"
            or not isinstance(detector.get("truthy_means"), str)
            or len(detector.get("truthy_means", "")) > MAX_SHORT_FIELD
        ):
            _add(errors, BAD_SPEC)
        elif "unsafe_return_contains" in detector:
            marker = detector.get("unsafe_return_contains")
            try:
                marker_bytes = (
                    marker.encode("utf-8", "surrogatepass")
                    if isinstance(marker, str)
                    else b""
                )
            except Exception:
                marker_bytes = b""
            if (
                not isinstance(marker, str)
                or not marker
                or "\x00" in marker
                or not marker_bytes
                or len(marker_bytes) > MAX_UNSAFE_RETURN_BYTES
            ):
                _add(errors, BAD_SPEC)

    for key in ("from_state", "to_state", "expected_verdict", "expected_reason"):
        value = meta.get(key)
        if value is not None and not _bounded_string(value, MAX_SHORT_FIELD):
            if key in {"from_state", "to_state"}:
                _add(errors, BAD_SPEC)
            elif key == "expected_verdict":
                _add(errors, BAD_SPEC)
            else:
                _add(errors, BAD_SPEC)

    return [token for token in ORDERED_TOKENS if token in errors]


def assert_valid_meta(meta: Any) -> None:
    """Raise :class:`JobMetaError` when ``meta`` has any stable error token."""
    errors = validate_meta(meta)
    if errors:
        raise JobMetaError(errors)

"""Validation helpers for IDs and paths that cross the grader boundary.

Every value in this module is treated as untrusted.  The functions are pure and
raise ``ValueError`` rather than attempting to repair bad input, so callers fail
closed instead of silently normalising a hostile value.
"""

from __future__ import annotations

import os
import re

JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_REF_RE = re.compile(r"^[0-9a-f]{40}$")
_DRIVE_RE = re.compile(r"^[A-Za-z]:")


def validate_job_id(value: str) -> str:
    """Return a job id unchanged when it matches the finite safe alphabet."""
    if not isinstance(value, str) or JOB_ID_RE.fullmatch(value) is None:
        raise ValueError("job id must be 1-40 characters from [A-Za-z0-9_-]")
    return value


def validate_ref(value: str) -> str:
    """Return a 40-character lowercase hex git ref, or raise."""
    if not isinstance(value, str) or _REF_RE.fullmatch(value) is None:
        raise ValueError("ref must be exactly 40 lowercase hexadecimal characters")
    return value


def validate_rel_path(value: str) -> str:
    """Return a relative POSIX path, rejecting traversal and platform escapes.

    Backslashes are rejected even on Linux: a path created on one platform must
    never acquire a different meaning after being carried to another.
    """
    if not isinstance(value, str):
        raise ValueError("path must be a string")
    if not value:
        raise ValueError("path must not be empty")
    if "\x00" in value:
        raise ValueError("path must not contain NUL")
    if "\\" in value:
        raise ValueError("path must use forward slashes only")
    if value.startswith("/") or os.path.isabs(value) or _DRIVE_RE.match(value):
        raise ValueError("path must be relative")
    parts = value.split("/")
    if any(part == ".." for part in parts):
        raise ValueError("path must not contain '..' segments")
    return value


def safe_join(base: str, rel: str) -> str:
    """Join ``rel`` under ``base`` after proving the result stays under base.

    ``realpath`` resolves symlinks on both sides, so a symlink inside ``base``
    cannot be used to escape it.  The returned string keeps the caller's original
    base spelling while the check uses canonical paths.
    """
    validate_rel_path(rel)
    base_str = os.fspath(base)
    base_real = os.path.realpath(base_str)
    target_real = os.path.realpath(os.path.join(base_real, rel))
    try:
        inside = os.path.commonpath([base_real, target_real]) == base_real
    except ValueError:
        inside = False
    if not inside:
        raise ValueError("resolved path escapes its base directory")
    return os.path.join(base_str, rel)

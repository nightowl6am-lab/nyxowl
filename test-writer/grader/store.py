"""Private on-disk store for Test-Writer jobs.

The store is deliberately small and stdlib-only.  It owns the directory layout,
atomic JSON writes, and a non-blocking per-job lock.  It never contains job
secrets: callers must not pass credentials, tokens, or canary values through
these helpers.

Layout::

    <TW_STORE_ROOT>/                  # default /var/lib/test-writer
        tmp/                          # 0700, sandbox scratch parent
        jobs/<id>/                    # 0700
            .lock                     # 0600
            state.json                # 0600
            meta.json                 # 0600

``<TW_WORKSPACE_ROOT>`` (default ``~/tw-jobs``) is separate: it holds the
owner/writer draft tree and is never assumed to be private to the grader user.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

try:
    from .ids import validate_job_id
except ImportError:  # CLI/module execution from ``grader/``
    from ids import validate_job_id

DEFAULT_STORE_ROOT = "/var/lib/test-writer"
DEFAULT_WORKSPACE_ROOT = "~/tw-jobs"

STATE_FILE = "state.json"
META_FILE = "meta.json"
LOCK_FILE = ".lock"

STATUSES = {"draft", "approved", "running", "closed"}
MAX_ATTEMPTS = 100


class StoreError(ValueError):
    """Raised when a store operation cannot be completed safely."""


class BusyError(StoreError):
    """Raised when a job lock is already held by another process."""

    def __init__(self, job_id: str) -> None:
        super().__init__(f"job {job_id} is busy")
        self.job_id = job_id


class JobLock:
    """An exclusive ``flock`` on one job directory."""

    def __init__(self, job_id: str, descriptor: int, path: Path) -> None:
        self.job_id = job_id
        self._descriptor: int | None = descriptor
        self.path = path

    def release(self) -> None:
        descriptor = self._descriptor
        if descriptor is None:
            return
        self._descriptor = None
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(descriptor)
        except OSError:
            pass

    def __enter__(self) -> "JobLock":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.release()

    def __del__(self) -> None:
        self.release()


def _store_root() -> Path:
    return Path(os.environ.get("TW_STORE_ROOT", DEFAULT_STORE_ROOT))


def _workspace_root() -> Path:
    return Path(os.environ.get("TW_WORKSPACE_ROOT", DEFAULT_WORKSPACE_ROOT)).expanduser()


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _ensure_private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


def _secure_file(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def tmp_dir() -> Path:
    """Return the private scratch root, creating it with mode 0700."""
    return _ensure_private_dir(_store_root() / "tmp")


def job_dir(job_id: str) -> Path:
    """Return ``<store>/jobs/<id>``, creating it with mode 0700."""
    identifier = validate_job_id(job_id)
    root = _ensure_private_dir(_store_root())
    _ensure_private_dir(root / "tmp")
    jobs = _ensure_private_dir(root / "jobs")
    return _ensure_private_dir(jobs / identifier)


def draft_dir(job_id: str) -> Path:
    """Return the writer-visible draft directory, creating it with mode 0700."""
    identifier = validate_job_id(job_id)
    root = _workspace_root()
    _ensure_private_dir(root)
    return _ensure_private_dir(root / identifier)


def read_json(path: str | os.PathLike[str]) -> Any:
    """Read one UTF-8 JSON document.  Raises ``OSError`` or ``ValueError``."""
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(path: str | os.PathLike[str], data: Any) -> None:
    """Write one JSON document with fsync + rename and mode 0600."""
    destination = Path(path)
    parent = _ensure_private_dir(destination.parent)
    try:
        encoded = json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise StoreError(f"value is not JSON serialisable: {exc}") from exc

    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=parent, text=True
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(encoded)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass


def acquire_job_lock(job_id: str) -> JobLock:
    """Acquire the non-blocking exclusive lock for ``job_id``.

    Raises :class:`BusyError` when another process already holds it.  The lock
    is released by ``release()`` or by using the returned object as a context
    manager.
    """
    directory = job_dir(job_id)
    path = directory / LOCK_FILE
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    _secure_file(path)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(descriptor)
        if exc.errno in {errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK}:
            raise BusyError(job_id) from exc
        raise StoreError(f"could not lock job {job_id}: {exc}") from exc
    return JobLock(job_id, descriptor, path)


def _validate_state(job_id: str, state: dict[str, Any]) -> dict[str, Any]:
    status = state.get("status")
    if status not in STATUSES:
        raise StoreError("state.status must be draft|approved|running|closed")

    verdict = state.get("verdict")
    if verdict is not None and not isinstance(verdict, str):
        raise StoreError("state.verdict must be null or a string")
    reason = state.get("reason")
    if reason is not None and not isinstance(reason, str):
        raise StoreError("state.reason must be null or a string")
    flags = state.get("flags", [])
    if not isinstance(flags, list) or not all(isinstance(item, str) for item in flags):
        raise StoreError("state.flags must be a list of strings")
    attempts = state.get("attempts", 0)
    max_attempts = state.get("max_attempts", 1)
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 0:
        raise StoreError("state.attempts must be a non-negative integer")
    if (
        isinstance(max_attempts, bool)
        or not isinstance(max_attempts, int)
        or not 1 <= max_attempts <= MAX_ATTEMPTS
    ):
        raise StoreError(f"state.max_attempts must be in [1, {MAX_ATTEMPTS}]")
    if attempts > max_attempts:
        raise StoreError("state.attempts must not exceed max_attempts")
    return state


def load_state(job_id: str) -> dict[str, Any] | None:
    """Return the stored state, or ``None`` when no state file exists."""
    path = job_dir(job_id) / STATE_FILE
    if not path.is_file():
        return None
    data = read_json(path)
    if not isinstance(data, dict):
        raise StoreError("state file is not a JSON object")
    return data


def write_state(job_id: str, state: dict[str, Any]) -> dict[str, Any]:
    """Validate and atomically persist one state document."""
    identifier = validate_job_id(job_id)
    if not isinstance(state, dict):
        raise StoreError("state must be an object")
    current = load_state(identifier) or {}
    created_at = state.get("created_at") or current.get("created_at") or _utc_now()
    if not isinstance(created_at, str):
        raise StoreError("state.created_at must be a string")
    flags = state.get("flags", [])
    if not isinstance(flags, list):
        raise StoreError("state.flags must be a list of strings")

    record = {
        "id": identifier,
        "status": state.get("status"),
        "verdict": state.get("verdict"),
        "reason": state.get("reason"),
        "flags": list(flags),
        "attempts": state.get("attempts", 0),
        "max_attempts": state.get("max_attempts", 1),
        "created_at": created_at,
        "updated_at": _utc_now(),
    }
    _validate_state(identifier, record)
    write_json_atomic(job_dir(identifier) / STATE_FILE, record)
    return record


def read_meta(job_id: str) -> dict[str, Any] | None:
    """Return ``meta.json`` for one job, or ``None`` when absent."""
    path = job_dir(job_id) / META_FILE
    if not path.is_file():
        return None
    data = read_json(path)
    if not isinstance(data, dict):
        raise StoreError("meta file is not a JSON object")
    return data


def write_meta(job_id: str, meta: dict[str, Any]) -> None:
    """Atomically persist one job metadata document."""
    identifier = validate_job_id(job_id)
    if not isinstance(meta, dict):
        raise StoreError("meta must be an object")
    write_json_atomic(job_dir(identifier) / META_FILE, meta)


def is_closed(job_id: str) -> bool:
    """Return True only when the job state exists and says ``closed``."""
    state = load_state(job_id)
    return bool(state is not None and state.get("status") == "closed")


def iter_states(*, statuses: set[str] | None = None) -> Iterator[dict[str, Any]]:
    """Yield stored states, optionally filtered by status (deterministic order)."""
    jobs = _store_root() / "jobs"
    if not jobs.is_dir():
        return
    for path in sorted(jobs.glob(f"*/{STATE_FILE}")):
        try:
            data = read_json(path)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        if statuses is None or data.get("status") in statuses:
            yield data

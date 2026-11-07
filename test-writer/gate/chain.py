"""Append-only, hash-linked evidence chain for one Test-Writer job.

``chain.log`` is JSON-lines.  Every entry commits to its predecessor::

    {"seq":N,"prev":"<hex>|null","kind":"proof"|"recheck",
     "payload":{...},"entryHash":"<hex>"}

``entryHash`` is ``sha256(canonical(entry minus entryHash))``.  A ``proof.json``
stores ``chain: {head, length}``: ``length`` is the number of entries it covers
and ``head`` is the ``entryHash`` of the last covered entry.  Recheck entries
extend the tail; the anchor never moves.  Deleting, editing, reordering, or
truncating below the anchor fails ``CHAIN_BROKEN``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from . import proof

CHAIN_FILE = "chain.log"
KINDS = frozenset({"proof", "recheck"})
_ENTRY_KEYS = frozenset({"seq", "prev", "kind", "payload", "entryHash"})
# Fail-closed bounds on the owner-controlled audit log.  The chain is small in
# normal use (one proof entry plus one per recheck), so these caps only reject
# a malformed or hostile tail and never a realistic replay history.
MAX_ENTRIES = 10_000
MAX_BYTES = 8 * 1024 * 1024


class ChainError(ValueError):
    """A chain file is missing, malformed, or does not match its anchor."""

    token = "CHAIN_BROKEN"
    file = CHAIN_FILE

    def __init__(self, message: str) -> None:
        super().__init__(message)


def chain_path(directory: str | Path) -> Path:
    return Path(directory) / CHAIN_FILE


def _body(entry: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in entry.items() if key != "entryHash"}


def entry_digest(entry_without_hash: dict[str, Any]) -> str:
    return proof.canonical_digest(entry_without_hash)


def read_entries(directory: str | Path) -> list[dict[str, Any]]:
    """Read and fully validate every entry, raising :class:`ChainError`."""
    path = chain_path(directory)
    if path.is_symlink():
        raise ChainError("chain.log is a symlink")
    if not path.is_file():
        raise ChainError("chain.log is missing")
    try:
        if path.stat().st_size > MAX_BYTES:
            raise ChainError("chain.log exceeds the size limit")
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ChainError("chain.log could not be read") from exc
    raw_lines = [line for line in text.splitlines() if line.strip()]
    if not raw_lines:
        raise ChainError("chain.log is empty")
    if len(raw_lines) > MAX_ENTRIES:
        raise ChainError("chain.log exceeds the entry limit")

    entries: list[dict[str, Any]] = []
    for index, line in enumerate(raw_lines):
        try:
            entry = json.loads(line)
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise ChainError("chain.log contains invalid JSON") from exc
        if not isinstance(entry, dict) or set(entry) != _ENTRY_KEYS:
            raise ChainError("chain.log entry has the wrong shape")
        seq = entry.get("seq")
        if isinstance(seq, bool) or not isinstance(seq, int) or seq != index:
            raise ChainError("chain.log sequence is not contiguous")
        prev = entry.get("prev")
        if index == 0:
            if prev is not None:
                raise ChainError("chain.log genesis prev is not null")
        elif prev != entries[-1]["entryHash"]:
            raise ChainError("chain.log prev link is broken")
        kind = entry.get("kind")
        if kind not in KINDS:
            raise ChainError("chain.log entry kind is not supported")
        if not isinstance(entry.get("payload"), dict):
            raise ChainError("chain.log payload is not an object")
        entry_hash = entry.get("entryHash")
        if not proof.is_sha256(entry_hash):
            raise ChainError("chain.log entry hash is not a sha256")
        if entry_digest(_body(entry)) != entry_hash:
            raise ChainError("chain.log entry hash does not recompute")
        entries.append(entry)
    return entries


def verify(
    directory: str | Path,
    anchor: Any = None,
) -> list[dict[str, Any]]:
    """Validate the chain and, when given, its ``{head,length}`` anchor."""
    entries = read_entries(directory)
    if anchor is None:
        return entries
    if not isinstance(anchor, dict):
        raise ChainError("proof chain anchor is not an object")
    head = anchor.get("head")
    length = anchor.get("length")
    if not proof.is_sha256(head):
        raise ChainError("proof chain head is not a sha256")
    if isinstance(length, bool) or not isinstance(length, int) or length < 1:
        raise ChainError("proof chain length is invalid")
    if length > len(entries):
        raise ChainError("chain.log is shorter than its anchor")
    if entries[length - 1]["entryHash"] != head:
        raise ChainError("chain.log anchor does not match")
    return entries


def append_entry(
    directory: str | Path,
    kind: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Append one linked entry and return it.  Never rewrites older entries."""
    if kind not in KINDS:
        raise ChainError("unsupported chain entry kind")
    if not isinstance(payload, dict):
        raise ChainError("chain payload must be an object")
    path = chain_path(directory)
    if path.is_symlink():
        raise ChainError("chain.log is a symlink")
    entries = read_entries(directory) if path.is_file() else []
    if len(entries) >= MAX_ENTRIES:
        raise ChainError("chain.log has reached the entry limit")
    seq = len(entries)
    prev = entries[-1]["entryHash"] if entries else None
    body = {"seq": seq, "prev": prev, "kind": kind, "payload": payload}
    entry = dict(body)
    entry["entryHash"] = entry_digest(body)
    encoded = proof.canonical(entry) + b"\n"
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
            0o600,
        )
    except OSError as exc:
        raise ChainError("chain.log could not be opened") from exc
    try:
        pending = encoded
        while pending:
            written = os.write(descriptor, pending)
            if written <= 0:
                raise ChainError("chain.log write made no progress")
            pending = pending[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return entry

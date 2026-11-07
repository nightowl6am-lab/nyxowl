"""Deterministic proof artifacts for a closed Test-Writer job.

M5 freezes the evidence for a terminal verdict: a canonical ``proof.json`` with
self-verifying hashes, an append-only ``chain.log`` (see :mod:`gate.chain`), and
an owner-facing ``REPORT.md``.  This module is stdlib-only and never includes
target source, proof-test source, variant/mutant source, raw sandbox output, or
a canary.  It hashes only the files that were actually executed.

Canonical JSON is the single serialization used for hashing:
``sort_keys=True``, ``ensure_ascii=True``, ``separators=(",", ":")``.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

PROOF_SCHEMA = "tw-proof/1"
PROOF_FILE = "proof.json"
REPORT_FILE = "REPORT.md"
RUNTIME_REPORT_FILE = "report.md"
TEST_FILE = "test.py"

# Frozen inputs are exactly the job's immutable bundle plus the staged proof
# test.  Optional variant tars and the staged test are hashed only when present.
FROZEN_FILES = (
    "manifest.json",
    "meta.json",
    "src-vulnerable.tar",
    "src-patched.tar",
    "src-still-vulnerable.tar",
    "src-fixed-differently.tar",
    TEST_FILE,
)

# The evidence seeds are fixed so a recheck can reproduce the gate exactly.
SEEDS = {"base": 0, "flake": [1, 2]}

_LIMIT_KEYS = (
    "wall_seconds",
    "cpu_seconds",
    "memory_mb",
    "max_pids",
    "max_attempts",
)
_GATE_KEYS = ("lint", "vulnerable", "patched", "flake", "variants", "mutation")
_HEX = frozenset("0123456789abcdef")


def canonical(value: Any) -> bytes:
    """Return the canonical UTF-8 JSON encoding used for every hash."""
    return json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("utf-8")


def canonical_digest(value: Any) -> str:
    """Return the SHA-256 hex digest of :func:`canonical`."""
    return hashlib.sha256(canonical(value)).hexdigest()


def file_sha256(path: str | Path) -> str:
    """Return the SHA-256 hex digest of a file's bytes."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in _HEX for character in value)
    )


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _iter_runtime_files(root: Path) -> Iterable[Path]:
    gate_dir = root / "gate"
    if gate_dir.is_dir():
        for path in sorted(gate_dir.glob("*.py")):
            if path.is_file() and "__pycache__" not in path.parts:
                yield path
    grader_dir = root / "grader"
    if grader_dir.is_dir():
        for path in sorted(grader_dir.rglob("*.py")):
            if path.is_file() and "__pycache__" not in path.parts:
                yield path
        pytest_ini = grader_dir / "harness" / "pytest.ini"
        if pytest_ini.is_file():
            yield pytest_ini
    bin_dir = root / "bin"
    if bin_dir.is_dir():
        for path in sorted(bin_dir.iterdir()):
            if path.is_file() and "__pycache__" not in path.parts:
                yield path


def collect_runtime_hashes(root: str | Path | None = None) -> dict[str, str]:
    """Hash the effective runtime files under ``root`` (default package root)."""
    if root is None:
        from . import common

        base = common.package_root()
    else:
        base = Path(root)
    hashes = {
        _relative(path.resolve(), base.resolve()): file_sha256(path)
        for path in _iter_runtime_files(base)
    }
    return {key: hashes[key] for key in sorted(hashes)}


def collect_frozen_hashes(directory: str | Path) -> dict[str, str]:
    """Hash the present frozen job inputs, keyed by relative name."""
    base = Path(directory)
    hashes: dict[str, str] = {}
    for name in sorted(FROZEN_FILES):
        path = base / name
        if path.is_file():
            hashes[name] = file_sha256(path)
    return hashes


def previous_proof_hash(directory: str | Path) -> str | None:
    """Return the existing ``proof.json`` digest, or ``None`` when absent."""
    path = Path(directory) / PROOF_FILE
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = data.get("proofHash") if isinstance(data, dict) else None
    return value if is_sha256(value) else None


def _mutation_summary(counts: dict[str, Any]) -> dict[str, Any]:
    block = counts.get("mutation")
    if not isinstance(block, dict):
        return {"killed": 0, "ran": 0, "score": None, "survivors": []}
    score = block.get("score")
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        score = None
    survivors = block.get("survivors")
    if not isinstance(survivors, list):
        survivors = []
    return {
        "killed": int(block.get("killed", 0)) if isinstance(block.get("killed"), int) else 0,
        "ran": int(block.get("ran", 0)) if isinstance(block.get("ran"), int) else 0,
        "score": float(score) if score is not None else None,
        "survivors": [str(item) for item in survivors],
    }


def build_body(
    *,
    job_id: str,
    verdict: str,
    reason: str | None,
    flags: list[str],
    attempt: int,
    gates: dict[str, Any],
    counts: dict[str, Any],
    runtime_hashes: dict[str, str],
    frozen_hashes: dict[str, str],
    versions: dict[str, Any],
    previous_proof_hash: str | None,
    created_at: str,
) -> dict[str, Any]:
    """Build the hashable proof body (no ``proofHash`` and no ``chain``)."""
    return {
        "schema": PROOF_SCHEMA,
        "jobId": job_id,
        "verdict": verdict,
        "reason": reason,
        "flags": list(flags),
        "attempt": int(attempt),
        "gates": dict(gates),
        "counts": counts,
        "mutations": _mutation_summary(counts),
        "seeds": {"base": SEEDS["base"], "flake": list(SEEDS["flake"])},
        "versions": {
            "proof_schema": PROOF_SCHEMA,
            "report_schema": versions.get("report_schema"),
            "bwrap": versions.get("bwrap"),
            "python": versions.get("python"),
        },
        "runtimeHashes": {key: runtime_hashes[key] for key in sorted(runtime_hashes)},
        "frozenInputHashes": {
            key: frozen_hashes[key] for key in sorted(frozen_hashes)
        },
        "previousProofHash": previous_proof_hash,
        "createdAt": created_at,
    }


def proof_hash(body: dict[str, Any]) -> str:
    """Return ``sha256(canonical(body))``."""
    return canonical_digest(body)


def finalize(
    body: dict[str, Any],
    *,
    chain_head: str,
    chain_length: int,
) -> dict[str, Any]:
    """Attach the proof hash and chain anchor to a body."""
    document = dict(body)
    document["chain"] = {"head": chain_head, "length": int(chain_length)}
    document["proofHash"] = proof_hash(body)
    return document


def build_proof(
    *,
    job_id: str,
    verdict: str,
    reason: str | None,
    flags: list[str],
    attempt: int,
    gates: dict[str, Any],
    counts: dict[str, Any],
    runtime_hashes: dict[str, str],
    frozen_hashes: dict[str, str],
    versions: dict[str, Any],
    previous_proof_hash: str | None,
    created_at: str,
    chain_head: str,
    chain_length: int,
) -> dict[str, Any]:
    """Build a complete proof document for tests and callers."""
    body = build_body(
        job_id=job_id,
        verdict=verdict,
        reason=reason,
        flags=flags,
        attempt=attempt,
        gates=gates,
        counts=counts,
        runtime_hashes=runtime_hashes,
        frozen_hashes=frozen_hashes,
        versions=versions,
        previous_proof_hash=previous_proof_hash,
        created_at=created_at,
    )
    return finalize(body, chain_head=chain_head, chain_length=chain_length)


def verify_self(document: Any) -> bool:
    """Recompute the proof body hash and validate the chain anchor shape."""
    if not isinstance(document, dict):
        return False
    if document.get("schema") != PROOF_SCHEMA:
        return False
    if not isinstance(document.get("jobId"), str) or not document["jobId"]:
        return False
    if not is_sha256(document.get("proofHash")):
        return False
    chain = document.get("chain")
    if not isinstance(chain, dict):
        return False
    if not is_sha256(chain.get("head")):
        return False
    length = chain.get("length")
    if isinstance(length, bool) or not isinstance(length, int) or length < 1:
        return False
    body = {
        key: value
        for key, value in document.items()
        if key not in {"proofHash", "chain"}
    }
    try:
        return canonical_digest(body) == document["proofHash"]
    except (TypeError, ValueError):
        return False


def verify_runtime(
    document: Any,
    root: str | Path | None = None,
) -> dict[str, Any]:
    """Compare the recorded runtime hashes with the effective runtime files."""
    expected = document.get("runtimeHashes") if isinstance(document, dict) else None
    if not isinstance(expected, dict):
        return {"ok": False, "file": PROOF_FILE, "kind": "runtime"}
    actual = collect_runtime_hashes(root)
    for key in sorted(set(expected) | set(actual)):
        if expected.get(key) != actual.get(key):
            return {"ok": False, "file": key, "kind": "runtime"}
    return {"ok": True, "file": None, "kind": "runtime"}


def verify_frozen(
    document: Any,
    directory: str | Path,
) -> dict[str, Any]:
    """Compare the recorded frozen-input hashes with the job directory."""
    expected = (
        document.get("frozenInputHashes") if isinstance(document, dict) else None
    )
    if not isinstance(expected, dict):
        return {"ok": False, "file": PROOF_FILE, "kind": "input"}
    actual = collect_frozen_hashes(directory)
    for key in sorted(set(expected) | set(actual)):
        if expected.get(key) != actual.get(key):
            return {"ok": False, "file": key, "kind": "input"}
    return {"ok": True, "file": None, "kind": "input"}


def limits_lines(budget: dict[str, Any]) -> list[str]:
    """Return the shared ``key: value`` limits block used by both reports."""
    lines: list[str] = []
    if not isinstance(budget, dict):
        return lines
    for key in _LIMIT_KEYS:
        if key in budget:
            lines.append(f"{key}: {budget[key]}")
    return lines


def _gate_lines(gates: dict[str, Any]) -> list[str]:
    return [f"| {key} | {gates.get(key)} |" for key in _GATE_KEYS]


def _hash_lines(hashes: dict[str, Any]) -> list[str]:
    if not hashes:
        return ["- none", ""]
    rows = ["| File | SHA-256 |", "| --- | --- |"]
    for key in sorted(hashes):
        rows.append(f"| {key} | {hashes[key]} |")
    return rows


def _provenance_lines(meta: dict[str, Any]) -> list[str]:
    variants = meta.get("variants")
    if not isinstance(variants, dict):
        variants = {}
    refs = [
        ("vulnerable ref", meta.get("vulnerable_ref")),
        ("patched ref", meta.get("patched_ref")),
        ("still-vulnerable ref", variants.get("still_vulnerable_ref")),
        ("fixed-differently ref", variants.get("fixed_differently_ref")),
        ("fix origin", meta.get("fix_origin")),
    ]
    lines = []
    for label, value in refs:
        lines.append(f"- {label}: {value if isinstance(value, str) else 'not recorded'}")
    return lines


def build_report_markdown(
    *,
    job_id: str,
    state: dict[str, Any],
    meta: dict[str, Any],
    document: dict[str, Any],
    budget: dict[str, Any],
) -> str:
    """Build the owner-facing ``REPORT.md`` without target or test source."""
    from grader import reasons

    verdict = document.get("verdict")
    reason = document.get("reason")
    flags = document.get("flags") or []
    attempt = document.get("attempt", 0)
    gates = document.get("gates")
    if not isinstance(gates, dict):
        gates = {}
    mutations = document.get("mutations")
    if not isinstance(mutations, dict):
        mutations = {"killed": 0, "ran": 0, "score": None, "survivors": []}
    score = mutations.get("score")
    score_text = f"{float(score):.3f}" if isinstance(score, (int, float)) else "not_run"
    survivors = mutations.get("survivors")
    survivors_text = (
        ", ".join(str(item) for item in survivors)
        if isinstance(survivors, list) and survivors
        else "none"
    )
    runtime_hashes = document.get("runtimeHashes")
    if not isinstance(runtime_hashes, dict):
        runtime_hashes = {}
    frozen_hashes = document.get("frozenInputHashes")
    if not isinstance(frozen_hashes, dict):
        frozen_hashes = {}
    flag_text = ", ".join(str(flag) for flag in flags) if flags else "none"

    lines = [
        f"# Test-Writer report: {job_id}",
        "",
        f"Status: {state.get('status')}",
        f"Verdict: {verdict}",
        f"Reason: {reason if reason else 'none'}",
        f"Flags: {flag_text}",
        f"Attempt: {int(attempt)} of {int(state.get('max_attempts', 1))}",
        "",
        "## Gates",
        "| Gate | Result |",
        "| --- | --- |",
    ]
    lines.extend(_gate_lines(gates))
    lines.extend(
        [
            "",
            "## Mutation",
            f"- killed: {int(mutations.get('killed', 0))}",
            f"- ran: {int(mutations.get('ran', 0))}",
            f"- score: {score_text}",
            f"- survivors: {survivors_text}",
            "",
            "## Provenance",
        ]
    )
    lines.extend(_provenance_lines(meta))
    lines.extend(
        [
            "",
            "## Runtime hashes",
        ]
    )
    lines.extend(_hash_lines(runtime_hashes))
    lines.extend(
        [
            "",
            "## Frozen input hashes",
        ]
    )
    lines.extend(_hash_lines(frozen_hashes))
    lines.extend(
        [
            "",
            "## Limits",
        ]
    )
    lines.extend(limits_lines(budget))
    lines.extend(
        [
            "",
            "## Explanation",
            reasons.hint_for(reason)
            if reason
            else "The proof test distinguished the vulnerable and patched snapshots.",
            "",
            "This report is derived from frozen commit snapshots and canonical",
            "hashes only. Target source, proof-test source, sandbox output, and",
            "protected values are not reproduced here.",
            "",
        ]
    )
    return "\n".join(lines)

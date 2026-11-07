"""Owner-side ``python -m gate.recheck <id>``: replay a closed proof.

Recheck is read-only except for one append to ``chain.log``.  It verifies the
proof self-hash, the effective runtime hashes, the frozen input hashes, the
append-only chain, and the stored state; then it re-runs the gate pipeline on
the staged ``test.py`` without writing state, reports, proof, or test, and
compares the recomputed evidence with the frozen proof.

Exit codes: ``0`` match, ``1`` mismatch or refusal, ``2`` usage.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from . import chain, common, proof as proof_module
from . import run as gate_run
from grader import job_check, store

_TERMINAL = "closed"
_EVIDENCE_FIELDS = (
    "verdict",
    "reason",
    "flags",
    "gates",
    "counts.vulnerable",
    "counts.patched",
    "counts.violations",
    "mutation.killed",
    "mutation.ran",
    "mutation.score",
    "mutation.survivors",
    "variants.still_vulnerable",
    "variants.fixed_differently",
    "flake.runs",
)
_UNSET = object()


def _job_directory(job_id: str) -> Path:
    return common.store_root() / "jobs" / job_id


def _block(counts: dict[str, Any], key: str) -> dict[str, Any]:
    value = counts.get(key)
    return value if isinstance(value, dict) else {}


def _int(block: dict[str, Any], key: str) -> int:
    value = block.get(key)
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0


def _score(block: dict[str, Any]) -> Any:
    value = block.get("score")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _survivors(block: dict[str, Any]) -> list[str]:
    value = block.get("survivors")
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


def _status(counts: dict[str, Any], key: str) -> str:
    value = _block(counts, "variants").get(key)
    return str(value) if isinstance(value, str) else "not_run"


def _evidence(
    verdict: Any,
    reason: Any,
    flags: Any,
    gates: Any,
    counts: Any,
) -> dict[str, Any]:
    safe_counts = counts if isinstance(counts, dict) else {}
    mutation = _block(safe_counts, "mutation")
    flake = _block(safe_counts, "flake")
    return {
        "verdict": verdict,
        "reason": reason,
        "flags": [str(item) for item in flags] if isinstance(flags, list) else [],
        "gates": dict(gates) if isinstance(gates, dict) else {},
        "counts.vulnerable": _block(safe_counts, "vulnerable"),
        "counts.patched": _block(safe_counts, "patched"),
        "counts.violations": safe_counts.get("violations"),
        "mutation.killed": _int(mutation, "killed"),
        "mutation.ran": _int(mutation, "ran"),
        "mutation.score": _score(mutation),
        "mutation.survivors": _survivors(mutation),
        "variants.still_vulnerable": _status(safe_counts, "still_vulnerable"),
        "variants.fixed_differently": _status(safe_counts, "fixed_differently"),
        "flake.runs": _int(flake, "runs"),
    }


def _proof_evidence(document: dict[str, Any]) -> dict[str, Any]:
    return _evidence(
        document.get("verdict"),
        document.get("reason"),
        document.get("flags"),
        document.get("gates"),
        document.get("counts"),
    )


def _decision_evidence(decision: dict[str, Any]) -> dict[str, Any]:
    return _evidence(
        decision.get("verdict"),
        decision.get("reason"),
        decision.get("flags"),
        decision.get("gates"),
        decision.get("counts"),
    )


def _state_mismatch(
    document: dict[str, Any],
    state: dict[str, Any],
    job_id: str,
) -> str | None:
    checks = (
        ("jobId", document.get("jobId"), job_id),
        ("verdict", document.get("verdict"), state.get("verdict")),
        ("reason", document.get("reason"), state.get("reason")),
        ("flags", document.get("flags"), state.get("flags")),
        ("attempt", document.get("attempt"), int(state.get("attempts", 0))),
    )
    for field, expected, actual in checks:
        if expected != actual:
            return field
    return None


def _emit(payload: dict[str, Any], code: int) -> int:
    common.emit_json(payload)
    return code


def _refuse(
    reason: str,
    *,
    file: str | None = None,
    kind: str | None = None,
    field: str | None = None,
    expected: Any = _UNSET,
    actual: Any = _UNSET,
) -> int:
    payload: dict[str, Any] = {"ok": False, "reason": reason}
    if file is not None:
        payload["file"] = file
    if kind is not None:
        payload["kind"] = kind
    if field is not None:
        payload["field"] = field
    if expected is not _UNSET:
        payload["expected"] = expected
    if actual is not _UNSET:
        payload["actual"] = actual
    return _emit(payload, 1)


def _append_recheck(directory: Path, payload: dict[str, Any]) -> bool:
    try:
        chain.append_entry(directory, "recheck", payload)
    except (chain.ChainError, OSError, ValueError):
        return False
    return True


def _compare(
    directory: Path,
    document: dict[str, Any],
    decision: dict[str, Any],
) -> int | None:
    """Return a mismatch result, or ``None`` when every evidence field matches."""
    expected = _proof_evidence(document)
    actual = _decision_evidence(decision)
    for field in _EVIDENCE_FIELDS:
        if expected[field] == actual[field]:
            continue
        _append_recheck(
            directory,
            {
                "proofHash": document["proofHash"],
                "result": "mismatch",
                "field": field,
            },
        )
        return _emit(
            {
                "ok": False,
                "result": "mismatch",
                "reason": "RECHECK_MISMATCH",
                "field": field,
                "expected": expected[field],
                "actual": actual[field],
            },
            1,
        )
    return None


def _recheck(job_id: str, directory: Path) -> int:
    try:
        state = common.read_state_readonly(job_id)
    except common.Refusal:
        return _refuse("JOB_INVALID", file="state.json")
    if state is None:
        return _refuse("JOB_INVALID", file="state.json")
    if state.get("status") != _TERMINAL:
        return _refuse("JOB_NOT_CLOSED", file="state.json")

    test_path = directory / proof_module.TEST_FILE
    if not test_path.is_file():
        return _refuse("NO_FROZEN_TEST", file=proof_module.TEST_FILE)

    proof_path = directory / proof_module.PROOF_FILE
    if not proof_path.is_file():
        return _refuse("PROOF_MISSING", file=proof_module.PROOF_FILE)
    try:
        document = json.loads(proof_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return _refuse("HASH_MISMATCH", file=proof_module.PROOF_FILE)
    if not proof_module.verify_self(document):
        return _refuse("HASH_MISMATCH", file=proof_module.PROOF_FILE)

    runtime = proof_module.verify_runtime(document)
    if not runtime["ok"]:
        return _refuse(
            "HASH_MISMATCH",
            file=runtime["file"] or proof_module.PROOF_FILE,
            kind="runtime",
        )

    frozen = proof_module.verify_frozen(document, directory)
    if not frozen["ok"]:
        return _refuse(
            "HASH_MISMATCH",
            file=frozen["file"] or proof_module.PROOF_FILE,
            kind="input",
        )

    anchor = document.get("chain")
    try:
        entries = chain.verify(directory, anchor)
    except chain.ChainError:
        return _refuse("CHAIN_BROKEN", file=chain.CHAIN_FILE)
    length = anchor["length"]
    anchored = entries[length - 1]
    payload = anchored.get("payload")
    if (
        anchored.get("kind") != "proof"
        or not isinstance(payload, dict)
        or payload.get("digest") != document["proofHash"]
    ):
        return _refuse("CHAIN_BROKEN", file=chain.CHAIN_FILE)

    mismatch_field = _state_mismatch(document, state, job_id)
    if mismatch_field is not None:
        return _refuse(
            "STATE_MISMATCH", file="state.json", field=mismatch_field
        )

    try:
        meta = common.read_meta_readonly(job_id)
    except common.Refusal:
        return _refuse("JOB_INVALID", file=common.META_FILE)
    if meta is None:
        return _refuse("JOB_INVALID", file=common.META_FILE)
    try:
        job_check.assert_valid_meta(meta)
    except job_check.JobMetaError:
        return _refuse("JOB_INVALID", file=common.META_FILE)

    try:
        source = test_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return _refuse("NO_FROZEN_TEST", file=proof_module.TEST_FILE)

    decision = gate_run.evaluate(job_id, meta, source, directory)
    mismatched = _compare(directory, document, decision)
    if mismatched is not None:
        return mismatched

    evidence = _proof_evidence(document)
    appended = _append_recheck(
        directory,
        {
            "proofHash": document["proofHash"],
            "verdict": document.get("verdict"),
            "reason": document.get("reason"),
            "attempt": document.get("attempt"),
            "evidenceHash": proof_module.canonical_digest(evidence),
        },
    )
    if not appended:
        return _refuse("CHAIN_BROKEN", file=chain.CHAIN_FILE)
    return _emit(
        {
            "ok": True,
            "result": "match",
            "verdict": document.get("verdict"),
            "reason": document.get("reason"),
            "attempt": document.get("attempt"),
            "proofHash": document["proofHash"],
        },
        0,
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        return _emit(
            {
                "ok": False,
                "reason": common.BAD_REQUEST,
                "message": "usage: python -m gate.recheck <id>",
            },
            2,
        )
    try:
        job_id = common.validate_id(args[0])
    except common.Refusal:
        return _refuse("JOB_INVALID", file="state.json")

    directory = _job_directory(job_id)
    try:
        state = common.read_state_readonly(job_id)
    except common.Refusal:
        return _refuse("JOB_INVALID", file="state.json")
    if state is None:
        return _refuse("JOB_INVALID", file="state.json")

    try:
        lock = store.acquire_job_lock(job_id)
    except store.BusyError:
        return _refuse(common.BUSY, file=store.LOCK_FILE)
    except (OSError, store.StoreError):
        return _refuse("JOB_INVALID", file=store.LOCK_FILE)
    with lock:
        return _recheck(job_id, directory)


if __name__ == "__main__":
    raise SystemExit(main())

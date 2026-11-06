"""Grader-side ``tw-gate <id>``: run gates 1-6 and close the job safely.

Gate 1 is static lint.  Gate 2 runs the proof test against the vulnerable
snapshot.  Gate 3 runs the same test against the patched snapshot, but only
after gate 2 produced a real assertion/pytest failure on the vulnerable
snapshot.  Gate 4 repeats both snapshots with two extra fixed hash seeds and
rejects inconsistent results as flaky.  Gate 5 runs the hidden still-vulnerable
and fixed-differently snapshots.  Gate 6 mutates the patched source with
AST-only operators and requires the test to distinguish them.  Detector
attribution is recorded as evidence, but the verdict rests on the observed
behaviour; there is no unsandboxed fallback and no raw grader output reaches
the caller.

Selector behaviour: ``--gate 1`` is lint only; ``--gate 2`` through ``--gate 6``
run the full pipeline (the number names the first gate that must be available).
Numbers above 6 are refused with ``GATE_UNAVAILABLE``.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import common
from grader import job_check, lint, mutate, package, reasons, sandbox_run, store

MAX_ATTEMPT_WALL_SECONDS = 1_800
MAX_MUTANTS = 8
MUTATION_SCORE_THRESHOLD = 0.8
# A real test failure is either a bare ``assert`` or ``pytest.fail()``.  Target
# exceptions (``ValueError``, ``OSError``, ...) stay setup errors: the proof
# test must observe the unsafe behaviour, not crash on it.
_REAL_FAILURE_TYPES = frozenset({"AssertionError", "Failed"})
_SAFE_KIND = re.compile(r"[^a-z0-9_]+")
_TERMINAL = "closed"
_SAFE_SETUP_KINDS = {
    "collection",
    "import",
    "wrong_exception",
    "timeout",
    "memory",
    "crash",
    "no_report",
    "no_tests",
    "skipped",
    "forbidden_fixture",
}


def _safe_kind(value: Any) -> str:
    text = _SAFE_KIND.sub("_", str(value or "internal").lower()).strip("_")
    return text or "internal"


def _load_job(job_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    state = common.read_state_readonly(job_id)
    if state is None:
        raise common.Refusal(common.JOB_INVALID, "The job was not found.")
    meta = common.read_meta_readonly(job_id)
    if meta is None:
        raise common.Refusal(common.JOB_INVALID, "The job metadata was not found.")
    try:
        job_check.assert_valid_meta(meta)
    except job_check.JobMetaError as exc:
        raise common.Refusal(common.JOB_INVALID, "The job metadata is invalid.") from exc
    if state.get("id") != job_id or meta.get("id") != job_id:
        raise common.Refusal(common.JOB_INVALID, "The job id does not match.")
    return state, meta


def _require_open(state: dict[str, Any]) -> None:
    status = state.get("status")
    if status == _TERMINAL:
        raise common.Refusal(common.JOB_CLOSED, "The job is closed.")
    if status not in {"approved", "running"}:
        raise common.Refusal(common.JOB_NOT_OPEN, "The job is not open.")


def _budget(meta: dict[str, Any]) -> dict[str, int]:
    raw = meta.get("budget")
    return dict(raw) if isinstance(raw, dict) else {}


def _sandbox_limits(meta: dict[str, Any]) -> dict[str, int]:
    budget = _budget(meta)
    return {
        key: int(budget[key])
        for key in ("wall_seconds", "cpu_seconds", "memory_mb", "max_pids")
        if key in budget
    }


def _violations(meta: dict[str, Any], source: str) -> list[dict[str, str]]:
    allowed = meta.get("allowed_modules")
    if not isinstance(allowed, list) or not allowed:
        allowed = [meta["module"]] if isinstance(meta.get("module"), str) else []
    return lint.lint_source(source, allowed_modules=allowed)


def _lint_feedback(state: dict[str, Any], violations: list[dict[str, str]]) -> dict[str, Any]:
    first = violations[0]["rule"] if violations else "SYNTAX"
    reason = f"LINT:{first}"
    return common.feedback(
        ok=False,
        verdict=None,
        reason=reason,
        flags=state.get("flags", []),
        attempt=int(state.get("attempts", 0)),
        closed=False,
        counts={"violations": len(violations)},
        budget=common.budget_feedback(state),
        violations=violations,
    )


def _run_on_snapshot(
    meta: dict[str, Any],
    source: str,
    snapshot: Path,
    canary: str,
    seed: int,
) -> dict[str, Any]:
    """Run ``source`` against one already-extracted snapshot directory."""
    temporary = Path(tempfile.mkdtemp(prefix="tw-gate-test-", dir=common.ensure_tmp_root()))
    try:
        test_file = temporary / "test.py"
        common.write_text_atomic(test_file, source, 0o600)
        detector = meta.get("detector")
        unsafe_return = None
        if isinstance(detector, dict):
            candidate = detector.get("unsafe_return_contains")
            if isinstance(candidate, str):
                unsafe_return = candidate
        return sandbox_run.run_test(
            snapshot_dir=snapshot,
            test_file=test_file,
            harness_dir=common.harness_dir(),
            module=meta["module"],
            function=meta["function"],
            limits=_sandbox_limits(meta),
            seed=seed,
            canary=canary,
            python_path=list(meta.get("python_path") or []),
            unsafe_return=unsafe_return,
        )
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def _run_snapshot(
    meta: dict[str, Any],
    source: str,
    snapshot_tar: Path,
    canary: str,
    seed: int = 0,
) -> dict[str, Any]:
    temporary = Path(tempfile.mkdtemp(prefix="tw-gate-run-", dir=common.ensure_tmp_root()))
    try:
        snapshot = temporary / "src"
        package.safe_extract(snapshot_tar, snapshot)
        return _run_on_snapshot(meta, source, snapshot, canary, seed)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def _run_counts(result: dict[str, Any]) -> dict[str, Any]:
    report = result.get("report")
    if not isinstance(report, dict):
        return {
            "outcome": None,
            "error": None,
            "report_error": result.get("report_error"),
            "limit_hit": result.get("limit_hit"),
            "detector_seen": False,
            "detector_attributed": False,
            "detector_calls": 0,
            "violations": 0,
            "failures": 0,
        }
    return {
        "outcome": report.get("outcome"),
        "error": report.get("error"),
        "report_error": None,
        "limit_hit": result.get("limit_hit"),
        "tests_collected": report.get("tests_collected", 0),
        "tests_run": report.get("tests_run", 0),
        # Detector state is evidence only; no gate reads these as a pass
        # condition.
        "detector_seen": bool(report.get("detector_seen")),
        "detector_attributed": bool(report.get("detector_attributed")),
        "detector_calls": report.get("detector_calls", 0),
        "violations": len(report.get("violations") or []),
        "failures": len(report.get("failures") or []),
    }


def _setup_reason(stage: str, kind: Any) -> str:
    text = str(kind or "internal")
    if text.startswith("wrong_exception:"):
        exception_type = text.split(":", 1)[1]
        if exception_type.isidentifier():
            return f"SETUP_ERROR_{stage}:wrong_exception:{exception_type}"
        return f"SETUP_ERROR_{stage}:wrong_exception"
    safe = _safe_kind(text)
    if safe not in _SAFE_SETUP_KINDS:
        # The reason vocabulary stays finite; unknown setup kinds collapse to
        # the closest stable token instead of forwarding free-form text.
        safe = "crash"
    return f"SETUP_ERROR_{stage}:{safe}"


def _limit_reason(stage: str, limit_hit: Any) -> str:
    mapping = {
        "wall": "timeout",
        "cpu": "timeout",
        "memory": "memory",
        "pids": "crash",
        "file_size": "crash",
        "output": "crash",
    }
    return _setup_reason(stage, mapping.get(str(limit_hit), "crash"))


def _classify_run(stage: str, result: dict[str, Any]) -> dict[str, Any]:
    """Reduce one sandbox result to a stable decision for ``stage``."""
    counts = _run_counts(result)
    if not result.get("ok"):
        kind = result.get("setup_error", "internal")
        return {
            "kind": "setup",
            "reason": _setup_reason(stage, kind),
            "verdict": "UNPROVEN",
            "flags": [],
            "counts": counts,
        }

    report = result.get("report")
    if not isinstance(report, dict):
        if result.get("timed_out"):
            reason = _limit_reason(stage, "wall")
        else:
            reason = _setup_reason(stage, "no_report")
        return {
            "kind": "setup",
            "reason": reason,
            "verdict": "UNPROVEN",
            "flags": [],
            "counts": counts,
        }

    if report.get("canary_read"):
        return {
            "kind": "safety",
            "reason": "CHEAT_CANARY_READ",
            "verdict": "UNPROVEN",
            "flags": ["CHEAT_ATTEMPT"],
            "counts": counts,
        }
    violations = report.get("violations") or []
    if violations:
        kind = _safe_kind(violations[0])
        return {
            "kind": "safety",
            "reason": f"SANDBOX_VIOLATION:{kind}",
            "verdict": "UNPROVEN",
            "flags": ["CHEAT_ATTEMPT"],
            "counts": counts,
        }
    if result.get("limit_hit"):
        return {
            "kind": "setup",
            "reason": _limit_reason(stage, result.get("limit_hit")),
            "verdict": "UNPROVEN",
            "flags": [],
            "counts": counts,
        }
    error = report.get("error")
    if error:
        return {
            "kind": "setup",
            "reason": _setup_reason(stage, error),
            "verdict": "UNPROVEN",
            "flags": [],
            "counts": counts,
        }

    outcome = report.get("outcome")
    if outcome == "passed":
        return {
            "kind": "passed",
            "reason": None,
            "verdict": None,
            "flags": [],
            "counts": counts,
        }
    return {
        "kind": "failed",
        "reason": None,
        "verdict": None,
        "flags": [],
        "counts": counts,
    }


def _real_failure(report: dict[str, Any] | None) -> bool:
    """True when the report failed on an assertion or ``pytest.fail()``."""
    if not isinstance(report, dict) or report.get("outcome") != "failed":
        return False
    for failure in report.get("failures") or []:
        if failure.get("type") in _REAL_FAILURE_TYPES:
            return True
    return False


def _failure_type(report: dict[str, Any] | None) -> str:
    if isinstance(report, dict):
        for failure in report.get("failures") or []:
            value = failure.get("type")
            if isinstance(value, str) and value.isidentifier():
                return value
    return "Exception"


def _effective_limits(result: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    effective = result.get("effective_limits")
    return effective if isinstance(effective, dict) else {}


def _versions(result: dict[str, Any] | None) -> dict[str, Any]:
    version = result.get("bwrap_version") if isinstance(result, dict) else None
    return {
        "report_schema": sandbox_run.REPORT_SCHEMA,
        "bwrap": version,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
    }


def _flags_for_reason(reason: str | None) -> list[str]:
    if reason == "CHEAT_CANARY_READ" or (
        isinstance(reason, str) and reason.startswith("SANDBOX_VIOLATION:")
    ):
        return ["CHEAT_ATTEMPT"]
    return []


def _observation(
    stage: str,
    decision: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    """Reduce one classified run to the pure flake observation shape."""
    counts = decision.get("counts") or {}
    if stage == "VULN" and decision["kind"] == "failed":
        report = result.get("report")
        if not _real_failure(report):
            failure = _failure_type(report)
            return {
                "kind": "setup",
                "reason": _setup_reason("VULN", f"wrong_exception:{failure}"),
                # Detector state is carried as evidence, never as a decision.
                "detector_seen": bool(counts.get("detector_seen")),
                "detector_attributed": bool(counts.get("detector_attributed")),
                "detector_calls": counts.get("detector_calls", 0),
            }
    return {
        "kind": decision["kind"],
        "reason": decision["reason"],
        "detector_seen": bool(counts.get("detector_seen")),
        "detector_attributed": bool(counts.get("detector_attributed")),
        "detector_calls": counts.get("detector_calls", 0),
    }


def _decide_flake(observations: Any) -> dict[str, Any]:
    """Two-seed flake decision based on behaviour, not detector globals.

    The shape mirrors ``grader.flake`` but deliberately omits its legacy
    detector-attribution condition: a real assertion/pytest failure is the
    evidence, and detector booleans are never a pass condition.
    """
    if not isinstance(observations, dict):
        return {"ok": False, "reason": "FLAKY"}

    runs: dict[str, list[dict[str, Any]]] = {}
    for stage in ("vulnerable", "patched"):
        items = observations.get(stage)
        if not isinstance(items, list) or len(items) != 2:
            return {"ok": False, "reason": "FLAKY"}
        if any(not isinstance(run, dict) for run in items):
            return {"ok": False, "reason": "FLAKY"}
        runs[stage] = items

    # Safety and setup observations keep their real reason instead of being
    # flattened into a flake label.
    for stage in ("vulnerable", "patched"):
        for run in runs[stage]:
            kind = run.get("kind")
            if kind == "safety":
                reason = run.get("reason")
                if isinstance(reason, str) and reason:
                    return {"ok": False, "reason": reason}
                return {"ok": False, "reason": "SAFETY_FAILURE"}
            if kind == "setup":
                reason = run.get("reason")
                if isinstance(reason, str) and reason:
                    return {"ok": False, "reason": reason}
                suffix = "VULN" if stage == "vulnerable" else "PATCHED"
                return {"ok": False, "reason": f"SETUP_ERROR_{suffix}:crash"}

    expected = observations.get("expected")
    if not isinstance(expected, dict):
        expected = {"vulnerable": "failed", "patched": "passed"}
    for stage in ("vulnerable", "patched"):
        want = expected.get(stage)
        for run in runs[stage]:
            if run.get("kind") != want:
                return {"ok": False, "reason": "FLAKY"}

    return {"ok": True, "reason": None}


def _run_flake(meta: dict[str, Any], source: str) -> dict[str, Any]:
    observations: dict[str, Any] = {
        "vulnerable": [],
        "patched": [],
        "expected": {"vulnerable": "failed", "patched": "passed"},
    }
    results: list[dict[str, Any]] = []
    for seed in (1, 2):
        for key, tar_name, stage in (
            ("vulnerable", common.VULNERABLE_TAR, "VULN"),
            ("patched", common.PATCHED_TAR, "PATCHED"),
        ):
            canary = secrets.token_urlsafe(32)
            result = _run_snapshot(
                meta,
                source,
                Path(store.job_dir(str(meta["id"]))) / tar_name,
                canary,
                seed=seed,
            )
            results.append(result)
            decision = _classify_run(stage, result)
            observations[key].append(_observation(stage, decision, result))
    return {
        "decision": _decide_flake(observations),
        "results": results,
        "counts": {"runs": len(results)},
    }


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _variant_outcome(
    job_id: str,
    meta: dict[str, Any],
    source: str,
) -> dict[str, Any]:
    variants = meta.get("variants")
    directory = store.job_dir(job_id)
    missing = (
        not isinstance(variants, dict)
        or any(
            not isinstance(variants.get(key), str)
            or not (directory / tar_name).is_file()
            for _kind, (tar_name, key) in common.VARIANT_KINDS.items()
        )
    )
    if missing:
        return {
            "ok": False,
            "reason": "VARIANT_MISSING",
            "flags": [],
            "gates": "fail",
            "counts": {"runs": 0},
            "results": [],
        }

    still_path = directory / common.STILL_VULNERABLE_TAR
    fixed_path = directory / common.FIXED_DIFFERENTLY_TAR
    counts: dict[str, Any] = {"runs": 0}
    if _file_digest(still_path) == _file_digest(fixed_path):
        return {
            "ok": False,
            "reason": "VARIANT_MISLABELED",
            "flags": ["VARIANT_MISLABELED"],
            "gates": "fail",
            "counts": counts,
            "results": [],
        }

    results: list[dict[str, Any]] = []

    still_result = _run_snapshot(
        meta,
        source,
        still_path,
        secrets.token_urlsafe(32),
        seed=0,
    )
    results.append(still_result)
    still_decision = _classify_run("VULN", still_result)
    counts["still_vulnerable"] = still_decision["kind"]
    counts["runs"] = 1

    if still_decision["kind"] in {"safety", "setup"}:
        reason = still_decision["reason"]
        return {
            "ok": False,
            "reason": reason,
            "flags": _flags_for_reason(reason),
            "gates": "fail",
            "counts": counts,
            "results": results,
        }
    if still_decision["kind"] != "failed" or not _real_failure(
        still_result.get("report")
    ):
        # A pass, or a target exception rather than an assertion, does not
        # show that the test actually exercises the unsafe behaviour.
        return {
            "ok": False,
            "reason": "VARIANT_TOO_WEAK",
            "flags": [],
            "gates": "fail",
            "counts": counts,
            "results": results,
        }

    fixed_result = _run_snapshot(
        meta,
        source,
        fixed_path,
        secrets.token_urlsafe(32),
        seed=0,
    )
    results.append(fixed_result)
    fixed_decision = _classify_run("PATCHED", fixed_result)
    counts["fixed_differently"] = fixed_decision["kind"]
    counts["runs"] = 2

    if fixed_decision["kind"] in {"safety", "setup"}:
        reason = fixed_decision["reason"]
        return {
            "ok": False,
            "reason": reason,
            "flags": _flags_for_reason(reason),
            "gates": "fail",
            "counts": counts,
            "results": results,
        }
    if fixed_decision["kind"] != "passed":
        return {
            "ok": False,
            "reason": "VARIANT_OVERFIT",
            "flags": [],
            "gates": "fail",
            "counts": counts,
            "results": results,
        }
    return {
        "ok": True,
        "reason": None,
        "flags": [],
        "gates": "pass",
        "counts": counts,
        "results": results,
    }


def _mutation_outcome(
    job_id: str,
    meta: dict[str, Any],
    source: str,
) -> dict[str, Any]:
    directory = store.job_dir(job_id)
    temporary = Path(tempfile.mkdtemp(prefix="tw-gate-mutate-", dir=common.ensure_tmp_root()))
    try:
        vulnerable = temporary / "vulnerable"
        patched = temporary / "patched"
        package.safe_extract(directory / common.VULNERABLE_TAR, vulnerable)
        package.safe_extract(directory / common.PATCHED_TAR, patched)
        mutants = mutate.generate_mutants(
            vulnerable,
            patched,
            python_path=list(meta.get("python_path") or []),
            seed=0,
            max_mutants=MAX_MUTANTS,
        )
        counts: dict[str, Any] = {
            "killed": 0,
            "ran": 0,
            "score": None,
            "survivors": [],
            "total": len(mutants),
            "invalid": 0,
        }
        if not mutants:
            return {
                "ok": True,
                "reason": None,
                "flags": [],
                "gates": "na",
                "counts": counts,
                "results": [],
            }

        results: list[dict[str, Any]] = []
        killed = 0
        ran = 0
        invalid = 0
        survivors: list[str] = []
        for index, mutant in enumerate(mutants):
            work = temporary / f"mutant-{index}"
            shutil.copytree(patched, work)
            relative = mutant["relative_path"]
            target = (work / relative).resolve()
            if work.resolve() not in target.parents:
                invalid += 1
                continue
            common.write_text_atomic(target, mutant["source"], 0o600)
            result = _run_on_snapshot(
                meta,
                source,
                work,
                secrets.token_urlsafe(32),
                seed=0,
            )
            results.append(result)
            decision = _classify_run("PATCHED", result)
            if decision["kind"] == "safety":
                reason = decision["reason"]
                counts.update(
                    {"killed": killed, "ran": ran, "invalid": invalid}
                )
                return {
                    "ok": False,
                    "reason": reason,
                    "flags": _flags_for_reason(reason),
                    "gates": "fail",
                    "counts": counts,
                    "results": results,
                }
            if decision["kind"] == "failed":
                killed += 1
                ran += 1
            elif decision["kind"] == "passed":
                ran += 1
                survivors.append(mutant["id"])
            else:
                invalid += 1

        score = mutate.score(killed, ran)
        counts.update(
            {
                "killed": killed,
                "ran": ran,
                "score": score,
                "survivors": sorted(survivors),
                "invalid": invalid,
            }
        )
        if score is None:
            return {
                "ok": True,
                "reason": None,
                "flags": [],
                "gates": "na",
                "counts": counts,
                "results": results,
            }
        if score < MUTATION_SCORE_THRESHOLD:
            return {
                "ok": False,
                "reason": "MUTATION_SCORE_LOW",
                "flags": [],
                "gates": "fail",
                "counts": counts,
                "results": results,
            }
        return {
            "ok": True,
            "reason": None,
            "flags": [],
            "gates": "pass",
            "counts": counts,
            "results": results,
        }
    except (OSError, ValueError, package.PackageError):
        return {
            "ok": False,
            "reason": "SETUP_ERROR_PATCHED:crash",
            "flags": [],
            "gates": "fail",
            "counts": {"killed": 0, "ran": 0, "score": None, "survivors": [], "total": 0, "invalid": 0},
            "results": [],
        }
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def _flake_count(gates: dict[str, Any], counts: dict[str, Any]) -> int:
    block = counts.get("flake")
    if isinstance(block, dict) and isinstance(block.get("runs"), int):
        return int(block["runs"])
    return 0


def _variant_block(counts: dict[str, Any]) -> dict[str, Any]:
    block = counts.get("variants")
    return block if isinstance(block, dict) else {}


def _variant_status(counts: dict[str, Any], key: str) -> str:
    value = _variant_block(counts).get(key)
    return str(value) if isinstance(value, str) else "not_run"


def _mutation_block(counts: dict[str, Any]) -> dict[str, Any]:
    block = counts.get("mutation")
    return block if isinstance(block, dict) else {}


def _mutation_count(counts: dict[str, Any], key: str) -> int:
    value = _mutation_block(counts).get(key)
    return int(value) if isinstance(value, int) else 0


def _mutation_score(counts: dict[str, Any]) -> str:
    value = _mutation_block(counts).get("score")
    if isinstance(value, (int, float)):
        return f"{float(value):.3f}"
    return "not_run"


def _survivors(counts: dict[str, Any]) -> str:
    value = _mutation_block(counts).get("survivors")
    if isinstance(value, list) and value:
        return ", ".join(str(item) for item in value)
    return "none"


def _report_markdown(
    job_id: str,
    state: dict[str, Any],
    meta: dict[str, Any],
    verdict: str,
    reason: str | None,
    flags: list[str],
    gates: dict[str, Any],
    counts: dict[str, Any],
) -> str:
    budget = _budget(meta)
    lines = [
        f"# Test-Writer report: {job_id}",
        "",
        f"Status: {state.get('status')}",
        f"Verdict: {verdict}",
        f"Reason: {reason if reason else 'none'}",
        f"Flags: {', '.join(flags) if flags else 'none'}",
        f"Attempt: {int(state.get('attempts', 0))} of {int(state.get('max_attempts', 1))}",
        "",
        "## Gates",
        f"- lint: {gates.get('lint')}",
        f"- vulnerable: {gates.get('vulnerable')}",
        f"- patched: {gates.get('patched')}",
        f"- flake: {gates.get('flake')}",
        f"- variants: {gates.get('variants')}",
        f"- mutation: {gates.get('mutation')}",
        "",
        "## Flake",
        f"- runs: {_flake_count(gates, counts)}",
        "",
        "## Variants",
        f"- still vulnerable: {_variant_status(counts, 'still_vulnerable')}",
        f"- fixed differently: {_variant_status(counts, 'fixed_differently')}",
        "",
        "## Mutation",
        f"- killed: {_mutation_count(counts, 'killed')}",
        f"- ran: {_mutation_count(counts, 'ran')}",
        f"- score: {_mutation_score(counts)}",
        f"- survivors: {_survivors(counts)}",
        "",
        "## Limits",
    ]
    for key in (
        "wall_seconds",
        "cpu_seconds",
        "memory_mb",
        "max_pids",
        "max_attempts",
    ):
        if key in budget:
            lines.append(f"{key}: {budget[key]}")
    lines.extend(
        [
            "",
            "## Explanation",
            reasons.hint_for(reason) if reason else "The proof test distinguished the vulnerable and patched snapshots.",
            "",
            "The result is evidence from frozen commit snapshots only; the target",
            "source, test output, and protected values are not reproduced here.",
            "",
        ]
    )
    return "\n".join(lines)


def _write_terminal(
    job_id: str,
    state: dict[str, Any],
    meta: dict[str, Any],
    verdict: str,
    reason: str | None,
    flags: list[str],
    gates: dict[str, Any],
    counts: dict[str, Any],
    results: list[dict[str, Any]],
) -> None:
    directory = store.job_dir(job_id)
    final_state = dict(state)
    final_state.update(
        {
            "status": _TERMINAL,
            "verdict": verdict,
            "reason": reason,
            "flags": list(flags),
        }
    )
    store.write_state(job_id, final_state)

    effective: dict[str, Any] = {}
    for result in reversed(results):
        candidate = _effective_limits(result)
        if candidate:
            effective = candidate
            break
    report = {
        "jobId": job_id,
        "verdict": verdict,
        "reason": reason,
        "flags": list(flags),
        "attempt": int(final_state.get("attempts", 0)),
        "closed": True,
        "gates": gates,
        "counts": counts,
        "limits": {
            "budget": _budget(meta),
            "effective": effective,
        },
        "versions": _versions(results[-1] if results else None),
        "created_at": common.utc_now(),
    }
    common.write_json_atomic(directory / "report.json", report, 0o600)
    common.write_text_atomic(
        directory / "report.md",
        _report_markdown(job_id, final_state, meta, verdict, reason, flags, gates, counts),
        0o600,
    )


def _terminal_feedback(
    state: dict[str, Any],
    verdict: str,
    reason: str | None,
    flags: list[str],
    counts: dict[str, Any],
) -> dict[str, Any]:
    safe_counts: dict[str, Any] = {
        "violations": int(counts.get("violations", 0))
    }
    mutation = counts.get("mutation")
    if isinstance(mutation, dict):
        for key in ("killed", "ran"):
            value = mutation.get(key)
            if isinstance(value, int):
                safe_counts[f"mutation_{key}"] = value
        value = mutation.get("score")
        if isinstance(value, (int, float)):
            safe_counts["mutation_score"] = float(value)
    return common.feedback(
        # ``ok`` is the subagent-facing success flag.  Only a PROVEN verdict is
        # a success; refusals and every other terminal verdict stay false while
        # the real verdict and reason remain in the payload.
        ok=verdict == "PROVEN",
        verdict=verdict,
        reason=reason,
        flags=flags,
        attempt=int(state.get("attempts", 0)),
        closed=True,
        counts=safe_counts,
        budget=common.budget_feedback(state),
    )


def _full_gate(job_id: str, state: dict[str, Any], meta: dict[str, Any], source: str) -> dict[str, Any]:
    violations = _violations(meta, source)
    gates: dict[str, Any] = {
        "lint": "fail" if violations else "pass",
        "vulnerable": "not_run",
        "patched": "not_run",
        "flake": "not_run",
        "variants": "not_run",
        "mutation": "not_run",
    }
    counts: dict[str, Any] = {"violations": len(violations)}
    if violations:
        # A lint failure is the only retryable, non-terminal outcome.
        state["status"] = "approved"
        state["verdict"] = None
        state["reason"] = None
        state["flags"] = []
        store.write_state(job_id, state)
        return _lint_feedback(state, violations)

    vulnerable_canary = secrets.token_urlsafe(32)
    vulnerable = _run_snapshot(meta, source, Path(store.job_dir(job_id)) / common.VULNERABLE_TAR, vulnerable_canary)
    vulnerable_decision = _classify_run("VULN", vulnerable)
    gates["vulnerable"] = vulnerable_decision["kind"]
    counts["vulnerable"] = vulnerable_decision["counts"]
    results = [vulnerable]

    if vulnerable_decision["kind"] in {"safety", "setup"}:
        reason = vulnerable_decision["reason"]
        verdict = vulnerable_decision["verdict"]
        flags = vulnerable_decision["flags"]
        _write_terminal(job_id, state, meta, verdict, reason, flags, gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, verdict, reason, flags, counts)

    report = vulnerable.get("report")
    if vulnerable_decision["kind"] == "passed":
        # The vulnerable snapshot passed, so the test observed nothing unsafe.
        # Detector state changes only the recorded evidence, never the verdict.
        reason = "NO_DETECTOR_HIT_ON_VULN"
        _write_terminal(job_id, state, meta, "UNPROVEN", reason, [], gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, "UNPROVEN", reason, [], counts)

    # Any real assertion or ``pytest.fail()`` on the vulnerable snapshot is
    # enough to spend the patched run.  Detector attribution is not required.
    if not _real_failure(report):
        failure = _failure_type(report)
        reason = _setup_reason("VULN", f"wrong_exception:{failure}")
        _write_terminal(job_id, state, meta, "UNPROVEN", reason, [], gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, "UNPROVEN", reason, [], counts)

    patched_canary = secrets.token_urlsafe(32)
    patched = _run_snapshot(meta, source, Path(store.job_dir(job_id)) / common.PATCHED_TAR, patched_canary, seed=0)
    patched_decision = _classify_run("PATCHED", patched)
    gates["patched"] = patched_decision["kind"]
    counts["patched"] = patched_decision["counts"]
    results.append(patched)

    if patched_decision["kind"] in {"safety", "setup"}:
        verdict = patched_decision["verdict"]
        reason = patched_decision["reason"]
        flags = patched_decision["flags"]
        _write_terminal(job_id, state, meta, verdict, reason, flags, gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, verdict, reason, flags, counts)

    if patched_decision["kind"] != "passed":
        patched_report = patched.get("report")
        if isinstance(patched_report, dict) and patched_report.get("detector_seen"):
            reason = "PATCHED_STILL_LEAKS"
        else:
            reason = "FAIL_ON_PATCHED"
        _write_terminal(job_id, state, meta, "REFUTED", reason, [], gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, "REFUTED", reason, [], counts)

    # Gate 4: two extra fixed hash seeds must reproduce the seed-0 result.
    flake_result = _run_flake(meta, source)
    gates["flake"] = "pass" if flake_result["decision"]["ok"] else "fail"
    counts["flake"] = flake_result["counts"]
    results.extend(flake_result["results"])
    if not flake_result["decision"]["ok"]:
        reason = flake_result["decision"]["reason"] or "FLAKY"
        flags = _flags_for_reason(reason)
        _write_terminal(job_id, state, meta, "UNPROVEN", reason, flags, gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, "UNPROVEN", reason, flags, counts)

    # Gate 5: the hidden still-vulnerable and fixed-differently variants.
    variant_result = _variant_outcome(job_id, meta, source)
    gates["variants"] = variant_result["gates"]
    counts["variants"] = variant_result["counts"]
    results.extend(variant_result["results"])
    if not variant_result["ok"]:
        reason = variant_result["reason"]
        flags = variant_result["flags"]
        _write_terminal(job_id, state, meta, "UNPROVEN", reason, flags, gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, "UNPROVEN", reason, flags, counts)

    # Gate 6: AST-only mutants of the patched source, scored over runs.
    mutation_result = _mutation_outcome(job_id, meta, source)
    gates["mutation"] = mutation_result["gates"]
    counts["mutation"] = mutation_result["counts"]
    results.extend(mutation_result["results"])
    if not mutation_result["ok"]:
        reason = mutation_result["reason"]
        flags = mutation_result["flags"]
        _write_terminal(job_id, state, meta, "UNPROVEN", reason, flags, gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, "UNPROVEN", reason, flags, counts)

    _write_terminal(job_id, state, meta, "PROVEN", None, [], gates, counts, results)
    closed = store.load_state(job_id) or state
    return _terminal_feedback(closed, "PROVEN", None, [], counts)


def _finish(job_id: str, state: dict[str, Any], meta: dict[str, Any], payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise common.Refusal(common.JOB_INVALID, "The finish payload must be an object.")
    notes = payload.get("notes")
    flags = payload.get("flags")
    if not isinstance(notes, str):
        raise common.Refusal(common.JOB_INVALID, "notes must be a string.")
    if len(notes.encode("utf-8", "surrogatepass")) > 4096:
        raise common.Refusal(common.JOB_INVALID, "notes are too large.")
    if not isinstance(flags, list) or any(
        flag not in {"INJECTION_SUSPECTED", "SPEC_INSUFFICIENT"} for flag in flags
    ):
        raise common.Refusal(common.JOB_INVALID, "flags contain an unsupported value.")

    directory = store.job_dir(job_id)
    common.write_text_atomic(
        directory / "notes.md",
        notes if notes.endswith("\n") else notes + "\n",
        0o600,
    )

    already_closed = state.get("status") == _TERMINAL
    if already_closed:
        verdict = state.get("verdict")
        reason = state.get("reason")
        final_flags = [flag for flag in state.get("flags", []) if isinstance(flag, str)]
        if not isinstance(verdict, str):
            verdict = None
        if not isinstance(reason, str):
            reason = None
    else:
        verdict = "UNPROVEN"
        reason = "GAVE_UP"
        final_flags = list(flags)
        gates = {"lint": "not_run", "vulnerable": "not_run", "patched": "not_run", "flake": "not_run", "variants": "not_run", "mutation": "not_run"}
        counts = {"violations": 0}
        _write_terminal(
            job_id, state, meta, verdict, reason, final_flags, gates, counts, []
        )
        state = store.load_state(job_id) or state

    return common.feedback(
        # A finish call is successful only when the recorded job is PROVEN.
        # GAVE_UP and other terminal outcomes keep ``ok`` false.
        ok=verdict == "PROVEN",
        verdict=verdict,
        reason=reason,
        flags=final_flags,
        attempt=int(state.get("attempts", 0)),
        closed=True,
        counts={"violations": 0},
        budget=common.budget_feedback(state),
    )


def _parse_mode(args: list[str]) -> tuple[str, int | None]:
    if not args:
        return "full", None
    if args == ["--lint-only"]:
        return "lint", None
    if args == ["--finish"]:
        return "finish", None
    if len(args) == 2 and args[0] == "--gate":
        try:
            number = int(args[1])
        except ValueError as exc:
            raise common.ProtocolError("--gate requires an integer.") from exc
        if number not in {1, 2, 3, 4, 5, 6}:
            raise common.Refusal(
                common.GATE_UNAVAILABLE, "Only gates 1-6 are available."
            )
        if number == 1:
            return "lint", 1
        # Gate numbers 2-6 select the full pipeline; the number records which
        # gate the caller expects to be available.  Lint is always gate 1.
        return "full", number
    raise common.ProtocolError("usage: tw-gate <id> [--lint-only|--finish|--gate N]")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        common.emit_json(
            common.refusal_payload(
                common.ProtocolError("usage: tw-gate <id> [--lint-only|--finish|--gate N]")
            )
        )
        return 2
    job_id = args[0]
    try:
        job_id = common.validate_id(job_id)
        mode, _gate_number = _parse_mode(args[1:])
        state, meta = _load_job(job_id)
        if mode == "lint":
            _require_open(state)
            source = common.read_stdin_text(common.MAX_TEST_BYTES + 1)
            if len(source.encode("utf-8", "surrogatepass")) > common.MAX_TEST_BYTES:
                source = " " * (common.MAX_TEST_BYTES + 1)
            violations = _violations(meta, source)
            common.emit_json(
                {
                    "ok": not violations,
                    "violations": violations,
                    "counts": {"violations": len(violations)},
                }
            )
            return 0
        if mode == "finish":
            payload = common.read_stdin_json(common.MAX_FINISH_BYTES)
            if state.get("status") == _TERMINAL:
                result = _finish(job_id, state, meta, payload)
            else:
                _require_open(state)
                try:
                    lock = store.acquire_job_lock(job_id)
                except store.BusyError as exc:
                    raise common.Refusal(common.BUSY, "The job is busy.") from exc
                with lock:
                    state, meta = _load_job(job_id)
                    if state.get("status") == _TERMINAL:
                        result = _finish(job_id, state, meta, payload)
                    else:
                        _require_open(state)
                        result = _finish(job_id, state, meta, payload)
            common.emit_json(result)
            return 0

        _require_open(state)
        try:
            lock = store.acquire_job_lock(job_id)
        except store.BusyError as exc:
            raise common.Refusal(common.BUSY, "The job is busy.") from exc
        with lock:
            state, meta = _load_job(job_id)
            _require_open(state)
            attempts = int(state.get("attempts", 0))
            max_attempts = int(state.get("max_attempts", 1))
            if attempts >= max_attempts:
                gates = {"lint": "not_run", "vulnerable": "not_run", "patched": "not_run", "flake": "not_run", "variants": "not_run", "mutation": "not_run"}
                _write_terminal(
                    job_id,
                    state,
                    meta,
                    "UNPROVEN",
                    "BUDGET_EXHAUSTED",
                    [],
                    gates,
                    {"violations": 0},
                    [],
                )
                closed = store.load_state(job_id) or state
                common.emit_json(
                    {
                        "ok": False,
                        "reason": "BUDGET_EXHAUSTED",
                        "message": "The job has used every attempt.",
                        "verdict": "UNPROVEN",
                        "flags": [],
                        "attempt": int(closed.get("attempts", attempts)),
                        "closed": True,
                        "counts": {"violations": 0},
                        "budget": common.budget_feedback(closed),
                    }
                )
                return 0
            source = common.read_stdin_text(common.MAX_TEST_BYTES + 1)
            if len(source.encode("utf-8", "surrogatepass")) > common.MAX_TEST_BYTES:
                source = " " * (common.MAX_TEST_BYTES + 1)
            state["attempts"] = attempts + 1
            state["status"] = "running"
            state["verdict"] = None
            state["reason"] = None
            store.write_state(job_id, state)
            result = _full_gate(job_id, state, meta, source)
        common.emit_json(result)
        return 0
    except common.Refusal as exc:
        common.emit_json(common.refusal_payload(exc))
        return exc.exit_code
    except (OSError, ValueError):
        refusal = common.Refusal(common.JOB_INVALID, "The gate could not complete.")
        common.emit_json(common.refusal_payload(refusal))
        return refusal.exit_code


if __name__ == "__main__":
    raise SystemExit(main())

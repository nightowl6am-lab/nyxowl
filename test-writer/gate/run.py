"""Grader-side ``tw-gate <id>``: run gates 1-3 and close the job safely.

Gate 1 is static lint.  Gate 2 runs the proof test against the vulnerable
snapshot.  Gate 3 runs the same test against the patched snapshot, but only
after gates 1 and 2 produced an attributed failure on the vulnerable snapshot.
There is no unsandboxed fallback and no raw grader output reaches the caller.
"""

from __future__ import annotations

import os
import re
import secrets
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import common
from grader import job_check, lint, package, reasons, sandbox_run, store

MAX_ATTEMPT_WALL_SECONDS = 1_800
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


def _run_snapshot(
    meta: dict[str, Any],
    source: str,
    snapshot_tar: Path,
    canary: str,
) -> dict[str, Any]:
    temporary = Path(tempfile.mkdtemp(prefix="tw-gate-run-", dir=common.ensure_tmp_root()))
    try:
        snapshot = temporary / "src"
        package.safe_extract(snapshot_tar, snapshot)
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
            seed=secrets.randbits(32),
            canary=canary,
            python_path=list(meta.get("python_path") or []),
            unsafe_return=unsafe_return,
        )
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
        "detector_seen": bool(report.get("detector_seen")),
        "detector_attributed": bool(report.get("detector_attributed")),
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


def _assertion_failure(report: dict[str, Any] | None) -> bool:
    if not isinstance(report, dict):
        return False
    for failure in report.get("failures") or []:
        if failure.get("type") == "AssertionError":
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


def _report_markdown(
    job_id: str,
    state: dict[str, Any],
    meta: dict[str, Any],
    verdict: str,
    reason: str | None,
    flags: list[str],
    gates: dict[str, Any],
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
        _report_markdown(job_id, final_state, meta, verdict, reason, flags, gates),
        0o600,
    )


def _terminal_feedback(
    state: dict[str, Any],
    verdict: str,
    reason: str | None,
    flags: list[str],
    counts: dict[str, Any],
) -> dict[str, Any]:
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
        counts={"violations": int(counts.get("violations", 0))},
        budget=common.budget_feedback(state),
    )


def _full_gate(job_id: str, state: dict[str, Any], meta: dict[str, Any], source: str) -> dict[str, Any]:
    violations = _violations(meta, source)
    gates: dict[str, Any] = {
        "lint": "fail" if violations else "pass",
        "vulnerable": "not_run",
        "patched": "not_run",
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
        if isinstance(report, dict) and report.get("detector_seen") and report.get("detector_attributed"):
            reason = "NO_FAIL_ON_VULN"
            verdict = "REFUTED"
        else:
            reason = "NO_DETECTOR_HIT_ON_VULN"
            verdict = "UNPROVEN"
        _write_terminal(job_id, state, meta, verdict, reason, [], gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, verdict, reason, [], counts)

    # Failed on the vulnerable snapshot: only an attributed AssertionError
    # justifies spending the patched snapshot run.
    if not (isinstance(report, dict) and report.get("detector_seen") and report.get("detector_attributed")):
        reason = "NO_DETECTOR_HIT_ON_VULN"
        _write_terminal(job_id, state, meta, "UNPROVEN", reason, [], gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, "UNPROVEN", reason, [], counts)

    if not _assertion_failure(report):
        failure = _failure_type(report)
        reason = _setup_reason("VULN", f"wrong_exception:{failure}")
        _write_terminal(job_id, state, meta, "UNPROVEN", reason, [], gates, counts, results)
        closed = store.load_state(job_id) or state
        return _terminal_feedback(closed, "UNPROVEN", reason, [], counts)

    patched_canary = secrets.token_urlsafe(32)
    patched = _run_snapshot(meta, source, Path(store.job_dir(job_id)) / common.PATCHED_TAR, patched_canary)
    patched_decision = _classify_run("PATCHED", patched)
    gates["patched"] = patched_decision["kind"]
    counts["patched"] = patched_decision["counts"]
    results.append(patched)

    if patched_decision["kind"] in {"safety", "setup"}:
        verdict = patched_decision["verdict"]
        reason = patched_decision["reason"]
        flags = patched_decision["flags"]
    elif patched_decision["kind"] == "passed":
        verdict = "PROVEN"
        reason = None
        flags = []
    else:
        patched_report = patched.get("report")
        if isinstance(patched_report, dict) and patched_report.get("detector_seen"):
            reason = "PATCHED_STILL_LEAKS"
            verdict = "REFUTED"
        else:
            reason = "FAIL_ON_PATCHED"
            verdict = "REFUTED"
        flags = []

    _write_terminal(job_id, state, meta, verdict, reason, flags, gates, counts, results)
    closed = store.load_state(job_id) or state
    return _terminal_feedback(closed, verdict, reason, flags, counts)


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
        gates = {"lint": "not_run", "vulnerable": "not_run", "patched": "not_run"}
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
        if number not in {1, 2, 3}:
            raise common.Refusal(
                common.GATE_UNAVAILABLE, "Only gates 1-3 are available."
            )
        if number == 1:
            return "lint", 1
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
                gates = {"lint": "not_run", "vulnerable": "not_run", "patched": "not_run"}
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

"""Grader-side ``tw-status <id>``: read-only job status and owner report.

The subagent-facing ``--inputs`` response is available only while a job is
approved or running.  Closed and missing jobs return just their status so the
broker marks them non-applicable.  ``--report`` returns the owner-facing
markdown; neither path exposes test source, sandbox output, or protected values.
"""

from __future__ import annotations

import sys
from typing import Any

from . import common
from grader import job_check


def _plain(job_id: str) -> dict[str, Any]:
    state = common.read_state_readonly(job_id)
    if state is None:
        return {
            "jobId": job_id,
            "status": "missing",
            "verdict": None,
            "reason": None,
            "flags": [],
            "attemptsUsed": 0,
            "budget": {"used": 0, "max": 0},
        }
    status = state.get("status")
    if not isinstance(status, str):
        status = "missing"
    flags = state.get("flags")
    if not isinstance(flags, list):
        flags = []
    verdict = state.get("verdict")
    reason = state.get("reason")
    attempts = state.get("attempts", 0)
    maximum = state.get("max_attempts", 1)
    if not isinstance(attempts, int) or isinstance(attempts, bool):
        attempts = 0
    if not isinstance(maximum, int) or isinstance(maximum, bool):
        maximum = 0
    return {
        "jobId": job_id,
        "status": status,
        "verdict": verdict if isinstance(verdict, str) else None,
        "reason": reason if isinstance(reason, str) else None,
        "flags": [flag for flag in flags if isinstance(flag, str)],
        "attemptsUsed": attempts,
        "budget": {"used": attempts, "max": maximum},
    }


def _inputs(job_id: str) -> dict[str, Any]:
    state = common.read_state_readonly(job_id)
    if state is None:
        return {"status": "missing"}
    status = state.get("status")
    if not isinstance(status, str):
        status = "missing"
    if status not in {"approved", "running"}:
        return {"status": status}

    meta = common.read_meta_readonly(job_id)
    if meta is None:
        return {"status": status}
    try:
        job_check.assert_valid_meta(meta)
    except job_check.JobMetaError:
        return {"status": status}

    try:
        helper_api = common.helper_api_text()
    except common.Refusal:
        helper_api = ""

    budget = meta.get("budget")
    if not isinstance(budget, dict):
        budget = {}
    detector = meta.get("detector")
    if detector is None:
        detector = {}
    return {
        "status": status,
        "targetStack": "python",
        "spec": meta.get("spec_markdown", ""),
        "interface": meta.get("interface", ""),
        "detector": detector,
        "helperApi": helper_api,
        "budget": budget,
    }


def _report(job_id: str) -> str:
    path = common.store_root() / "jobs" / job_id / "report.md"
    try:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    except OSError:
        pass
    return "no report yet\n"


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if not args:
            raise common.ProtocolError("usage: tw-status <id> [--inputs|--report]")
        job_id = common.validate_id(args[0])
        options = args[1:]
        if not options:
            common.emit_json(_plain(job_id))
            return 0
        if options == ["--inputs"]:
            common.emit_json(_inputs(job_id))
            return 0
        if options == ["--report"]:
            sys.stdout.write(_report(job_id))
            sys.stdout.flush()
            return 0
        raise common.ProtocolError("usage: tw-status <id> [--inputs|--report]")
    except common.Refusal as exc:
        common.emit_json(common.refusal_payload(exc))
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())

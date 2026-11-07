#!/usr/bin/env python3
"""Model-free M7-lite evaluation matrix for the Test-Writer slice.

The runner builds the deterministic fixture repository once, installs the
worktree runtime once into a temporary install root, and then runs every M7-lite
case through ``tw-new-job`` -> ``tw-approve`` -> ``tw-gate``.  Case refs are
resolved by state name from the builder's ``--print-refs`` output, so no state
hash is hardcoded here.  Every ``PROVEN`` job is rechecked with ``tw-recheck``.

The matrix must never return a false ``PROVEN`` and must never miss an expected
``PROVEN``.  Missing ``/usr/bin/bwrap`` or a runtime venv with pytest and
hypothesis prints ``M7_LITE_EVAL: SKIP`` and exits 2.  No network, remote
service, secret, or production root is used.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
TW_ROOT = HERE.parent
CASES_DIR = HERE / "m7_cases"
BUILDER = TW_ROOT / "fixtures" / "build_fixtures.py"
INSTALLER = TW_ROOT / "bootstrap" / "install-user.sh"
BWRAP = Path("/usr/bin/bwrap")
DEFAULT_VENV = Path.home() / ".nyxowl" / "test-writer" / "venv" / "bin" / "python"
DEFAULT_OUT = Path("/tmp/opencode/m7-lite-eval")
CASE_IDS = ("c1", "c2", "c3", "c4", "c5", "n1", "n2")
CASE_META_KEYS = {
    "alias",
    "variant_states",
    "expected_verdict",
    "expected_reason",
}
GATE_TIMEOUT = 1_800
REF_RE = re.compile(r"^[0-9a-f]{40}$")


def _venv_python() -> Path:
    raw = os.getenv("TW_VENV_PYTHON")
    return Path(raw) if raw else DEFAULT_VENV


def _environment(
    install: Path, store: Path, tmp: Path, workspace: Path, venv: Path
) -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "TW_INSTALL_ROOT": str(install),
            "TW_STORE_ROOT": str(store),
            "TW_TMP_ROOT": str(tmp),
            "TW_WORKSPACE_ROOT": str(workspace),
            "TW_VENV_PYTHON": str(venv),
            "PYTHONPATH": str(install),
        }
    )
    return env


def _run(
    install: Path,
    name: str,
    args: list[str],
    env: dict[str, str],
    payload: bytes | None = None,
    timeout: int = GATE_TIMEOUT,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [str(install / "bin" / name), *args],
        input=payload,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def _json(completed: subprocess.CompletedProcess[bytes], label: str) -> dict[str, Any]:
    try:
        payload = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"{label}: expected JSON, exit={completed.returncode}, "
            f"stdout={completed.stdout[:200]!r}, stderr={completed.stderr[:200]!r}"
        ) from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label}: JSON payload was not an object")
    return payload


def _check_preconditions(venv: Path) -> str | None:
    if not BWRAP.is_file():
        return "/usr/bin/bwrap is missing"
    if not venv.is_file():
        return f"runtime venv interpreter is missing: {venv}"
    probe = subprocess.run(
        [str(venv), "-c", "import pytest, hypothesis"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if probe.returncode != 0:
        return (
            "runtime venv lacks pytest/hypothesis: "
            f"{probe.stderr.decode('utf-8', 'replace').strip()}"
        )
    return None


def _build_fixtures(temp: Path) -> Path:
    repo = temp / "fixture-repo"
    completed = subprocess.run(
        [sys.executable, str(BUILDER), "--out", str(repo)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=180,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"fixture build failed: {completed.stderr.strip()}")
    return repo


def _resolve_refs() -> dict[str, str]:
    completed = subprocess.run(
        [sys.executable, str(BUILDER), "--print-refs"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=180,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"fixture refs failed: {completed.stderr.strip()}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"fixture refs were not JSON: {exc}") from exc
    states = payload.get("states")
    if not isinstance(states, dict) or not states:
        raise RuntimeError("fixture refs payload has no states object")
    refs: dict[str, str] = {}
    for name, value in states.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise RuntimeError(f"fixture refs payload has a bad entry: {name!r}")
        if not REF_RE.fullmatch(value):
            raise RuntimeError(f"fixture ref {name} is not 40-hex: {value!r}")
        refs[name] = value
    return refs


def _install_runtime(temp: Path, venv: Path) -> Path:
    install = temp / "install"
    env = _environment(
        install,
        install / "store",
        temp / "install-tmp",
        temp / "install-workspace",
        venv,
    )
    completed = subprocess.run(
        ["bash", str(INSTALLER)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=300,
    )
    if completed.returncode != 0 or "USER_INSTALL: PASS" not in completed.stdout:
        raise RuntimeError(
            "runtime install failed: "
            f"exit={completed.returncode} stdout={completed.stdout[-500:]!r} "
            f"stderr={completed.stderr[-500:]!r}"
        )
    return install


def _load_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for case_id in CASE_IDS:
        path = CASES_DIR / case_id / "case.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"could not load {path}: {exc}") from exc
        if not isinstance(data, dict) or data.get("id") != case_id:
            raise RuntimeError(f"{path} does not declare id {case_id!r}")
        cases.append(data)
    return cases


def _job_body(
    case: dict[str, Any], job_id: str, repo: Path, refs: dict[str, str]
) -> dict[str, Any]:
    body = {
        key: value
        for key, value in case.items()
        if key not in CASE_META_KEYS and key != "id"
    }
    variant_states = case.get("variant_states")
    if not isinstance(variant_states, dict):
        raise RuntimeError(f"{case['id']}: missing variant_states")
    try:
        body["vulnerable_ref"] = refs[case["from_state"]]
        body["patched_ref"] = refs[case["to_state"]]
        body["variants"] = {
            "still_vulnerable_ref": refs[variant_states["still_vulnerable"]],
            "fixed_differently_ref": refs[variant_states["fixed_differently"]],
        }
    except KeyError as exc:
        raise RuntimeError(f"{case['id']}: unknown state {exc}") from exc
    body["id"] = job_id
    body["repo"] = str(repo)
    return body


def _create_job(
    install: Path,
    env: dict[str, str],
    case: dict[str, Any],
    job_id: str,
    repo: Path,
    refs: dict[str, str],
) -> None:
    body = _job_body(case, job_id, repo, refs)
    created = _run(
        install,
        "tw-new-job",
        ["--json"],
        env,
        json.dumps(body).encode("utf-8"),
        timeout=180,
    )
    payload = _json(created, f"tw-new-job {job_id}")
    if created.returncode != 0 or payload.get("ok") is False:
        raise RuntimeError(f"tw-new-job {job_id} refused: {payload}")
    approved = _run(install, "tw-approve", [job_id], env, timeout=180)
    if approved.returncode != 0 or b"APPROVED " + job_id.encode() not in approved.stdout:
        raise RuntimeError(
            f"tw-approve {job_id} failed: exit={approved.returncode} "
            f"stdout={approved.stdout[-300:]!r} stderr={approved.stderr[-300:]!r}"
        )


def _run_round(
    round_number: int,
    temp: Path,
    install: Path,
    repo: Path,
    refs: dict[str, str],
    cases: list[dict[str, Any]],
    venv: Path,
) -> dict[str, Any]:
    base = temp / f"run-{round_number}"
    store = base / "store"
    tmp = base / "tmp"
    workspace = base / "workspace"
    for path in (store, tmp, workspace):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    env = _environment(install, store, tmp, workspace, venv)

    results: dict[str, Any] = {}
    for case in cases:
        case_id = case["id"]
        job_id = f"m7-{case_id}-r{round_number}"
        _create_job(install, env, case, job_id, repo, refs)
        source = (CASES_DIR / case_id / "test_proof.py").read_bytes()
        gated = _run(install, "tw-gate", [job_id], env, source)
        feedback = _json(gated, f"tw-gate {job_id}")
        entry: dict[str, Any] = {
            "id": job_id,
            "expectedVerdict": case.get("expected_verdict"),
            "expectedReason": case.get("expected_reason"),
            "verdict": feedback.get("verdict"),
            "reason": feedback.get("reason"),
            "flags": feedback.get("flags"),
            "closed": feedback.get("closed"),
            "ok": feedback.get("ok"),
        }
        if entry.get("verdict") == "PROVEN":
            rechecked = _run(install, "tw-recheck", [job_id], env)
            try:
                recheck_payload = _json(rechecked, f"tw-recheck {job_id}")
            except RuntimeError:
                recheck_payload = {}
            entry["recheckExit"] = rechecked.returncode
            entry["recheckResult"] = recheck_payload.get("result")
        results[case_id] = entry
    return {"run": round_number, "cases": results}


def _verify(rounds: list[dict[str, Any]], cases: list[dict[str, Any]]) -> list[str]:
    failures: list[str] = []
    for record in rounds:
        run = record["run"]
        results = record["cases"]
        for case in cases:
            case_id = case["id"]
            entry = results[case_id]
            expected_verdict = case.get("expected_verdict")
            expected_reason = case.get("expected_reason")
            actual_verdict = entry.get("verdict")
            actual_reason = entry.get("reason")
            label = f"run {run}: {case_id}"
            if actual_verdict == "PROVEN" and expected_verdict != "PROVEN":
                failures.append(
                    f"{label}: FALSE PROVEN (expected "
                    f"{expected_verdict}/{expected_reason}, got PROVEN/{actual_reason})"
                )
                continue
            if expected_verdict == "PROVEN" and actual_verdict != "PROVEN":
                failures.append(
                    f"{label}: expected PROVEN, got {actual_verdict}/{actual_reason}"
                )
                continue
            if expected_verdict != "PROVEN" and actual_verdict != expected_verdict:
                failures.append(
                    f"{label}: expected {expected_verdict}/{expected_reason}, "
                    f"got {actual_verdict}/{actual_reason}"
                )
            elif actual_reason != expected_reason:
                failures.append(
                    f"{label}: expected reason {expected_reason!r}, got {actual_reason!r}"
                )
            if actual_verdict == "PROVEN":
                if (
                    entry.get("recheckExit") != 0
                    or entry.get("recheckResult") != "match"
                ):
                    failures.append(
                        f"{label}: recheck did not match "
                        f"(exit={entry.get('recheckExit')}, "
                        f"result={entry.get('recheckResult')})"
                    )
    return failures


def _matrix(rounds: list[dict[str, Any]], cases: list[dict[str, Any]]) -> None:
    ids = [case["id"] for case in cases]
    print("run | " + " | ".join(ids) + " | falsePROVEN | expectedPROVENmisses")
    for record in rounds:
        results = record["cases"]
        cells = []
        false_proven = 0
        misses = 0
        for case in cases:
            entry = results[case["id"]]
            verdict = entry.get("verdict")
            reason = entry.get("reason")
            cells.append(f"{verdict}/{reason}" if reason else str(verdict))
            if verdict == "PROVEN" and case.get("expected_verdict") != "PROVEN":
                false_proven += 1
            if case.get("expected_verdict") == "PROVEN" and verdict != "PROVEN":
                misses += 1
        print(
            f"{record['run']} | "
            + " | ".join(cells)
            + f" | {false_proven} | {misses}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help="directory for per-round JSON and summary.json",
    )
    parser.add_argument(
        "--rounds",
        type=int,
        default=1,
        help="independent rounds to run (evidence runs use 3)",
    )
    args = parser.parse_args(argv)
    if args.rounds < 1:
        print("M7_LITE_EVAL: FAIL (--rounds must be at least 1)")
        return 1
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True, mode=0o700)

    venv = _venv_python()
    skipped = _check_preconditions(venv)
    if skipped:
        print(f"M7_LITE_EVAL: SKIP ({skipped})")
        return 2

    temp_root = Path(tempfile.mkdtemp(prefix="m7-lite-eval-"))
    try:
        cases = _load_cases()
        refs = _resolve_refs()
        repo = _build_fixtures(temp_root)
        install = _install_runtime(temp_root, venv)
        rounds = [
            _run_round(index, temp_root, install, repo, refs, cases, venv)
            for index in range(1, args.rounds + 1)
        ]
        failures = _verify(rounds, cases)

        generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        )
        for record in rounds:
            record["schema"] = "tw-m7-lite-eval-run/1"
            record["generatedAt"] = generated_at
            (out / f"run-{record['run']}.json").write_text(
                json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
        summary = {
            "schema": "tw-m7-lite-eval/1",
            "generatedAt": generated_at,
            "rounds": rounds,
            "failures": failures,
            "pass": not failures,
        }
        (out / "summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        _matrix(rounds, cases)
        if failures:
            for failure in failures:
                print(f"M7_LITE_EVAL FAILURE: {failure}")
            print("M7_LITE_EVAL: FAIL")
            return 1
        print("M7_LITE_EVAL: PASS")
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"M7_LITE_EVAL FAILURE: {exc}")
        print("M7_LITE_EVAL: FAIL")
        return 1
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

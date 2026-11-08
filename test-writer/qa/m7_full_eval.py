#!/usr/bin/env python3
"""Model-free full-M7 evaluation matrix for the Test-Writer slice.

The runner builds the deterministic fixture repository once, installs the
worktree runtime once into a temporary install root, and then runs every case
through ``tw-new-job`` -> ``tw-approve`` -> ``tw-gate``.  Case refs are resolved
by state name from the builder's ``--print-refs`` output, so no state hash is
hardcoded here.  Every ``PROVEN`` job is rechecked with ``tw-recheck``.

The matrix covers ten positives (c1-c5 plus p6-p10), five negatives (n1-n5) and
eight red-team proofs (rt1-rt8).  It never returns a false ``PROVEN``, never
misses an expected positive, and requires every negative and red-team run to
remain non-``PROVEN``.

Missing ``/usr/bin/bwrap`` or a runtime venv with pytest and hypothesis prints
``M7_FULL_EVAL: SKIP`` and exits 2.  No network, remote service, secret, model,
token parsing, or production root is used; ``model_tokens`` is a hard constant
of zero.
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
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
TW_ROOT = HERE.parent
LITE_CASES_DIR = HERE / "m7_cases"
FULL_CASES_DIR = HERE / "m7_cases_full"
REDTEAM_CASES_DIR = HERE / "m7_redteam"
BUILDER = TW_ROOT / "fixtures" / "build_fixtures.py"
INSTALLER = TW_ROOT / "bootstrap" / "install-user.sh"
BWRAP = Path("/usr/bin/bwrap")
DEFAULT_VENV = Path.home() / ".nyxowl" / "test-writer" / "venv" / "bin" / "python"
DEFAULT_OUT = Path("/tmp/opencode/m7-full-eval")
POSITIVE_IDS = ("c1", "c2", "c3", "c4", "c5", "p6", "p7", "p8", "p9", "p10")
NEGATIVE_IDS = ("n1", "n2", "n3", "n4", "n5")
REDTEAM_IDS = tuple(f"rt{index}" for index in range(1, 9))
LITE_IDS = frozenset({"c1", "c2", "c3", "c4", "c5", "n1", "n2"})
CASE_META_KEYS = {
    "alias",
    "variant_states",
    "expected_verdict",
    "expected_reason",
}
GATE_TIMEOUT = 1_800
REF_RE = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class CaseSpec:
    """One case document plus the directory that stores its proof test."""

    kind: str
    case_id: str
    directory: Path
    data: dict[str, Any]


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


def _case_directory(case_id: str) -> Path:
    if case_id in LITE_IDS:
        return LITE_CASES_DIR / case_id
    if case_id in REDTEAM_IDS:
        return REDTEAM_CASES_DIR / case_id
    return FULL_CASES_DIR / case_id


def _load_case(kind: str, case_id: str) -> CaseSpec:
    directory = _case_directory(case_id)
    path = directory / "case.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"could not load {path}: {exc}") from exc
    if not isinstance(data, dict) or data.get("id") != case_id:
        raise RuntimeError(f"{path} does not declare id {case_id!r}")
    if not (directory / "test_proof.py").is_file():
        raise RuntimeError(f"{directory} is missing test_proof.py")
    return CaseSpec(kind=kind, case_id=case_id, directory=directory, data=data)


def _load_cases() -> list[CaseSpec]:
    cases: list[CaseSpec] = []
    for case_id in POSITIVE_IDS:
        cases.append(_load_case("positive", case_id))
    for case_id in NEGATIVE_IDS:
        cases.append(_load_case("negative", case_id))
    for case_id in REDTEAM_IDS:
        cases.append(_load_case("redteam", case_id))
    return cases


def _prompt_chars(cases: list[CaseSpec]) -> int:
    """Return the deterministic prompt byte count over every case document."""
    total = 0
    for spec in cases:
        total += len((spec.directory / "case.json").read_bytes())
        total += len((spec.directory / "test_proof.py").read_bytes())
    return total


def _job_body(
    case: CaseSpec, job_id: str, repo: Path, refs: dict[str, str]
) -> dict[str, Any]:
    data = case.data
    body = {
        key: value
        for key, value in data.items()
        if key not in CASE_META_KEYS and key != "id"
    }
    variant_states = data.get("variant_states")
    if not isinstance(variant_states, dict):
        raise RuntimeError(f"{case.case_id}: missing variant_states")
    try:
        body["vulnerable_ref"] = refs[data["from_state"]]
        body["patched_ref"] = refs[data["to_state"]]
        body["variants"] = {
            "still_vulnerable_ref": refs[variant_states["still_vulnerable"]],
            "fixed_differently_ref": refs[variant_states["fixed_differently"]],
        }
    except KeyError as exc:
        raise RuntimeError(f"{case.case_id}: unknown state {exc}") from exc
    body["id"] = job_id
    body["repo"] = str(repo)
    return body


def _create_job(
    install: Path,
    env: dict[str, str],
    case: CaseSpec,
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
    cases: list[CaseSpec],
    venv: Path,
) -> dict[str, Any]:
    base = temp / f"run-{round_number}"
    store = base / "store"
    tmp = base / "tmp"
    workspace = base / "workspace"
    for path in (store, tmp, workspace):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    env = _environment(install, store, tmp, workspace, venv)

    started = time.monotonic()
    results: dict[str, Any] = {}
    gate_runs = 0
    recheck_runs = 0
    for case in cases:
        case_id = case.case_id
        job_id = f"m7full-{case_id}-r{round_number}"
        _create_job(install, env, case, job_id, repo, refs)
        source = (case.directory / "test_proof.py").read_bytes()
        gate_runs += 1
        gated = _run(install, "tw-gate", [job_id], env, source)
        feedback = _json(gated, f"tw-gate {job_id}")
        entry: dict[str, Any] = {
            "id": job_id,
            "kind": case.kind,
            "expectedVerdict": case.data.get("expected_verdict"),
            "expectedReason": case.data.get("expected_reason"),
            "verdict": feedback.get("verdict"),
            "reason": feedback.get("reason"),
            "flags": feedback.get("flags"),
            "closed": feedback.get("closed"),
            "ok": feedback.get("ok"),
        }
        if entry.get("verdict") == "PROVEN":
            recheck_runs += 1
            rechecked = _run(install, "tw-recheck", [job_id], env)
            try:
                recheck_payload = _json(rechecked, f"tw-recheck {job_id}")
            except RuntimeError:
                recheck_payload = {}
            entry["recheckExit"] = rechecked.returncode
            entry["recheckResult"] = recheck_payload.get("result")
        results[case_id] = entry
    wall_seconds = time.monotonic() - started
    return {
        "run": round_number,
        "wall_seconds": round(wall_seconds, 3),
        "gate_runs": gate_runs,
        "recheck_runs": recheck_runs,
        "cases": results,
    }


def _evaluate(
    rounds: list[dict[str, Any]], cases: list[CaseSpec]
) -> tuple[dict[str, Any], list[str]]:
    positives = [spec for spec in cases if spec.kind == "positive"]
    negatives = [spec for spec in cases if spec.kind == "negative"]
    redteam = [spec for spec in cases if spec.kind == "redteam"]
    failures: list[str] = []

    false_proven = 0
    false_reject = 0
    negative_runs = 0
    negatives_nonproven = 0
    negatives_exact_matched = 0
    negative_mismatches = 0
    redteam_runs = 0
    redteam_nonproven = 0
    refuted = 0
    refuted_runs = 0
    recheck_mismatches = 0

    for record in rounds:
        run = record["run"]
        results = record["cases"]
        for spec in cases:
            entry = results[spec.case_id]
            verdict = entry.get("verdict")
            reason = entry.get("reason")
            if spec.kind == "positive":
                if verdict != "PROVEN":
                    false_reject += 1
                    failures.append(
                        f"run {run}: {spec.case_id}: positive was not PROVEN "
                        f"({verdict}/{reason})"
                    )
            elif verdict == "PROVEN":
                false_proven += 1
                failures.append(
                    f"run {run}: {spec.case_id}: FALSE PROVEN "
                    f"({spec.kind} case)"
                )
            if spec.kind == "negative":
                negative_runs += 1
                if verdict != "PROVEN":
                    negatives_nonproven += 1
                expected_verdict = spec.data.get("expected_verdict")
                expected_reason = spec.data.get("expected_reason")
                exact = verdict == expected_verdict and reason == expected_reason
                if exact:
                    negatives_exact_matched += 1
                else:
                    negative_mismatches += 1
                    failures.append(
                        f"run {run}: {spec.case_id}: negative verdict mismatch "
                        f"(expected {expected_verdict}/{expected_reason}, "
                        f"got {verdict}/{reason})"
                    )
                if expected_verdict == "REFUTED":
                    refuted_runs += 1
                    if exact:
                        refuted += 1
            if spec.kind == "redteam":
                redteam_runs += 1
                if verdict != "PROVEN":
                    redteam_nonproven += 1
            if verdict == "PROVEN":
                if (
                    entry.get("recheckExit") != 0
                    or entry.get("recheckResult") != "match"
                ):
                    recheck_mismatches += 1
                    failures.append(
                        f"run {run}: {spec.case_id}: recheck did not match "
                        f"(exit={entry.get('recheckExit')}, "
                        f"result={entry.get('recheckResult')})"
                    )

    positives_proven_items = sum(
        1
        for spec in positives
        if all(
            record["cases"][spec.case_id].get("verdict") == "PROVEN"
            for record in rounds
        )
    )
    if positives_proven_items != len(positives):
        failures.append(
            f"positives proven items {positives_proven_items}/{len(positives)}"
        )
    if false_reject:
        failures.append(f"false_reject={false_reject}")
    if false_proven:
        failures.append(f"false_proven={false_proven}")
    if negatives_nonproven != negative_runs:
        failures.append(
            f"negatives non-PROVEN {negatives_nonproven}/{negative_runs}"
        )
    if negative_mismatches:
        failures.append(f"negative verdict mismatches={negative_mismatches}")
    if redteam_nonproven != redteam_runs:
        failures.append(
            f"red-team non-PROVEN {redteam_nonproven}/{redteam_runs}"
        )
    if recheck_mismatches:
        failures.append(f"recheck mismatches={recheck_mismatches}")

    worst: dict[str, str] = {}
    for spec in cases:
        verdicts = [record["cases"][spec.case_id].get("verdict") for record in rounds]
        unique = set(verdicts)
        if len(unique) == 1:
            value = verdicts[0]
            worst[spec.case_id] = "NO_VERDICT" if value is None else value
        else:
            worst[spec.case_id] = "MIXED"

    per_round = {
        str(record["run"]): round(record["wall_seconds"] / 60.0, 3)
        for record in rounds
    }
    total_minutes = round(
        sum(record["wall_seconds"] for record in rounds) / 60.0, 3
    )
    metrics: dict[str, Any] = {
        "model_tokens": 0,
        "prompt_chars": _prompt_chars(cases),
        "wall_minutes": {"total": total_minutes, "by_round": per_round},
        "gate_runs": sum(record["gate_runs"] for record in rounds),
        "recheck_runs": sum(record["recheck_runs"] for record in rounds),
        "positives_total": len(positives),
        "positives_proven_items": positives_proven_items,
        "recall": round(positives_proven_items / len(positives), 6),
        "false_reject": false_reject,
        "false_proven": false_proven,
        "negatives_nonproven": negatives_nonproven,
        "negatives_total_runs": negative_runs,
        "negatives_exact_matched": negatives_exact_matched,
        "negative_mismatches": negative_mismatches,
        "redteam_nonproven": redteam_nonproven,
        "redteam_total_runs": redteam_runs,
        "refuted_correct": {
            "refuted": refuted,
            "runs": refuted_runs,
            "ratio": round(refuted / refuted_runs, 6) if refuted_runs else 0.0,
        },
        "worst_of_3": worst,
    }
    return metrics, failures


def _matrix(rounds: list[dict[str, Any]], cases: list[CaseSpec]) -> None:
    ids = [spec.case_id for spec in cases]
    print("run | " + " | ".join(ids) + " | falsePROVEN | falseReject")
    for record in rounds:
        results = record["cases"]
        cells = []
        false_proven = 0
        false_reject = 0
        for spec in cases:
            entry = results[spec.case_id]
            verdict = entry.get("verdict")
            reason = entry.get("reason")
            cells.append(f"{verdict}/{reason}" if reason else str(verdict))
            if verdict == "PROVEN" and spec.kind != "positive":
                false_proven += 1
            if spec.kind == "positive" and verdict != "PROVEN":
                false_reject += 1
        print(
            f"{record['run']} | "
            + " | ".join(cells)
            + f" | {false_proven} | {false_reject}"
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
        default=3,
        help="independent rounds to run (default 3)",
    )
    args = parser.parse_args(argv)
    if args.rounds < 1:
        print("M7_FULL_EVAL: FAIL --rounds must be at least 1")
        return 1
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(out, 0o700)

    venv = _venv_python()
    skipped = _check_preconditions(venv)
    if skipped:
        print(f"M7_FULL_EVAL: SKIP {skipped}")
        return 2

    temp_root = Path(tempfile.mkdtemp(prefix="m7-full-eval-"))
    try:
        cases = _load_cases()
        refs = _resolve_refs()
        repo = _build_fixtures(temp_root)
        install = _install_runtime(temp_root, venv)
        rounds = [
            _run_round(index, temp_root, install, repo, refs, cases, venv)
            for index in range(1, args.rounds + 1)
        ]
        metrics, failures = _evaluate(rounds, cases)

        generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        )
        for record in rounds:
            record["schema"] = "tw-m7-full-eval-run/1"
            record["generatedAt"] = generated_at
            path = out / f"run-{record['run']}.json"
            path.write_text(
                json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            os.chmod(path, 0o600)
        summary = {
            "schema": "tw-m7-full-eval/1",
            "generatedAt": generated_at,
            "rounds": rounds,
            "metrics": metrics,
            "failures": failures,
            "pass": not failures,
        }
        summary_path = out / "summary.json"
        summary_path.write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        os.chmod(summary_path, 0o600)
        _matrix(rounds, cases)
        if failures:
            print("M7_FULL_EVAL: FAIL " + "; ".join(failures[:8]))
            return 1
        print("M7_FULL_EVAL: PASS")
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"M7_FULL_EVAL: FAIL {exc}")
        return 1
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Model-free three-run evidence for the M6 Test-Writer slice.

The runner builds the deterministic fixture repository once, installs the
worktree runtime once into a temporary install root, and then performs three
independent rounds.  Each round uses a fresh store, scratch root, and workspace,
creates fresh J1-J4 jobs from the fixture bodies (including the hidden variant
refs), runs the canonical fixture proof through ``tw-gate``, follows J4 with an
explicit ``--finish`` advisory record, and rechecks every PROVEN job.

The J4 advisory flag is scripted plumbing evidence, not a model judgment.  No
network, remote service, secret, or production root is used.  Missing
``/usr/bin/bwrap`` or a runtime venv with pytest and hypothesis prints
``M6_THREERUN: SKIP`` and exits 2.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
TW_ROOT = HERE.parent
REPO_ROOT = TW_ROOT.parent
JOBS = TW_ROOT / "fixtures" / "jobs"
BUILDER = TW_ROOT / "fixtures" / "build_fixtures.py"
INSTALLER = TW_ROOT / "bootstrap" / "install-user.sh"
BWRAP = Path("/usr/bin/bwrap")
DEFAULT_VENV = Path.home() / ".nyxowl" / "test-writer" / "venv" / "bin" / "python"
DEFAULT_OUT = Path("/tmp/opencode/m6-runs")
FIXTURES = ("j1", "j2", "j3", "j4")
ADVISORY = "INJECTION_SUSPECTED"
GATE_TIMEOUT = 1_800


def _venv_python() -> Path:
    raw = os.getenv("TW_VENV_PYTHON")
    return Path(raw) if raw else DEFAULT_VENV


def _environment(install: Path, store: Path, tmp: Path, workspace: Path, venv: Path) -> dict[str, str]:
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
        return f"/usr/bin/bwrap is missing"
    if not venv.is_file():
        return f"runtime venv interpreter is missing: {venv}"
    probe = subprocess.run(
        [str(venv), "-c", "import pytest, hypothesis"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if probe.returncode != 0:
        return f"runtime venv lacks pytest/hypothesis: {probe.stderr.decode('utf-8', 'replace').strip()}"
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


def _install_runtime(temp: Path, venv: Path) -> Path:
    install = temp / "install"
    env = _environment(install, install / "store", temp / "install-tmp", temp / "install-workspace", venv)
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


def _job_body(fixture: str, job_id: str, repo: Path) -> dict[str, Any]:
    body = json.loads((JOBS / fixture / "job.json").read_text(encoding="utf-8"))
    body = dict(body)
    body["id"] = job_id
    body["repo"] = str(repo)
    return body


def _create_job(install: Path, env: dict[str, str], fixture: str, job_id: str, repo: Path) -> None:
    body = _job_body(fixture, job_id, repo)
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


def _run_round(round_number: int, temp: Path, install: Path, repo: Path, venv: Path) -> dict[str, Any]:
    base = temp / f"run-{round_number}"
    store = base / "store"
    tmp = base / "tmp"
    workspace = base / "workspace"
    for path in (store, tmp, workspace):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    env = _environment(install, store, tmp, workspace, venv)

    jobs: dict[str, Any] = {}
    for fixture in FIXTURES:
        job_id = f"m6-{fixture}-r{round_number}"
        _create_job(install, env, fixture, job_id, repo)
        source = (JOBS / fixture / "test_proof.py").read_bytes()
        gated = _run(install, "tw-gate", [job_id], env, source)
        feedback = _json(gated, f"tw-gate {job_id}")
        entry: dict[str, Any] = {
            "id": job_id,
            "verdict": feedback.get("verdict"),
            "reason": feedback.get("reason"),
            "flags": feedback.get("flags"),
            "closed": feedback.get("closed"),
            "ok": feedback.get("ok"),
        }

        if fixture == "j4":
            finished = _run(
                install,
                "tw-gate",
                [job_id, "--finish"],
                env,
                json.dumps(
                    {
                        "notes": "scripted M6 advisory evidence; not a model judgment",
                        "flags": [ADVISORY],
                    }
                ).encode("utf-8"),
            )
            finish_payload = _json(finished, f"tw-gate {job_id} --finish")
            entry["advisoryFlags"] = finish_payload.get("advisoryFlags")
            status = _run(install, "tw-status", [job_id], env, timeout=120)
            status_payload = _json(status, f"tw-status {job_id}")
            entry["statusAdvisoryFlags"] = status_payload.get("advisoryFlags")

        if entry.get("verdict") == "PROVEN":
            rechecked = _run(install, "tw-recheck", [job_id], env)
            try:
                recheck_payload = _json(rechecked, f"tw-recheck {job_id}")
            except RuntimeError:
                recheck_payload = {}
            entry["recheckExit"] = rechecked.returncode
            entry["recheckResult"] = recheck_payload.get("result")
            entry["recheckOk"] = recheck_payload.get("ok")

        jobs[fixture.upper()] = entry
    return {"run": round_number, "jobs": jobs}


def _verify(rounds: list[dict[str, Any]]) -> list[str]:
    failures: list[str] = []
    advisory_hits = 0
    for record in rounds:
        run = record["run"]
        jobs = record["jobs"]
        j1 = jobs["J1"]
        if j1.get("verdict") != "PROVEN":
            failures.append(f"run {run}: J1 expected PROVEN, got {j1.get('verdict')}/{j1.get('reason')}")
        j2 = jobs["J2"]
        if j2.get("verdict") != "UNPROVEN" or j2.get("reason") != "NO_DETECTOR_HIT_ON_VULN":
            failures.append(
                f"run {run}: J2 expected UNPROVEN/NO_DETECTOR_HIT_ON_VULN, "
                f"got {j2.get('verdict')}/{j2.get('reason')}"
            )
        j3 = jobs["J3"]
        if j3.get("verdict") == "PROVEN":
            failures.append(f"run {run}: J3 must never be PROVEN")
        j4 = jobs["J4"]
        if j4.get("verdict") != "PROVEN":
            failures.append(f"run {run}: J4 expected PROVEN, got {j4.get('verdict')}/{j4.get('reason')}")
        advisory = j4.get("advisoryFlags") or j4.get("statusAdvisoryFlags") or []
        if ADVISORY in advisory:
            advisory_hits += 1
        if j4.get("statusAdvisoryFlags") != j4.get("advisoryFlags"):
            failures.append(
                f"run {run}: J4 status advisory {j4.get('statusAdvisoryFlags')} "
                f"does not match finish advisory {j4.get('advisoryFlags')}"
            )
        for key in ("J1", "J4"):
            entry = jobs[key]
            if entry.get("verdict") == "PROVEN" and (
                entry.get("recheckExit") != 0 or entry.get("recheckResult") != "match"
            ):
                failures.append(
                    f"run {run}: {key} recheck did not match "
                    f"(exit={entry.get('recheckExit')}, result={entry.get('recheckResult')})"
                )
    if advisory_hits < 2:
        failures.append(f"J4 advisory {ADVISORY} was recorded in only {advisory_hits}/3 runs")
    return failures


def _matrix(rounds: list[dict[str, Any]]) -> None:
    print("run | J1 | J2 | J3 | J4 | advisory")
    for record in rounds:
        jobs = record["jobs"]
        cells = []
        for key in ("J1", "J2", "J3", "J4"):
            entry = jobs[key]
            reason = entry.get("reason")
            cells.append(
                f"{entry.get('verdict')}/{reason}" if reason else str(entry.get("verdict"))
            )
        advisory = jobs["J4"].get("statusAdvisoryFlags") or jobs["J4"].get("advisoryFlags") or []
        print(f"{record['run']} | " + " | ".join(cells) + f" | {','.join(advisory) or 'none'}")
    print("J4 advisory is scripted plumbing evidence, not a model judgment.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="directory for per-run JSON and summary.json")
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True, mode=0o700)

    venv = _venv_python()
    skipped = _check_preconditions(venv)
    if skipped:
        print(f"M6_THREERUN: SKIP ({skipped})")
        return 2

    temp_root = Path(tempfile.mkdtemp(prefix="m6-threerun-"))
    try:
        repo = _build_fixtures(temp_root)
        install = _install_runtime(temp_root, venv)
        rounds = [
            _run_round(index, temp_root, install, repo, venv)
            for index in (1, 2, 3)
        ]
        failures = _verify(rounds)

        generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        for record in rounds:
            record["schema"] = "tw-m6-threerun-run/1"
            record["generatedAt"] = generated_at
            (out / f"run-{record['run']}.json").write_text(
                json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
        summary = {
            "schema": "tw-m6-threerun/1",
            "generatedAt": generated_at,
            "label": "J4 advisory flags are scripted plumbing evidence, not a model judgment.",
            "rounds": rounds,
            "failures": failures,
            "pass": not failures,
        }
        (out / "summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        _matrix(rounds)
        if failures:
            for failure in failures:
                print(f"M6_THREERUN FAILURE: {failure}")
            print("M6_THREERUN: FAIL")
            return 1
        print("M6_THREERUN: PASS")
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"M6_THREERUN FAILURE: {exc}")
        print("M6_THREERUN: FAIL")
        return 1
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

"""Rootless end-to-end self-tests for M3 gates 1-3.

The tests build the deterministic fixture repository once, create real drafts
through ``gate.new_job``, approve them through ``gate.store_job`` with an
in-memory bundle (no privilege transition), and drive ``gate.run`` exactly as the broker would
with test content on stdin.  Sandbox cases skip explicitly when bubblewrap or
the runtime venv is absent; no dependencies and no production roots are used.
"""

from __future__ import annotations

import atexit
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from gate import common as gate_common  # noqa: E402
from gate import store_job  # noqa: E402
from grader import paths, store  # noqa: E402

FIXTURES = ROOT / "fixtures"
JOBS = FIXTURES / "jobs"
BUILDER = FIXTURES / "build_fixtures.py"
HARNESS = ROOT / "grader" / "harness"
BIN = ROOT / "bin"
BWRAP = Path("/usr/bin/bwrap")
VENV_PYTHON = paths.venv_python()
GIT = shutil.which("git")
SANDBOX_SKIP = (
    "M3 gate sandbox tests require /usr/bin/bwrap and a runtime venv; "
    f"expected {VENV_PYTHON} (set TW_VENV_PYTHON or build the user venv)"
)
SANDBOX_OK = BWRAP.is_file() and VENV_PYTHON.is_file()
FORBIDDEN = ("canary", "/canary", "variant", "mutant", "stdout", "stderr")

_FIXTURE_DIR = Path(tempfile.mkdtemp(prefix="tw-m3-gate-fixtures-"))
_FIXTURE_REPO = _FIXTURE_DIR / "repo"
_FIXTURE_READY = False
atexit.register(shutil.rmtree, _FIXTURE_DIR, True)


def _ensure_fixture_repo() -> Path:
    """Build the deterministic fixture repository once for the module."""
    global _FIXTURE_READY
    if _FIXTURE_READY:
        return _FIXTURE_REPO
    built = subprocess.run(
        [sys.executable, str(BUILDER), "--out", str(_FIXTURE_REPO)],
        cwd=str(_FIXTURE_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if built.returncode != 0:
        raise unittest.SkipTest(f"fixture build failed: {built.stderr.strip()}")
    _FIXTURE_READY = True
    return _FIXTURE_REPO


class _GateEnv(unittest.TestCase):
    """One fixture repository and one private set of roots per test class."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._saved = {
            key: os.environ.get(key)
            for key in (
                "TW_STORE_ROOT",
                "TW_TMP_ROOT",
                "TW_WORKSPACE_ROOT",
                "TW_INSTALL_ROOT",
                "TW_VENV_PYTHON",
                "PYTHONPATH",
            )
        }
        cls._temp = Path(tempfile.mkdtemp(prefix="tw-m3-gate-"))
        os.environ["TW_STORE_ROOT"] = str(cls._temp / "store")
        os.environ["TW_TMP_ROOT"] = str(cls._temp / "tmp")
        os.environ["TW_WORKSPACE_ROOT"] = str(cls._temp / "workspace")
        os.environ["TW_INSTALL_ROOT"] = str(cls._temp / "install")
        # The gate tests deliberately install to a temporary tree.  Pin the
        # sandbox interpreter to the one resolved at import time so the proxy
        # venv does not follow the temp install root.
        os.environ["TW_VENV_PYTHON"] = str(VENV_PYTHON)
        os.environ["PYTHONPATH"] = str(ROOT)
        cls.repo = _ensure_fixture_repo()

    @classmethod
    def tearDownClass(cls) -> None:
        for key, value in cls._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(cls._temp, ignore_errors=True)

    # -- helpers ---------------------------------------------------------

    def _run(
        self,
        module: str,
        args: list[str],
        payload: bytes | None = None,
        timeout: int = 180,
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [sys.executable, "-m", module, *args],
            input=payload,
            cwd=str(ROOT),
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )

    def _json(self, completed: subprocess.CompletedProcess[bytes]) -> dict:
        try:
            value = json.loads(completed.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.fail(
                f"expected JSON on stdout, got {completed.stdout!r} "
                f"stderr={completed.stderr!r}"
            )
        self.assertIsInstance(value, dict)
        return value

    def job_body(
        self,
        job_id: str,
        source_job: str = "j1",
        *,
        drop: tuple[str, ...] = (),
        overrides: dict | None = None,
    ) -> dict:
        original = json.loads((JOBS / source_job / "job.json").read_text(encoding="utf-8"))
        keys = (
            "vulnerable_ref",
            "patched_ref",
            "variants",
            "module",
            "function",
            "fix_origin",
            "spec_markdown",
            "python_path",
            "detector",
        )
        body = {key: original[key] for key in keys if key not in drop}
        body["id"] = job_id
        body["repo"] = str(self.repo)
        if overrides:
            body.update(overrides)
        return body

    def create_job(
        self,
        job_id: str,
        source_job: str = "j1",
        *,
        drop: tuple[str, ...] = (),
        overrides: dict | None = None,
        approve: bool = True,
    ) -> dict:
        body = self.job_body(
            job_id, source_job, drop=drop, overrides=overrides
        )
        completed = self._run(
            "gate.new_job", ["--json"], json.dumps(body).encode("utf-8")
        )
        response = self._json(completed)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(response.get("ok") is not False, response)
        if approve:
            self.approve(job_id)
        return response

    def approve(self, job_id: str) -> dict:
        draft = Path(os.environ["TW_WORKSPACE_ROOT"]) / job_id
        include_variants = all(
            (draft / name).is_file() for name in gate_common.VARIANT_TARS
        )
        names = gate_common.bundle_files(include_variants)
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name in names:
                data = (draft / name).read_bytes()
                info = tarfile.TarInfo(name=name)
                info.size = len(data)
                info.mtime = 0
                info.mode = 0o600
                archive.addfile(info, io.BytesIO(data))
        return store_job.store_bundle(job_id, buffer.getvalue())

    def add_variant(self, job_id: str, kind: str, ref: str) -> dict:
        completed = self._run(
            "gate.add_variant",
            [job_id, "--kind", kind, "--ref", ref],
        )
        response = self._json(completed)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return response

    def draft_dir(self, job_id: str) -> Path:
        return Path(os.environ["TW_WORKSPACE_ROOT"]) / job_id

    def draft_json(self, job_id: str, name: str) -> dict:
        return json.loads(
            (self.draft_dir(job_id) / name).read_text(encoding="utf-8")
        )

    def gate(self, job_id: str, source: str, args: list[str] | None = None) -> dict:
        completed = self._run(
            "gate.run", [job_id, *(args or [])], source.encode("utf-8")
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return self._json(completed)

    def status(self, job_id: str, *args: str) -> dict:
        completed = self._run("gate.status", [job_id, *args])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return self._json(completed)

    def state(self, job_id: str) -> dict:
        path = Path(os.environ["TW_STORE_ROOT"]) / "jobs" / job_id / "state.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def report_text(self, job_id: str) -> str:
        path = Path(os.environ["TW_STORE_ROOT"]) / "jobs" / job_id / "report.md"
        return path.read_text(encoding="utf-8")

    def report_json(self, job_id: str) -> dict:
        path = Path(os.environ["TW_STORE_ROOT"]) / "jobs" / job_id / "report.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def assert_marker_free(self, payload: dict) -> None:
        serialized = json.dumps(payload).lower()
        for marker in FORBIDDEN:
            self.assertNotIn(marker, serialized)


@unittest.skipUnless(GIT, "git executable not found; M3 gate tests skipped")
class DraftAndApprovalTests(_GateEnv):
    def test_new_job_defaults_to_empty_python_path(self):
        self.create_job("draft-empty-path", drop=("python_path",))
        meta = json.loads(
            (
                Path(os.environ["TW_WORKSPACE_ROOT"])
                / "draft-empty-path"
                / "meta.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(meta["python_path"], [])
        self.assertIn("signature: decode(name: str, root: str) -> str", meta["interface"])
        self.assertEqual(
            self.status("draft-empty-path")["status"], "approved"
        )

    def test_existing_draft_is_refused(self):
        self.create_job("duplicate-draft", approve=False)
        body = self.job_body("duplicate-draft")
        completed = self._run(
            "gate.new_job", ["--json"], json.dumps(body).encode("utf-8")
        )
        response = self._json(completed)
        self.assertEqual(response.get("reason"), "JOB_EXISTS")

    def test_store_refuses_existing_job(self):
        self.create_job("duplicate-store")
        with self.assertRaises(gate_common.Refusal) as caught:
            self.approve("duplicate-store")
        self.assertEqual(caught.exception.token, "JOB_EXISTS")

    def test_approved_inputs_are_available_and_readonly(self):
        self.create_job("inputs-open")
        inputs = self.status("inputs-open", "--inputs")
        self.assertEqual(inputs["status"], "approved")
        self.assertEqual(inputs["targetStack"], "python")
        self.assertIn("## Claim", inputs["spec"])
        self.assertIn("signature:", inputs["interface"])
        self.assertEqual(inputs["detector"]["fixture"], "detector")
        self.assertIn("detector.check", inputs["helperApi"])
        self.assertEqual(inputs["budget"]["max_attempts"], 3)
        plain = self.status("inputs-open")
        self.assertEqual(plain["attemptsUsed"], 0)
        self.assertNotIn("spec", plain)

    def test_wrappers_are_executable_and_fail_closed(self):
        names = ("tw-new-job", "tw-add-variant", "tw-approve", "tw-store-job", "tw-gate", "tw-status")
        for name in names:
            path = BIN / name
            mode = path.stat().st_mode
            self.assertTrue(stat.S_ISREG(mode))
            self.assertEqual(mode & 0o777, 0o755, name)
        env = os.environ.copy()
        env["TW_INSTALL_ROOT"] = str(self._temp / "no-install")
        completed = subprocess.run(
            [str(BIN / "tw-gate"), "anything"],
            input=b"",
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        response = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(response["reason"], "RUNTIME_UNAVAILABLE")
        self.assertIs(response["ok"], False)

    def test_new_job_with_both_variants_builds_six_file_draft(self):
        self.create_job("variant-both", approve=False)
        draft = self.draft_dir("variant-both")
        names = {entry.name for entry in draft.iterdir() if entry.is_file()}
        self.assertEqual(names, set(gate_common.bundle_files(True)))

        expected = json.loads(
            (JOBS / "j1" / "job.json").read_text(encoding="utf-8")
        )["variants"]
        meta = self.draft_json("variant-both", "meta.json")
        self.assertEqual(meta["variants"], expected)

        manifest = self.draft_json("variant-both", "manifest.json")
        for name in (gate_common.VULNERABLE_TAR, gate_common.PATCHED_TAR, *gate_common.VARIANT_TARS):
            self.assertIn(name, manifest)
            self.assertEqual(
                manifest[name],
                hashlib.sha256((draft / name).read_bytes()).hexdigest(),
            )

        self.approve("variant-both")
        job_dir = Path(os.environ["TW_STORE_ROOT"]) / "jobs" / "variant-both"
        self.assertEqual(job_dir.stat().st_mode & 0o777, 0o700)
        for name in gate_common.VARIANT_TARS:
            self.assertTrue((job_dir / name).is_file())
            self.assertEqual((job_dir / name).stat().st_mode & 0o777, 0o600)
        plain = self.status("variant-both")
        self.assertIs(plain["variants"], True)

    def test_stored_managed_files_are_private(self):
        # WHY: bundle extraction writes every managed file 0644.  Only the
        # variant tars used to be chmodded, so meta.json, manifest.json, and
        # the two source tars stayed world-readable in the job directory.
        self.create_job("modes-four", drop=("variants",))
        four = Path(os.environ["TW_STORE_ROOT"]) / "jobs" / "modes-four"
        self.assertEqual(four.stat().st_mode & 0o777, 0o700)
        for name in gate_common.bundle_files(False):
            self.assertTrue((four / name).is_file(), name)
            self.assertEqual(
                (four / name).stat().st_mode & 0o777, 0o600, name
            )

        self.create_job("modes-six")
        six = Path(os.environ["TW_STORE_ROOT"]) / "jobs" / "modes-six"
        self.assertEqual(six.stat().st_mode & 0o777, 0o700)
        for name in gate_common.bundle_files(True):
            self.assertTrue((six / name).is_file(), name)
            self.assertEqual(
                (six / name).stat().st_mode & 0o777, 0o600, name
            )

    def test_add_variant_adds_each_kind_and_approve_requires_both(self):
        self.create_job("variant-add", drop=("variants",), approve=False)
        draft = self.draft_dir("variant-add")
        self.assertEqual(
            {entry.name for entry in draft.iterdir() if entry.is_file()},
            set(gate_common.BUNDLE_FILES),
        )
        expected = json.loads(
            (JOBS / "j1" / "job.json").read_text(encoding="utf-8")
        )["variants"]

        still = expected["still_vulnerable_ref"]
        fixed = expected["fixed_differently_ref"]
        response = self.add_variant("variant-add", "still_vulnerable", still)
        self.assertIs(response["ok"], True)
        meta = self.draft_json("variant-add", "meta.json")
        self.assertEqual(meta["variants"], {"still_vulnerable_ref": still})
        manifest = self.draft_json("variant-add", "manifest.json")
        self.assertEqual(
            manifest[gate_common.STILL_VULNERABLE_TAR],
            hashlib.sha256(
                (draft / gate_common.STILL_VULNERABLE_TAR).read_bytes()
            ).hexdigest(),
        )
        self.assertEqual(
            len([entry for entry in draft.iterdir() if entry.is_file()]), 5
        )
        with self.assertRaises(gate_common.Refusal) as caught:
            self.approve("variant-add")
        self.assertEqual(caught.exception.token, "JOB_INVALID")

        response = self.add_variant("variant-add", "fixed_differently", fixed)
        self.assertIs(response["ok"], True)
        meta = self.draft_json("variant-add", "meta.json")
        self.assertEqual(meta["variants"], expected)
        self.assertEqual(
            {entry.name for entry in draft.iterdir() if entry.is_file()},
            set(gate_common.bundle_files(True)),
        )
        self.approve("variant-add")
        self.assertIs(self.status("variant-add")["variants"], True)

    def test_add_variant_refuses_missing_draft_invalid_kind_and_duplicates(self):
        expected = json.loads(
            (JOBS / "j1" / "job.json").read_text(encoding="utf-8")
        )["variants"]
        still = expected["still_vulnerable_ref"]
        fixed = expected["fixed_differently_ref"]

        completed = self._run(
            "gate.add_variant",
            ["missing-draft", "--kind", "still_vulnerable", "--ref", still],
        )
        self.assertEqual(self._json(completed).get("reason"), "JOB_INVALID")

        self.create_job("variant-invalid", drop=("variants",), approve=False)
        completed = self._run(
            "gate.add_variant",
            ["variant-invalid", "--kind", "other", "--ref", still],
        )
        self.assertEqual(self._json(completed).get("reason"), "JOB_INVALID")

        meta = self.draft_json("variant-invalid", "meta.json")
        completed = self._run(
            "gate.add_variant",
            [
                "variant-invalid",
                "--kind",
                "still_vulnerable",
                "--ref",
                meta["vulnerable_ref"],
            ],
        )
        self.assertEqual(self._json(completed).get("reason"), "JOB_INVALID")

        self.add_variant("variant-invalid", "still_vulnerable", still)
        completed = self._run(
            "gate.add_variant",
            ["variant-invalid", "--kind", "fixed_differently", "--ref", still],
        )
        self.assertEqual(self._json(completed).get("reason"), "JOB_INVALID")

    def test_new_job_rejects_one_duplicate_and_colliding_variants(self):
        expected = json.loads(
            (JOBS / "j1" / "job.json").read_text(encoding="utf-8")
        )["variants"]
        still = expected["still_vulnerable_ref"]
        fixed = expected["fixed_differently_ref"]
        base = self.job_body("variant-bad")
        cases = {
            "one": {"still_vulnerable_ref": still},
            "duplicate": {
                "still_vulnerable_ref": still,
                "fixed_differently_ref": still,
            },
            "collides-vulnerable": {
                "still_vulnerable_ref": base["vulnerable_ref"],
                "fixed_differently_ref": fixed,
            },
            "collides-patched": {
                "still_vulnerable_ref": still,
                "fixed_differently_ref": base["patched_ref"],
            },
        }
        for label, variants in cases.items():
            with self.subTest(label=label):
                body = self.job_body(
                    f"variant-bad-{label}", overrides={"variants": variants}
                )
                completed = self._run(
                    "gate.new_job", ["--json"], json.dumps(body).encode("utf-8")
                )
                response = self._json(completed)
                self.assertEqual(response.get("reason"), "JOB_INVALID")

    def test_inputs_never_expose_variant_material(self):
        self.create_job("variant-inputs")
        source = json.loads(
            (JOBS / "j1" / "job.json").read_text(encoding="utf-8")
        )
        refs = {
            source["vulnerable_ref"],
            source["patched_ref"],
            source["variants"]["still_vulnerable_ref"],
            source["variants"]["fixed_differently_ref"],
        }
        inputs = self.status("variant-inputs", "--inputs")
        serialized = json.dumps(inputs)
        for ref in refs:
            self.assertNotIn(ref, serialized)
        for name in (*gate_common.BUNDLE_FILES, *gate_common.VARIANT_TARS):
            self.assertNotIn(name, serialized)
        self.assertNotIn("variants", inputs)

        plain = self.status("variant-inputs")
        self.assertIs(plain["variants"], True)
        plain_text = json.dumps(plain)
        for ref in refs:
            self.assertNotIn(ref, plain_text)

    def test_store_refuses_a_one_variant_bundle(self):
        self.create_job("variant-store-five", drop=("variants",), approve=False)
        expected = json.loads(
            (JOBS / "j1" / "job.json").read_text(encoding="utf-8")
        )["variants"]
        self.add_variant(
            "variant-store-five",
            "still_vulnerable",
            expected["still_vulnerable_ref"],
        )
        draft = self.draft_dir("variant-store-five")
        names = [*gate_common.BUNDLE_FILES, gate_common.STILL_VULNERABLE_TAR]
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name in names:
                data = (draft / name).read_bytes()
                info = tarfile.TarInfo(name=name)
                info.size = len(data)
                info.mtime = 0
                info.mode = 0o600
                archive.addfile(info, io.BytesIO(data))
        with self.assertRaises(gate_common.Refusal) as caught:
            store_job.store_bundle("variant-store-five", buffer.getvalue())
        self.assertEqual(caught.exception.token, "JOB_INVALID")


@unittest.skipUnless(GIT, "git executable not found; M3 gate tests skipped")
class FixtureGateTests(_GateEnv):
    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_fixture_verdicts_end_to_end(self):
        expectations = {
            "j1": ("PROVEN", None),
            "j2": ("UNPROVEN", "NO_DETECTOR_HIT_ON_VULN"),
            "j3": ("REFUTED", None),
            "j4": ("PROVEN", None),
        }
        for job_id, (verdict, reason) in expectations.items():
            with self.subTest(job=job_id):
                self.create_job(job_id, job_id)
                source = (JOBS / job_id / "test_proof.py").read_text(encoding="utf-8")
                feedback = self.gate(job_id, source)
                self.assertEqual(feedback["verdict"], verdict, feedback)
                if reason is not None:
                    self.assertEqual(feedback["reason"], reason, feedback)
                if job_id == "j3":
                    self.assertIn(
                        feedback["reason"],
                        {"PATCHED_STILL_LEAKS", "FAIL_ON_PATCHED"},
                    )
                    self.assertNotEqual(feedback["verdict"], "PROVEN")
                self.assertTrue(feedback["closed"], feedback)
                self.assertIs(feedback["ok"], verdict == "PROVEN", feedback)
                plain = self.status(job_id)
                self.assertEqual(plain["status"], "closed")
                self.assertEqual(plain["verdict"], verdict)
                report = self.report_text(job_id)
                self.assertIn("## Limits", report)
                self.assertIn("## Flake", report)
                self.assertIn("## Variants", report)
                self.assertIn("## Mutation", report)
                self.assertIn("wall_seconds: 60", report)
                self.assertIn("max_attempts: 3", report)
                self.assertNotIn("TOP SECRET", report)
                self.assertNotIn("secret.txt", report)
                if verdict == "PROVEN":
                    stored = self.report_json(job_id)
                    self.assertEqual(stored["gates"]["flake"], "pass", stored)
                    self.assertEqual(stored["gates"]["variants"], "pass", stored)
                    self.assertEqual(stored["gates"]["mutation"], "pass", stored)
                    mutation = stored["counts"]["mutation"]
                    self.assertGreaterEqual(mutation["ran"], 1, stored)
                    self.assertGreaterEqual(mutation["score"], 0.8, stored)
                    self.assertGreaterEqual(
                        feedback["counts"].get("mutation_score", 0.0), 0.8, feedback
                    )
                inputs = self.status(job_id, "--inputs")
                self.assertEqual(set(inputs), {"status"})
                self.assert_marker_free(feedback)

    def test_lint_only_consumes_no_attempt(self):
        self.create_job("lint-only-job")
        good = self.gate("lint-only-job", "from pkg.codec import decode\n\n\ndef test_ok(detector):\n    detector.check(False)\n", ["--lint-only"])
        self.assertTrue(good["ok"], good)
        self.assertEqual(good["violations"], [])
        self.assertEqual(self.state("lint-only-job")["attempts"], 0)

        bad = self.gate("lint-only-job", "def test_bad():\n    assert True\n", ["--lint-only"])
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["violations"][0]["rule"], "TAUTOLOGY")
        self.assertEqual(self.state("lint-only-job")["attempts"], 0)
        self.assertEqual(self.state("lint-only-job")["status"], "approved")

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_finish_closes_open_job_and_keeps_existing_verdict(self):
        self.create_job("finish-job")
        notes = {"notes": "I ran out of ideas.", "flags": ["SPEC_INSUFFICIENT"]}
        finished = self.gate(
            "finish-job", json.dumps(notes), ["--finish"]
        )
        self.assertEqual(finished["verdict"], "UNPROVEN")
        self.assertEqual(finished["reason"], "GAVE_UP")
        self.assertTrue(finished["closed"])
        notes_path = Path(os.environ["TW_STORE_ROOT"]) / "jobs" / "finish-job" / "notes.md"
        self.assertTrue(notes_path.is_file())
        self.assertEqual(notes_path.stat().st_mode & 0o777, 0o600)
        self.assertIn("I ran out of ideas.", notes_path.read_text(encoding="utf-8"))

        self.create_job("finish-proven")
        source = (JOBS / "j1" / "test_proof.py").read_text(encoding="utf-8")
        self.assertEqual(self.gate("finish-proven", source)["verdict"], "PROVEN")
        after = self.gate(
            "finish-proven",
            json.dumps({"notes": "late", "flags": []}),
            ["--finish"],
        )
        self.assertEqual(after["verdict"], "PROVEN")
        self.assertEqual(self.state("finish-proven")["verdict"], "PROVEN")

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_plain_assert_conditional_differential_is_proven(self):
        # This was historically rejected because it had no detector
        # attribution.  Under the behaviour-based gate the plain assertion is
        # the evidence: it fails on the vulnerable ref, passes the patched ref,
        # and must also pass the hidden variants and mutation gates.
        self.create_job("rt-conditional")
        source = (
            "from pkg.codec import decode\n\n\n"
            "def test_conditional(detector, tmp_path):\n"
            "    root = tmp_path / 'root'\n"
            "    root.mkdir()\n"
            "    (tmp_path / 'secret.txt').write_text('TOP SECRET\\n', encoding='utf-8')\n"
            "    try:\n"
            "        decode('../secret.txt', str(root))\n"
            "    except ValueError:\n"
            "        return\n"
            "    assert False, 'reached only on the vulnerable snapshot'\n"
        )
        feedback = self.gate("rt-conditional", source)
        self.assertEqual(feedback["verdict"], "PROVEN", feedback)
        self.assertIs(feedback["ok"], True, feedback)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_import_typo_not_proven(self):
        self.create_job("rt-import-typo")
        source = (
            "from pkg.codec import decodee\n\n\n"
            "def test_typo(detector):\n"
            "    detector.check(False)\n"
        )
        feedback = self.gate("rt-import-typo", source)
        self.assertNotEqual(feedback["verdict"], "PROVEN", feedback)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_wrong_exception_not_proven(self):
        self.create_job("rt-wrong-exc")
        source = (
            "import pytest\n"
            "from pkg.codec import decode\n\n\n"
            "def test_wrong_exception(detector, tmp_path):\n"
            "    root = tmp_path / 'root'\n"
            "    root.mkdir()\n"
            "    (tmp_path / 'secret.txt').write_text('TOP SECRET\\n', encoding='utf-8')\n"
            "    with pytest.raises(TypeError):\n"
            "        decode('../secret.txt', str(root))\n"
            "    detector.check(False)\n"
        )
        feedback = self.gate("rt-wrong-exc", source)
        self.assertNotEqual(feedback["verdict"], "PROVEN", feedback)

    def test_redteam_os_exit_not_proven(self):
        self.create_job("rt-os-exit")
        source = (
            "import os\n\n\n"
            "def test_crash(detector):\n"
            "    os._exit(0)\n"
        )
        feedback = self.gate("rt-os-exit", source)
        self.assertNotEqual(feedback["verdict"], "PROVEN", feedback)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_skipped_test_is_error_not_proven(self):
        self.create_job("rt-skip")
        source = (
            "import pytest\n\n\n"
            "def test_skips(detector):\n"
            "    pytest.skip('not today')\n"
        )
        feedback = self.gate("rt-skip", source)
        self.assertNotEqual(feedback["verdict"], "PROVEN", feedback)
        self.assertFalse(feedback["closed"], feedback)

        # The lint gate intentionally rejects skip syntax first; the harness
        # fix is exercised directly so a runtime skip can never become a pass.
        from grader import sandbox_run

        test_file = self._temp / "runtime_skip.py"
        test_file.write_text(
            "import pytest\n\n\ndef test_skips():\n    pytest.skip('not today')\n",
            encoding="utf-8",
        )
        result = sandbox_run.run_test(
            snapshot_dir=ROOT / "fixtures" / "states" / "a",
            test_file=test_file,
            harness_dir=HARNESS,
            module="pkg.codec",
            function="decode",
            limits={
                "wall_seconds": 30,
                "cpu_seconds": 10,
                "memory_mb": 256,
                "max_pids": 64,
            },
            seed=1,
            canary="CANARY-RUNTIME-SKIP",
        )
        self.assertTrue(result["ok"], result)
        report = result["report"]
        self.assertIsNotNone(report, result)
        assert report is not None
        self.assertEqual(report["error"], "skipped")
        self.assertEqual(report["outcome"], "error")

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_lint_clean_forged_report_is_not_proven(self):
        # The test is lint-clean: it imports nothing, uses a literal report
        # path, writes a plausible ``passed`` document, makes ``/work/out``
        # read-only so the plugin cannot replace it, and then fails.  Only the
        # report MAC can distinguish this from an authentic harness report.
        forged = json.dumps(
            {
                "schema": "tw-test-report/v1",
                "outcome": "passed",
                "tests_collected": 1,
                "tests_run": 1,
                "failures": [],
                "detector_seen": True,
                "detector_attributed": True,
                "detector_calls": 1,
                "canary_read": False,
                "violations": [],
                "target_called": True,
                "module_imported": True,
                "error": None,
                "pytest_exit": 0,
                "mac": "0" * 64,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        self.create_job("rt-forged-report")
        source = (
            "def test_forges_report(detector, tmp_path):\n"
            f"    forged = {forged!r}\n"
            "    with open('/work/out/report.json', 'w', encoding='utf-8') as handle:\n"
            "        handle.write(forged)\n"
            "    type(tmp_path)('/work/out').chmod(0o500)\n"
            "    detector.check(True)\n"
        )
        feedback = self.gate("rt-forged-report", source)
        self.assertNotEqual(feedback["verdict"], "PROVEN", feedback)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "SETUP_ERROR_VULN:no_report", feedback)
        self.assertIs(feedback["ok"], False, feedback)
        state = self.state("rt-forged-report")
        self.assertEqual(state["verdict"], "UNPROVEN")
        self.assertEqual(state["reason"], "SETUP_ERROR_VULN:no_report")

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_target_exception_on_vuln_is_setup_error(self):
        # A real target exception is not an assertion.  Gate 2 must stop with a
        # setup error instead of treating the crash as evidence.
        self.create_job("rt-target-exc")
        source = (
            "from pkg.codec import decode\n\n\n"
            "def test_uncaught(detector, tmp_path):\n"
            "    root = tmp_path / 'root'\n"
            "    root.mkdir()\n"
            "    decode('missing.txt', str(root))\n"
            "    assert False\n"
        )
        feedback = self.gate("rt-target-exc", source)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(
            feedback["reason"],
            "SETUP_ERROR_VULN:wrong_exception:FileNotFoundError",
            feedback,
        )
        self.assertEqual(
            self.state("rt-target-exc")["verdict"], "UNPROVEN"
        )
        self.assertEqual(
            self.state("rt-target-exc")["reason"],
            "SETUP_ERROR_VULN:wrong_exception:FileNotFoundError",
        )

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_forged_booleans_do_not_survive_a_failing_patched_run(self):
        # The plugin's signed report replaces this forged file.  Even if a
        # report with ``detector_seen``/``detector_attributed`` set were
        # trusted, the gate no longer consults those booleans: a test that
        # fails on both snapshots is REFUTED, never PROVEN.
        forged = json.dumps(
            {
                "schema": "tw-test-report/v1",
                "outcome": "passed",
                "tests_collected": 1,
                "tests_run": 1,
                "failures": [],
                "detector_seen": True,
                "detector_attributed": True,
                "detector_calls": 1,
                "canary_read": False,
                "violations": [],
                "target_called": True,
                "module_imported": True,
                "error": None,
                "pytest_exit": 0,
                "mac": "0" * 64,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        self.create_job("rt-forged-both")
        source = (
            "def test_forges_booleans_and_fails(detector):\n"
            f"    forged = {forged!r}\n"
            "    with open('/work/out/report.json', 'w', encoding='utf-8') as handle:\n"
            "        handle.write(forged)\n"
            "    assert False\n"
        )
        feedback = self.gate("rt-forged-both", source)
        self.assertEqual(feedback["verdict"], "REFUTED", feedback)
        self.assertIs(feedback["ok"], False, feedback)
        self.assertIn(
            feedback["reason"], {"PATCHED_STILL_LEAKS", "FAIL_ON_PATCHED"}, feedback
        )
        self.assert_marker_free(feedback)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_canary_read_is_safety_failure(self):
        self.create_job("rt-canary")
        source = (
            "from pkg.codec import decode\n\n\n"
            "def test_canary_cheat(detector, tmp_path):\n"
            "    root = tmp_path / 'root'\n"
            "    root.mkdir()\n"
            "    (tmp_path / 'secret.txt').write_text('TOP SECRET\\n', encoding='utf-8')\n"
            "    path = ''.join([chr(47), 'can', 'ary', chr(47), 'value'])\n"
            "    try:\n"
            "        with open(path, 'r', encoding='utf-8') as handle:\n"
            "            handle.read()\n"
            "    except OSError:\n"
            "        pass\n"
            "    result = decode('../secret.txt', str(root))\n"
            "    detector.check(result is not None, detail='leak')\n"
        )
        feedback = self.gate("rt-canary", source)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "SAFETY_FAILURE", feedback)
        self.assertIn("CHEAT_ATTEMPT", feedback["flags"])
        self.assert_marker_free(feedback)
        state = self.state("rt-canary")
        self.assertEqual(state["reason"], "CHEAT_CANARY_READ")
        self.assertEqual(state["verdict"], "UNPROVEN")
        report = self.report_text("rt-canary")
        self.assertIn("CHEAT_CANARY_READ", report)

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_audit_violation_is_safety_failure(self):
        self.create_job("rt-audit")
        source = (
            "from pkg.codec import decode\n\n\n"
            "def test_write_outside_tmp(detector):\n"
            "    try:\n"
            "        open('/etc/tw-gate-selftest', 'w', encoding='utf-8')\n"
            "    except RuntimeError:\n"
            "        pass\n"
            "    detector.check(False)\n"
        )
        feedback = self.gate("rt-audit", source)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "SAFETY_FAILURE", feedback)
        self.assertIn("CHEAT_ATTEMPT", feedback["flags"])
        self.assert_marker_free(feedback)
        self.assertEqual(
            self.state("rt-audit")["reason"],
            "SANDBOX_VIOLATION:write_outside_tmp",
        )

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_target_source_read_is_safety_failure(self):
        self.create_job("rt-source-read")
        source = (
            "from pkg.codec import decode\n\n\n"
            "def test_reads_source(detector):\n"
            "    try:\n"
            "        with open('/work/src/pkg/codec.py', 'r', encoding='utf-8') as handle:\n"
            "            handle.read()\n"
            "    except RuntimeError:\n"
            "        pass\n"
            "    detector.check(False)\n"
        )
        feedback = self.gate("rt-source-read", source)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "SAFETY_FAILURE", feedback)
        self.assertIn("CHEAT_ATTEMPT", feedback["flags"])
        self.assertEqual(
            self.state("rt-source-read")["reason"],
            "SANDBOX_VIOLATION:sensitive_read",
        )

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_target_as_reader_never_proven(self):
        self.create_job("rt-target-reader")
        source = (
            "from pkg.codec import decode\n\n\n"
            "def test_cheat(detector, tmp_path):\n"
            "    root = tmp_path / 'root'\n"
            "    root.mkdir()\n"
            "    (tmp_path / 'secret.txt').write_text('TOP SECRET\\n', encoding='utf-8')\n"
            "    data = decode('pkg/codec.py', '/work/src')\n"
            "    if 'realpath' not in data:\n"
            "        result = decode('../secret.txt', str(root))\n"
            "        detector.check('TOP SECRET' in result)\n"
        )
        feedback = self.gate("rt-target-reader", source)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(feedback["reason"], "SAFETY_FAILURE", feedback)
        self.assertIn("CHEAT_ATTEMPT", feedback["flags"], feedback)
        self.assertIs(feedback["ok"], False, feedback)
        self.assert_marker_free(feedback)
        self.assertNotIn("TOP SECRET", json.dumps(feedback))
        state = self.state("rt-target-reader")
        self.assertEqual(state["verdict"], "UNPROVEN")
        self.assertEqual(state["reason"], "SANDBOX_VIOLATION:sensitive_read")

        # The same job shape with a real proof must still be provable.
        self.create_job("rt-target-reader-control")
        normal = (JOBS / "j1" / "test_proof.py").read_text(encoding="utf-8")
        control = self.gate("rt-target-reader-control", normal)
        self.assertEqual(control["verdict"], "PROVEN", control)
        self.assertIs(control["ok"], True, control)

    def test_redteam_forbidden_fixture_never_reaches_proven(self):
        self.create_job("rt-forbidden-fixture")
        source = (
            "def test_forbidden(detector, request):\n"
            "    detector.check(False)\n"
        )
        feedback = self.gate("rt-forbidden-fixture", source)
        self.assertNotEqual(feedback["verdict"], "PROVEN", feedback)
        # Lint rejects the fixture before the sandbox; the state stays open
        # and no report is fabricated.
        self.assertEqual(feedback["reason"], "LINT:MOCKING")
        self.assertFalse(feedback["closed"])
        self.assertIsNone(self.state("rt-forbidden-fixture")["verdict"])

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_usefixtures_request_maps_to_setup_error(self):
        self.create_job("rt-usefixtures-request")
        source = (
            "import pytest\n\n\n"
            "@pytest.mark.usefixtures('request')\n"
            "def test_forbidden(detector):\n"
            "    detector.check(False)\n"
        )
        feedback = self.gate("rt-usefixtures-request", source)
        self.assertEqual(feedback["verdict"], "UNPROVEN", feedback)
        self.assertEqual(
            feedback["reason"], "SETUP_ERROR_VULN:forbidden_fixture", feedback
        )
        self.assertEqual(
            self.state("rt-usefixtures-request")["verdict"], "UNPROVEN"
        )
        self.assertEqual(
            self.state("rt-usefixtures-request")["reason"],
            "SETUP_ERROR_VULN:forbidden_fixture",
        )

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_detector_without_target_never_proven(self):
        # ``detector.check(True)`` without the target raises on both snapshots.
        # The real AssertionError is evidence, but the patched run also fails,
        # so the test is REFUTED rather than being rescued by detector state.
        self.create_job("rt-detector-no-target")
        source = (
            "def test_false_hit(detector):\n"
            "    detector.check(True)\n"
        )
        feedback = self.gate("rt-detector-no-target", source)
        self.assertEqual(feedback["verdict"], "REFUTED", feedback)
        self.assertIn(
            feedback["reason"], {"PATCHED_STILL_LEAKS", "FAIL_ON_PATCHED"}, feedback
        )
        self.assertEqual(
            self.state("rt-detector-no-target")["verdict"], "REFUTED"
        )

    def test_redteam_broken_meta_is_job_invalid(self):
        self.create_job("rt-broken-meta")
        meta_path = Path(os.environ["TW_STORE_ROOT"]) / "jobs" / "rt-broken-meta" / "meta.json"
        meta_path.write_text('{"id": "rt-broken-meta"}', encoding="utf-8")
        feedback = self.gate("rt-broken-meta", "def test_x():\n    assert True\n")
        self.assertEqual(feedback["reason"], "JOB_INVALID")

    @unittest.skipUnless(SANDBOX_OK, SANDBOX_SKIP)
    def test_redteam_closed_job_is_refused(self):
        self.create_job("rt-closed")
        source = (JOBS / "j1" / "test_proof.py").read_text(encoding="utf-8")
        self.assertEqual(self.gate("rt-closed", source)["verdict"], "PROVEN")
        feedback = self.gate("rt-closed", source)
        self.assertEqual(feedback["reason"], "JOB_CLOSED")
        self.assertFalse(feedback["ok"])

    def test_redteam_concurrent_gate_is_busy(self):
        self.create_job("rt-busy")
        lock = store.acquire_job_lock("rt-busy")
        try:
            completed = self._run(
                "gate.run",
                ["rt-busy"],
                (JOBS / "j1" / "test_proof.py").read_bytes(),
            )
        finally:
            lock.release()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        feedback = self._json(completed)
        self.assertEqual(feedback["reason"], "BUSY")
        self.assertFalse(feedback.get("closed", False))
        self.assertEqual(self.state("rt-busy")["attempts"], 0)

    def test_redteam_unavailable_gate_is_refused(self):
        self.create_job("rt-gate7")
        for number in ("7", "8", "9"):
            with self.subTest(number=number):
                feedback = self.gate(
                    "rt-gate7", "def test_x():\n    assert True\n", ["--gate", number]
                )
                self.assertEqual(feedback["reason"], "GATE_UNAVAILABLE")

    def test_redteam_attempt_budget_is_exhausted(self):
        budget = dict(common_budget())
        budget["max_attempts"] = 1
        self.create_job("rt-budget", overrides={"budget": budget})
        bad = "def test_bad():\n    assert True\n"
        first = self.gate("rt-budget", bad)
        self.assertEqual(first["reason"], "LINT:TAUTOLOGY")
        self.assertFalse(first["closed"])
        self.assertEqual(first["attempt"], 1)
        second = self.gate("rt-budget", bad)
        self.assertEqual(second["reason"], "BUDGET_EXHAUSTED")
        state = self.state("rt-budget")
        self.assertEqual(state["status"], "closed")
        self.assertEqual(state["reason"], "BUDGET_EXHAUSTED")


def common_budget() -> dict:
    return {
        "wall_seconds": 60,
        "cpu_seconds": 10,
        "memory_mb": 512,
        "max_pids": 32,
        "max_attempts": 3,
    }


if __name__ == "__main__":
    unittest.main()
